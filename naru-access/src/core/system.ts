import type { Database } from 'bun:sqlite'
import { createHash, createHmac, randomBytes, randomInt } from 'node:crypto'
import type { Clock } from './clock.ts'
import { can, ROLES, type Permission, type Role } from './permissions.ts'
import {
  ALERT_CODES,
  bandTypeFromBarcode,
  groupTiming,
  isChild,
  LANES,
  MESSAGES,
  normalizeBarcode,
  type BandType,
  type DecisionCode,
  type GroupClock,
  type GroupTiming,
  type GroupType,
  type LaneId,
} from './rules.ts'
import { DEFAULT_SETTINGS, mergeSettings, type Settings } from './settings.ts'
import { dayBounds, dayType, formatLocal, HOUR, localParts, localToMs, MINUTE } from './time.ts'

export class AppError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message)
  }
}

export interface Actor {
  id: number
  name: string
  role: Role
}

export type ScanSource = 'reader' | 'handheld' | 'override' | 'sim'
export type LaneMode = 'normal' | 'held_open'

export interface Decision {
  lane: LaneId
  barcode: string
  open: boolean
  code: DecisionCode
  message: string
  color: 'green' | 'red'
  at: number
  bandType: BandType | null
  groupId: number | null
  source: ScanSource
  decisionMs: number
}

export interface LaneState {
  lane: LaneId
  mode: LaneMode
  /** True when the gate must stay physically open: fire alarm or a held-open lane. */
  held: boolean
}

export type SystemEvent =
  | { type: 'gate'; lane: LaneId; decision: Decision }
  | { type: 'lane'; lanes: LaneState[]; fire: boolean }
  | { type: 'alert'; decision: Decision }
  | { type: 'changed' }

interface StaffRow {
  id: number
  name: string
  role: Role
  pin_hash: string
  active: number
  created_at: number
}

interface GroupRow {
  id: number
  type: GroupType
  receipt_no: string | null
  table_no: string | null
  party_id: number | null
  package_account_id: number | null
  status: 'active' | 'closed'
  first_scan_at: number | null
  play_end_at: number | null
  extension_minutes: number
  blocks_paid: number
  cleared_at: number | null
  cleared_by: number | null
  created_by: number
  created_at: number
  closed_at: number | null
}

interface BandRow {
  barcode: string
  type: BandType
  status: 'active' | 'closed' | 'void'
  group_id: number
  inside: number
  first_in_at: number | null
  last_scan_at: number | null
  activated_by: number
  activated_at: number
}

interface PartyRow {
  id: number
  group_id: number
  name: string
  room: string
  start_at: number
  end_at: number
  expected_guests: number
  invite_code: string
  host_name: string
  host_phone: string
  created_by: number
  created_at: number
}

interface PackageRow {
  id: number
  name: string
  phone: string
  visits_left: number
  receipt_no: string | null
  expires_at: number | null
  created_by: number
  created_at: number
}

interface ScanRow {
  id: number
  at: number
  lane: LaneId
  barcode: string
  band_type: BandType | null
  group_id: number | null
  result: 'opened' | 'refused'
  code: DecisionCode
  source: ScanSource
  staff_id: number | null
}

const OPEN_CODES = new Set<DecisionCode>(['ok_in', 'ok_out', 'closed_exit', 'fire', 'manual'])
const INVITE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
const SESSION_HOURS = 14

export function normalizePhone(raw: string): string {
  const trimmed = raw.trim()
  const digits = trimmed.replace(/\D/g, '')
  return trimmed.startsWith('+') ? `+${digits}` : digits
}

function text(value: unknown, field: string, { required = true, max = 200 } = {}): string {
  const s = typeof value === 'string' ? value.trim() : value == null ? '' : String(value).trim()
  if (required && !s) throw new AppError(400, 'missing_field', `${field} is required`)
  if (s.length > max) throw new AppError(400, 'too_long', `${field} is too long`)
  return s
}

function reasonText(value: unknown): string {
  const s = text(value, 'Reason', { max: 500 })
  if (s.length < 3) throw new AppError(400, 'reason_required', 'Please give a reason (at least 3 characters)')
  return s
}

function wholeNumber(value: unknown, field: string, min: number, max: number): number {
  const n = typeof value === 'string' ? Number(value) : value
  if (typeof n !== 'number' || !Number.isInteger(n) || n < min || n > max) {
    throw new AppError(400, 'bad_number', `${field} must be a whole number from ${min} to ${max}`)
  }
  return n
}

export class AccessSystem {
  private listeners: ((e: SystemEvent) => void)[] = []
  private cachedSettings: Settings
  private fire: boolean
  private pepper: string

  constructor(
    readonly db: Database,
    readonly clock: Clock,
  ) {
    const row = db.query<{ json: string }, []>('SELECT json FROM settings WHERE id = 1').get()
    if (row) {
      // Merge onto defaults so settings added in later versions get a value.
      this.cachedSettings = mergeSettings(DEFAULT_SETTINGS, JSON.parse(row.json))
    } else {
      this.cachedSettings = structuredClone(DEFAULT_SETTINGS)
      db.query('INSERT INTO settings (id, json, updated_at) VALUES (1, ?, ?)').run(JSON.stringify(this.cachedSettings), clock.now())
    }
    let pepper = db.query<{ value: string }, []>(`SELECT value FROM meta WHERE key = 'pin_pepper'`).get()?.value
    if (!pepper) {
      pepper = randomBytes(32).toString('hex')
      db.query(`INSERT INTO meta (key, value) VALUES ('pin_pepper', ?)`).run(pepper)
    }
    this.pepper = pepper
    this.fire = db.query<{ value: string }, []>(`SELECT value FROM system_state WHERE key = 'fire'`).get()?.value === '1'
    for (const lane of LANES) {
      db.query(`INSERT OR IGNORE INTO lanes (id, mode, updated_at) VALUES (?, 'normal', ?)`).run(lane, clock.now())
    }
  }

  // ---------------------------------------------------------------- events

  onEvent(listener: (e: SystemEvent) => void): () => void {
    this.listeners.push(listener)
    return () => {
      this.listeners = this.listeners.filter(l => l !== listener)
    }
  }

  private emit(e: SystemEvent): void {
    for (const l of this.listeners) {
      try {
        l(e)
      } catch (err) {
        console.error('event listener failed', err)
      }
    }
  }

  // ---------------------------------------------------------------- helpers

  private require(actor: Actor, ...perms: Permission[]): void {
    if (!perms.some(p => can(actor.role, p))) {
      throw new AppError(403, 'forbidden', `${actor.name} (${actor.role}) is not allowed to do this`)
    }
  }

  private tx<T>(fn: () => T): T {
    return this.db.transaction(fn)()
  }

  private audit(actorId: number | null, action: string, details: Record<string, unknown>): void {
    const prev = this.db.query<{ hash: string }, []>('SELECT hash FROM audit_log ORDER BY id DESC LIMIT 1').get()?.hash ?? 'GENESIS'
    const at = this.clock.now()
    const body = JSON.stringify(details)
    const hash = createHash('sha256').update(`${prev}|${at}|${actorId ?? ''}|${action}|${body}`).digest('hex')
    this.db
      .query('INSERT INTO audit_log (at, staff_id, action, details, prev_hash, hash) VALUES (?, ?, ?, ?, ?, ?)')
      .run(at, actorId, action, body, prev, hash)
  }

  private override(actor: Actor, action: string, reason: string, extra: { groupId?: number; lane?: LaneId; barcode?: string; details?: object } = {}): void {
    this.db
      .query('INSERT INTO overrides (at, staff_id, action, reason, group_id, lane, barcode, details) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(this.clock.now(), actor.id, action, reason, extra.groupId ?? null, extra.lane ?? null, extra.barcode ?? null, JSON.stringify(extra.details ?? {}))
    this.audit(actor.id, `override.${action}`, { reason, ...extra })
  }

  /** Recomputes every audit hash. Any edit to the log made outside the app breaks the chain. */
  verifyAuditChain(): { ok: boolean; entries: number; brokenAtId?: number } {
    const rows = this.db
      .query<{ id: number; at: number; staff_id: number | null; action: string; details: string; prev_hash: string; hash: string }, []>(
        'SELECT * FROM audit_log ORDER BY id',
      )
      .all()
    let prev = 'GENESIS'
    for (const r of rows) {
      const expected = createHash('sha256').update(`${prev}|${r.at}|${r.staff_id ?? ''}|${r.action}|${r.details}`).digest('hex')
      if (r.prev_hash !== prev || r.hash !== expected) return { ok: false, entries: rows.length, brokenAtId: r.id }
      prev = r.hash
    }
    return { ok: true, entries: rows.length }
  }

  private getGroup(id: number): GroupRow {
    const g = this.db.query<GroupRow, [number]>('SELECT * FROM visit_groups WHERE id = ?').get(id)
    if (!g) throw new AppError(404, 'not_found', `Group ${id} not found`)
    return g
  }

  private getBand(barcode: string): BandRow | null {
    return this.db.query<BandRow, [string]>('SELECT * FROM bands WHERE barcode = ?').get(barcode)
  }

  private getPartyRow(id: number): PartyRow {
    const p = this.db.query<PartyRow, [number]>('SELECT * FROM parties WHERE id = ?').get(id)
    if (!p) throw new AppError(404, 'not_found', `Party ${id} not found`)
    return p
  }

  private getPackageRow(id: number): PackageRow {
    const p = this.db.query<PackageRow, [number]>('SELECT * FROM package_accounts WHERE id = ?').get(id)
    if (!p) throw new AppError(404, 'not_found', `Package account ${id} not found`)
    return p
  }

  private groupClock(g: GroupRow): GroupClock {
    const party = g.party_id ? this.getPartyRow(g.party_id) : null
    return {
      type: g.type,
      status: g.status,
      firstScanAt: g.first_scan_at,
      playEndAt: g.play_end_at,
      partyStartAt: party?.start_at ?? null,
      extensionMinutes: g.extension_minutes,
      blocksPaid: g.blocks_paid,
      clearedAt: g.cleared_at,
    }
  }

  private timing(g: GroupRow, now = this.clock.now()): GroupTiming {
    return groupTiming(this.groupClock(g), this.cachedSettings, now)
  }

  // ---------------------------------------------------------------- settings

  settings(): Settings {
    return this.cachedSettings
  }

  updateSettings(actor: Actor, patch: unknown): Settings {
    this.require(actor, 'settings.manage')
    let next: Settings
    try {
      next = mergeSettings(this.cachedSettings, patch)
    } catch (err) {
      throw new AppError(400, 'invalid_settings', (err as Error).message)
    }
    const before = this.cachedSettings
    const changes: Record<string, { from: unknown; to: unknown }> = {}
    for (const key of Object.keys(next) as (keyof Settings)[]) {
      if (JSON.stringify(before[key]) !== JSON.stringify(next[key])) changes[key] = { from: before[key], to: next[key] }
    }
    this.tx(() => {
      this.db.query('UPDATE settings SET json = ?, updated_at = ? WHERE id = 1').run(JSON.stringify(next), this.clock.now())
      this.audit(actor.id, 'settings.update', changes)
    })
    this.cachedSettings = next
    this.emit({ type: 'changed' })
    return next
  }

  // ---------------------------------------------------------------- staff & sessions

  private pinHash(pin: string): string {
    return createHmac('sha256', this.pepper).update(pin).digest('hex')
  }

  private validPin(pin: unknown): string {
    if (typeof pin !== 'string' || !/^\d{4,8}$/.test(pin)) throw new AppError(400, 'bad_pin', 'PIN must be 4 to 8 digits')
    return pin
  }

  /** Creates the first owner account if there are no staff yet. Returns the PIN when one was created. */
  ensureOwner(pin?: string): string | null {
    const count = this.db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM staff').get()!.n
    if (count > 0) return null
    const ownerPin = pin ?? String(randomInt(100000, 1000000))
    this.validPin(ownerPin)
    const id = this.db
      .query('INSERT INTO staff (name, role, pin_hash, active, created_at) VALUES (?, ?, ?, 1, ?)')
      .run('Owner', 'owner', this.pinHash(ownerPin), this.clock.now()).lastInsertRowid
    this.audit(null, 'staff.bootstrap', { staffId: Number(id) })
    return ownerPin
  }

  login(pin: unknown): { token: string; staff: Actor } {
    if (typeof pin !== 'string' || !/^\d{4,8}$/.test(pin)) throw new AppError(401, 'bad_pin', 'Wrong PIN')
    const row = this.db.query<StaffRow, [string]>('SELECT * FROM staff WHERE pin_hash = ? AND active = 1').get(this.pinHash(pin))
    if (!row) throw new AppError(401, 'bad_pin', 'Wrong PIN')
    const token = randomBytes(24).toString('hex')
    // Sessions use real time so moving the simulator clock never logs staff out.
    const now = Date.now()
    this.db.query('DELETE FROM sessions WHERE expires_at < ?').run(now)
    this.db.query('INSERT INTO sessions (token, staff_id, created_at, expires_at) VALUES (?, ?, ?, ?)').run(token, row.id, now, now + SESSION_HOURS * HOUR)
    this.audit(row.id, 'staff.login', {})
    return { token, staff: { id: row.id, name: row.name, role: row.role } }
  }

  authenticate(token: string | null | undefined): Actor | null {
    if (!token) return null
    const row = this.db
      .query<StaffRow, [string, number]>(
        'SELECT s.* FROM sessions x JOIN staff s ON s.id = x.staff_id WHERE x.token = ? AND x.expires_at > ? AND s.active = 1',
      )
      .get(token, Date.now())
    return row ? { id: row.id, name: row.name, role: row.role } : null
  }

  logout(token: string): void {
    this.db.query('DELETE FROM sessions WHERE token = ?').run(token)
  }

  listStaff(actor: Actor) {
    this.require(actor, 'staff.manage')
    return this.db
      .query<Omit<StaffRow, 'pin_hash'>, []>('SELECT id, name, role, active, created_at FROM staff ORDER BY active DESC, name')
      .all()
      .map(r => ({ id: r.id, name: r.name, role: r.role, active: r.active === 1, createdAt: r.created_at }))
  }

  createStaff(actor: Actor, input: { name?: unknown; role?: unknown; pin?: unknown }) {
    this.require(actor, 'staff.manage')
    const name = text(input.name, 'Name', { max: 80 })
    const role = input.role as Role
    if (!ROLES.includes(role)) throw new AppError(400, 'bad_role', 'Unknown role')
    if (role === 'owner' && actor.role !== 'owner') throw new AppError(403, 'forbidden', 'Only an owner can create another owner')
    const pin = this.validPin(input.pin)
    if (this.db.query('SELECT 1 FROM staff WHERE pin_hash = ?').get(this.pinHash(pin))) {
      throw new AppError(409, 'pin_taken', 'That PIN is already used by someone else')
    }
    const id = Number(
      this.db
        .query('INSERT INTO staff (name, role, pin_hash, active, created_at) VALUES (?, ?, ?, 1, ?)')
        .run(name, role, this.pinHash(pin), this.clock.now()).lastInsertRowid,
    )
    this.audit(actor.id, 'staff.create', { staffId: id, name, role })
    return { id, name, role, active: true }
  }

  updateStaff(actor: Actor, id: number, input: { name?: unknown; role?: unknown; pin?: unknown; active?: unknown }) {
    this.require(actor, 'staff.manage')
    const row = this.db.query<StaffRow, [number]>('SELECT * FROM staff WHERE id = ?').get(id)
    if (!row) throw new AppError(404, 'not_found', 'Staff member not found')
    if ((row.role === 'owner' || input.role === 'owner') && actor.role !== 'owner') {
      throw new AppError(403, 'forbidden', 'Only an owner can change an owner account')
    }
    const name = input.name === undefined ? row.name : text(input.name, 'Name', { max: 80 })
    const role = input.role === undefined ? row.role : (input.role as Role)
    if (!ROLES.includes(role)) throw new AppError(400, 'bad_role', 'Unknown role')
    const active = input.active === undefined ? row.active === 1 : Boolean(input.active)
    let pinHash = row.pin_hash
    if (input.pin !== undefined && input.pin !== '') {
      pinHash = this.pinHash(this.validPin(input.pin))
      if (this.db.query('SELECT 1 FROM staff WHERE pin_hash = ? AND id != ?').get(pinHash, id)) {
        throw new AppError(409, 'pin_taken', 'That PIN is already used by someone else')
      }
    }
    this.tx(() => {
      this.db.query('UPDATE staff SET name = ?, role = ?, pin_hash = ?, active = ? WHERE id = ?').run(name, role, pinHash, active ? 1 : 0, id)
      const admins = this.db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM staff WHERE active = 1 AND role IN ('manager', 'owner')`).get()!.n
      if (admins === 0) throw new AppError(400, 'last_admin', 'At least one active manager or owner must remain')
      if (!active || pinHash !== row.pin_hash) this.db.query('DELETE FROM sessions WHERE staff_id = ?').run(id)
      this.audit(actor.id, 'staff.update', { staffId: id, name, role, active, pinChanged: pinHash !== row.pin_hash })
    })
    return { id, name, role, active }
  }

  // ---------------------------------------------------------------- capacity

  capacity() {
    const s = this.cachedSettings
    const now = this.clock.now()
    const row = this.db
      .query<{ inside: number | null; pending: number | null }, [number]>(
        `SELECT
           SUM(CASE WHEN b.inside = 1 THEN 1 ELSE 0 END) AS inside,
           SUM(CASE WHEN b.inside = 0 AND b.status = 'active' AND b.first_in_at IS NULL AND g.status = 'active'
                     AND (p.id IS NULL OR p.start_at <= ?) THEN 1 ELSE 0 END) AS pending
         FROM bands b
         JOIN visit_groups g ON g.id = b.group_id
         LEFT JOIN parties p ON p.id = g.party_id`,
      )
      .get(now + 30 * MINUTE)!
    const inside = row.inside ?? 0
    const pending = row.pending ?? 0
    // Capacity counts people inside plus bands activated but not yet through the gate,
    // so a queue of activated guests cannot push the zone over the limit.
    const occupancy = inside + pending
    const warnAt = Math.ceil((s.capacity * s.capacityWarnPercent) / 100)
    return {
      inside,
      pending,
      occupancy,
      capacity: s.capacity,
      warnAt,
      percent: Math.round((occupancy / s.capacity) * 100),
      warn: occupancy >= warnAt,
      full: occupancy >= s.capacity,
    }
  }

  // ---------------------------------------------------------------- walk-in groups & bands

  createGroup(actor: Actor, input: { receiptNo?: unknown; tableNo?: unknown; packageAccountId?: unknown; packageKids?: unknown }) {
    this.require(actor, 'walkin.activate')
    const tableNo = text(input.tableNo, 'Table number', { required: false, max: 20 }) || null
    const usePackage = input.packageAccountId !== undefined && input.packageAccountId !== null && input.packageAccountId !== ''
    let receiptNo = text(input.receiptNo, 'StoreHub receipt number', { required: !usePackage, max: 40 }) || null
    const group = this.tx(() => {
      const id = Number(
        this.db
          .query(`INSERT INTO visit_groups (type, receipt_no, table_no, created_by, created_at) VALUES ('walkin', ?, ?, ?, ?)`)
          .run(receiptNo, tableNo, actor.id, this.clock.now()).lastInsertRowid,
      )
      if (usePackage) {
        const accountId = wholeNumber(input.packageAccountId, 'Package account', 1, Number.MAX_SAFE_INTEGER)
        const kids = wholeNumber(input.packageKids, 'Number of kids', 1, 50)
        this.deductInTx(actor, accountId, kids, id)
        const account = this.getPackageRow(accountId)
        receiptNo ??= `PKG-${account.id}${account.receipt_no ? ` / ${account.receipt_no}` : ''}`
        this.db.query('UPDATE visit_groups SET package_account_id = ?, receipt_no = ? WHERE id = ?').run(accountId, receiptNo, id)
      }
      this.audit(actor.id, 'group.create', { groupId: id, receiptNo, tableNo, packageAccountId: usePackage ? input.packageAccountId : null })
      return this.groupSummary(this.getGroup(id))
    })
    this.emit({ type: 'changed' })
    return group
  }

  addBand(actor: Actor, groupId: number, rawBarcode: unknown, requestedType?: unknown) {
    const result = this.tx(() => {
      const group = this.getGroup(groupId)
      this.require(actor, group.type === 'party' ? 'party.checkin' : 'walkin.activate')
      if (group.status !== 'active') throw new AppError(409, 'group_closed', 'This group is closed')
      const barcode = normalizeBarcode(text(rawBarcode, 'Band barcode', { max: 64 }))
      const prefixType = bandTypeFromBarcode(barcode, this.cachedSettings.bandPrefixes)
      if (!prefixType) throw new AppError(400, 'unknown_band', `${barcode} is not a Naru band barcode`)
      let type: BandType = prefixType
      if (requestedType !== undefined && requestedType !== null && requestedType !== '' && requestedType !== prefixType) {
        if (requestedType !== 'kid' && requestedType !== 'under2') throw new AppError(400, 'bad_type', 'Unknown band type')
        if (prefixType === 'adult') throw new AppError(400, 'bad_type', 'An adult band cannot be tagged as a child')
        type = requestedType
      }
      if (this.getBand(barcode)) throw new AppError(409, 'band_used', `Band ${barcode} has already been used`)
      const cap = this.capacity()
      if (cap.full) throw new AppError(409, 'capacity_full', `Paid zone is full (${cap.occupancy}/${cap.capacity}). No new bands can be activated.`)
      this.db
        .query('INSERT INTO bands (barcode, type, status, group_id, inside, activated_by, activated_at) VALUES (?, ?, ?, ?, 0, ?, ?)')
        .run(barcode, type, 'active', groupId, actor.id, this.clock.now())
      this.audit(actor.id, 'band.activate', { barcode, type, groupId })
      return { band: this.bandView(this.getBand(barcode)!), capacity: this.capacity() }
    })
    this.emit({ type: 'changed' })
    return result
  }

  voidBand(actor: Actor, rawBarcode: unknown, reason: unknown) {
    this.require(actor, 'walkin.activate', 'party.checkin', 'group.override')
    const why = reasonText(reason)
    const barcode = normalizeBarcode(text(rawBarcode, 'Band barcode'))
    this.tx(() => {
      const band = this.getBand(barcode)
      if (!band) throw new AppError(404, 'not_found', `Band ${barcode} not found`)
      if (band.status !== 'active') throw new AppError(409, 'band_inactive', 'Band is already closed')
      this.db.query(`UPDATE bands SET status = 'void' WHERE barcode = ?`).run(barcode)
      this.override(actor, 'void_band', why, { groupId: band.group_id, barcode })
    })
    this.emit({ type: 'changed' })
  }

  // ---------------------------------------------------------------- gate

  fireActive(): boolean {
    return this.fire
  }

  laneStates(): LaneState[] {
    return this.db
      .query<{ id: LaneId; mode: LaneMode }, []>('SELECT id, mode FROM lanes ORDER BY id')
      .all()
      .map(r => ({ lane: r.id, mode: r.mode, held: this.fire || r.mode === 'held_open' }))
  }

  private assertLane(lane: string): asserts lane is LaneId {
    if (!LANES.includes(lane as LaneId)) throw new AppError(404, 'bad_lane', `Unknown lane ${lane}`)
  }

  private adultOutRecently(groupId: number, now: number): boolean {
    const since = now - this.cachedSettings.kidExitWindowSeconds * 1000
    return !!this.db
      .query(
        `SELECT 1 FROM scans WHERE group_id = ? AND lane = 'out' AND result = 'opened' AND band_type = 'adult' AND at >= ? AND at <= ? LIMIT 1`,
      )
      .get(groupId, since, now)
  }

  private evaluate(lane: LaneId, band: BandRow | null, group: GroupRow | null, now: number): DecisionCode {
    const s = this.cachedSettings
    // Fire alarm overrides every rule.
    if (this.fire) return 'fire'
    if (!band || !group) return 'not_active'
    if (band.status !== 'active' || group.status !== 'active') {
      // Never trap anyone: a band closed while its wearer is inside can always leave.
      return lane === 'out' && band.inside ? 'closed_exit' : 'not_active'
    }
    const t = this.timing(group, now)
    if (lane === 'in') {
      if (s.antiPassback && band.inside) return 'already_inside'
      if (group.type === 'party') {
        const party = this.getPartyRow(group.party_id!)
        if (now < party.start_at - s.partyEarlyEntryMinutes * MINUTE) return 'party_not_started'
        if (t.effectiveEnd !== null && now > t.effectiveEnd) return 'party_ended'
      } else if (t.effectiveEnd !== null && now > t.effectiveEnd) {
        return 'play_ended'
      }
      return 'ok_in'
    }
    if (t.exitLocked) return 'see_host'
    if (isChild(band.type) && !this.adultOutRecently(group.id, now)) return 'adult_first'
    return 'ok_out'
  }

  private applyPassage(lane: LaneId, band: BandRow, now: number): void {
    if (lane === 'in') {
      this.db.query('UPDATE bands SET inside = 1, last_scan_at = ?, first_in_at = COALESCE(first_in_at, ?) WHERE barcode = ?').run(now, now, band.barcode)
    } else {
      this.db.query('UPDATE bands SET inside = 0, last_scan_at = ? WHERE barcode = ?').run(now, band.barcode)
    }
    const group = this.getGroup(band.group_id)
    if (band.status !== 'active' || group.status !== 'active') return
    if (lane === 'in') {
      if (group.first_scan_at === null) {
        // The group's timer starts at its first gate scan, not at activation.
        this.db
          .query('UPDATE visit_groups SET first_scan_at = ?, play_end_at = COALESCE(play_end_at, ?) WHERE id = ?')
          .run(now, now + this.cachedSettings.sessionMinutes * MINUTE, group.id)
      }
      return
    }
    // Everyone is out and play time is over: close the group so its bands stop working.
    const t = this.timing(group, now)
    const insideCount = this.db.query<{ n: number }, [number]>('SELECT COUNT(*) AS n FROM bands WHERE group_id = ? AND inside = 1').get(group.id)!.n
    if (insideCount === 0 && t.effectiveEnd !== null && now > t.effectiveEnd) this.closeGroupInTx(group.id, now)
  }

  private closeGroupInTx(groupId: number, now: number): void {
    this.db.query(`UPDATE visit_groups SET status = 'closed', closed_at = ? WHERE id = ? AND status = 'active'`).run(now, groupId)
    this.db.query(`UPDATE bands SET status = 'closed' WHERE group_id = ? AND status = 'active'`).run(groupId)
  }

  /** The gate decision. Called by lane readers, the handheld backup scanner and the simulator. */
  scan(lane: string, rawBarcode: unknown, source: ScanSource = 'reader', actor?: Actor): Decision {
    const startedAt = performance.now()
    this.assertLane(lane)
    if (source === 'handheld') {
      if (!actor) throw new AppError(401, 'login_required', 'Handheld scans need a staff login')
      this.require(actor, 'gate.override')
    }
    const barcode = normalizeBarcode(text(rawBarcode, 'Band barcode', { max: 64 }))
    const decision = this.tx(() => {
      const now = this.clock.now()
      const band = this.getBand(barcode)
      const group = band ? this.getGroup(band.group_id) : null
      const code = this.evaluate(lane, band, group, now)
      const open = OPEN_CODES.has(code)
      if (open && band) this.applyPassage(lane, band, now)
      this.db
        .query('INSERT INTO scans (at, lane, barcode, band_type, group_id, result, code, source, staff_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(now, lane, barcode, band?.type ?? null, band?.group_id ?? null, open ? 'opened' : 'refused', code, source, actor?.id ?? null)
      const d: Decision = {
        lane,
        barcode,
        open,
        code,
        message: MESSAGES[code],
        color: open ? 'green' : 'red',
        at: now,
        bandType: band?.type ?? null,
        groupId: band?.group_id ?? null,
        source,
        decisionMs: 0,
      }
      return d
    })
    decision.decisionMs = performance.now() - startedAt
    this.emit({ type: 'gate', lane, decision })
    if (ALERT_CODES.includes(decision.code)) this.emit({ type: 'alert', decision })
    this.emit({ type: 'changed' })
    return decision
  }

  manualOpen(actor: Actor, lane: string, reason: unknown): Decision {
    this.require(actor, 'gate.override')
    this.assertLane(lane)
    const why = reasonText(reason)
    this.tx(() => this.override(actor, 'manual_open', why, { lane }))
    const decision: Decision = {
      lane,
      barcode: '',
      open: true,
      code: 'manual',
      message: MESSAGES.manual,
      color: 'green',
      at: this.clock.now(),
      bandType: null,
      groupId: null,
      source: 'override',
      decisionMs: 0,
    }
    this.emit({ type: 'gate', lane, decision })
    this.emit({ type: 'changed' })
    return decision
  }

  /** Lets one specific band through a lane, e.g. a kid whose adult already left, and records the passage. */
  releaseBand(actor: Actor, rawBarcode: unknown, lane: string, reason: unknown): Decision {
    this.require(actor, 'gate.override')
    this.assertLane(lane)
    const why = reasonText(reason)
    const barcode = normalizeBarcode(text(rawBarcode, 'Band barcode'))
    const decision = this.tx(() => {
      const band = this.getBand(barcode)
      if (!band) throw new AppError(404, 'not_found', `Band ${barcode} not found`)
      const now = this.clock.now()
      this.applyPassage(lane, band, now)
      this.db
        .query(`INSERT INTO scans (at, lane, barcode, band_type, group_id, result, code, source, staff_id) VALUES (?, ?, ?, ?, ?, 'opened', 'manual', 'override', ?)`)
        .run(now, lane, barcode, band.type, band.group_id, actor.id)
      this.override(actor, 'release_band', why, { groupId: band.group_id, lane, barcode })
      const d: Decision = {
        lane,
        barcode,
        open: true,
        code: 'manual',
        message: MESSAGES.manual,
        color: 'green',
        at: now,
        bandType: band.type,
        groupId: band.group_id,
        source: 'override',
        decisionMs: 0,
      }
      return d
    })
    this.emit({ type: 'gate', lane, decision })
    this.emit({ type: 'changed' })
    return decision
  }

  setLaneMode(actor: Actor, lane: string, mode: unknown, reason: unknown): LaneState[] {
    this.require(actor, 'gate.override')
    this.assertLane(lane)
    if (mode !== 'normal' && mode !== 'held_open') throw new AppError(400, 'bad_mode', 'Mode must be normal or held_open')
    const why = reasonText(reason)
    this.tx(() => {
      this.db.query('UPDATE lanes SET mode = ?, updated_at = ? WHERE id = ?').run(mode, this.clock.now(), lane)
      this.override(actor, `lane_${mode}`, why, { lane })
    })
    const lanes = this.laneStates()
    this.emit({ type: 'lane', lanes, fire: this.fire })
    this.emit({ type: 'changed' })
    return lanes
  }

  /**
   * Called by the lane controller when it senses the fire panel signal. The gates are
   * opened by the hard-wired fire input; this only tells the software so it can show it.
   */
  setFireAlarm(active: boolean, source: string, actor?: Actor): void {
    if (actor) this.require(actor, 'gate.override')
    if (active === this.fire) return
    this.fire = active
    this.tx(() => {
      this.db.query(`INSERT INTO system_state (key, value) VALUES ('fire', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(active ? '1' : '0')
      this.audit(actor?.id ?? null, active ? 'fire.on' : 'fire.off', { source })
    })
    this.emit({ type: 'lane', lanes: this.laneStates(), fire: active })
    this.emit({ type: 'changed' })
  }

  // ---------------------------------------------------------------- group overrides

  /** Records overtime as paid in StoreHub and reopens the exit for the group. */
  clearGroup(actor: Actor, groupId: number, input: { reason?: unknown; receiptNo?: unknown }) {
    this.require(actor, 'group.override')
    const why = reasonText(input.reason)
    const result = this.tx(() => {
      const group = this.getGroup(groupId)
      const now = this.clock.now()
      const t = this.timing(group, now)
      const kids = this.chargeableKids(groupId)
      const blocks = t.blocksOwed
      const amount = blocks * kids * this.cachedSettings.overtimeBlockPrice
      const receiptNo = text(input.receiptNo, 'StoreHub receipt number for the overtime', { required: amount > 0, max: 40 }) || null
      this.db
        .query('UPDATE visit_groups SET blocks_paid = ?, cleared_at = ?, cleared_by = ? WHERE id = ?')
        .run(Math.max(group.blocks_paid, t.blocksDue), now, actor.id, groupId)
      if (blocks > 0) {
        this.db
          .query('INSERT INTO overtime_payments (group_id, at, blocks, kids, amount, receipt_no, staff_id) VALUES (?, ?, ?, ?, ?, ?, ?)')
          .run(groupId, now, blocks, kids, amount, receiptNo, actor.id)
      }
      this.override(actor, 'clear_group', why, { groupId, details: { blocks, kids, amount, receiptNo } })
      return { blocks, kids, amount, receiptNo }
    })
    this.emit({ type: 'changed' })
    return result
  }

  extendGroup(actor: Actor, groupId: number, minutes: unknown, reason: unknown) {
    this.require(actor, 'group.override')
    const mins = wholeNumber(minutes, 'Minutes', 1, 600)
    const why = reasonText(reason)
    this.tx(() => {
      const group = this.getGroup(groupId)
      if (group.status !== 'active') throw new AppError(409, 'group_closed', 'This group is closed')
      this.db.query('UPDATE visit_groups SET extension_minutes = extension_minutes + ? WHERE id = ?').run(mins, groupId)
      this.override(actor, 'extend_time', why, { groupId, details: { minutes: mins } })
    })
    this.emit({ type: 'changed' })
    return this.groupSummary(this.getGroup(groupId))
  }

  closeGroup(actor: Actor, groupId: number, reason: unknown) {
    this.require(actor, 'group.override')
    const why = reasonText(reason)
    this.tx(() => {
      this.getGroup(groupId)
      this.closeGroupInTx(groupId, this.clock.now())
      this.override(actor, 'close_group', why, { groupId })
    })
    this.emit({ type: 'changed' })
  }

  private chargeableKids(groupId: number): number {
    const types = this.cachedSettings.overtimeChargesUnder2 ? `('kid', 'under2')` : `('kid')`
    return this.db.query<{ n: number }, [number]>(`SELECT COUNT(*) AS n FROM bands WHERE group_id = ? AND inside = 1 AND type IN ${types}`).get(groupId)!.n
  }

  // ---------------------------------------------------------------- parties

  private uniqueInviteCode(): string {
    for (;;) {
      let code = ''
      for (let i = 0; i < 6; i++) code += INVITE_ALPHABET[randomInt(INVITE_ALPHABET.length)]
      if (!this.db.query('SELECT 1 FROM parties WHERE invite_code = ?').get(code)) return code
    }
  }

  private partyTimes(input: { date?: unknown; startTime?: unknown; endTime?: unknown }): [number, number] {
    const tz = this.cachedSettings.timeZone
    let start: number
    let end: number
    try {
      start = localToMs(text(input.date, 'Date'), text(input.startTime, 'Start time'), tz)
      end = input.endTime ? localToMs(String(input.date), String(input.endTime), tz) : start + this.cachedSettings.partyBlockMinutes * MINUTE
    } catch (err) {
      if (err instanceof AppError) throw err
      throw new AppError(400, 'bad_time', 'Date must be YYYY-MM-DD and times HH:MM')
    }
    if (end <= start) throw new AppError(400, 'bad_time', 'Party must end after it starts')
    return [start, end]
  }

  private assertRoomFree(room: string, start: number, end: number, exceptPartyId: number | null): void {
    const clash = this.db
      .query<PartyRow, [string, number, number, number]>('SELECT * FROM parties WHERE room = ? AND start_at < ? AND end_at > ? AND id != ?')
      .get(room, end, start, exceptPartyId ?? -1)
    if (clash) throw new AppError(409, 'room_busy', `${room} is already booked for "${clash.name}" at that time`)
  }

  createParty(actor: Actor, input: Record<string, unknown>) {
    this.require(actor, 'party.manage')
    const name = text(input.name, 'Party name', { max: 120 })
    const room = text(input.room, 'Room', { max: 60 })
    const expected = wholeNumber(input.expectedGuests, 'Expected guests', 1, 500)
    const hostName = text(input.hostName, 'Host name', { max: 80 })
    const hostPhone = normalizePhone(text(input.hostPhone, 'Host phone', { max: 30 }))
    const receiptNo = text(input.receiptNo, 'Receipt number', { required: false, max: 40 }) || null
    const [start, end] = this.partyTimes(input)
    const id = this.tx(() => {
      this.assertRoomFree(room, start, end, null)
      const now = this.clock.now()
      const groupId = Number(
        this.db
          .query(`INSERT INTO visit_groups (type, receipt_no, play_end_at, created_by, created_at) VALUES ('party', ?, ?, ?, ?)`)
          .run(receiptNo, end, actor.id, now).lastInsertRowid,
      )
      const partyId = Number(
        this.db
          .query(
            `INSERT INTO parties (group_id, name, room, start_at, end_at, expected_guests, invite_code, host_name, host_phone, created_by, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(groupId, name, room, start, end, expected, this.uniqueInviteCode(), hostName, hostPhone, actor.id, now).lastInsertRowid,
      )
      this.db.query('UPDATE visit_groups SET party_id = ? WHERE id = ?').run(partyId, groupId)
      this.audit(actor.id, 'party.create', { partyId, groupId, name, room, start, end, expected })
      return partyId
    })
    this.emit({ type: 'changed' })
    return this.partyView(this.getPartyRow(id))
  }

  updateParty(actor: Actor, partyId: number, input: Record<string, unknown>) {
    this.require(actor, 'party.manage')
    const party = this.getPartyRow(partyId)
    const name = input.name === undefined ? party.name : text(input.name, 'Party name', { max: 120 })
    const room = input.room === undefined ? party.room : text(input.room, 'Room', { max: 60 })
    const expected = input.expectedGuests === undefined ? party.expected_guests : wholeNumber(input.expectedGuests, 'Expected guests', 1, 500)
    const hostName = input.hostName === undefined ? party.host_name : text(input.hostName, 'Host name', { max: 80 })
    const hostPhone = input.hostPhone === undefined ? party.host_phone : normalizePhone(text(input.hostPhone, 'Host phone', { max: 30 }))
    const [start, end] = input.date === undefined ? [party.start_at, party.end_at] : this.partyTimes(input)
    this.tx(() => {
      this.assertRoomFree(room, start, end, partyId)
      this.db
        .query('UPDATE parties SET name = ?, room = ?, start_at = ?, end_at = ?, expected_guests = ?, host_name = ?, host_phone = ? WHERE id = ?')
        .run(name, room, start, end, expected, hostName, hostPhone, partyId)
      this.db.query('UPDATE visit_groups SET play_end_at = ? WHERE id = ?').run(end, party.group_id)
      this.audit(actor.id, 'party.update', { partyId, name, room, start, end, expected })
    })
    this.emit({ type: 'changed' })
    return this.partyView(this.getPartyRow(partyId))
  }

  listParties(actor: Actor, date: unknown) {
    this.require(actor, 'party.checkin', 'party.manage', 'dashboard.view')
    const tz = this.cachedSettings.timeZone
    const day = typeof date === 'string' && date ? date : localParts(this.clock.now(), tz).date
    const [from, to] = dayBounds(day, tz)
    return this.db
      .query<PartyRow, [number, number]>('SELECT * FROM parties WHERE start_at < ? AND end_at > ? ORDER BY start_at')
      .all(to, from)
      .map(p => this.partyView(p))
  }

  /** Accepts a typed code or a scanned QR (which may be a link ending in the code). */
  findPartyByCode(actor: Actor, raw: unknown) {
    this.require(actor, 'party.checkin', 'party.manage')
    const input = text(raw, 'Invite code', { max: 300 })
    const code = (input.split(/[/=?#]/).filter(Boolean).pop() ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '')
    const party = this.db.query<PartyRow, [string]>('SELECT * FROM parties WHERE invite_code = ?').get(code)
    if (!party) throw new AppError(404, 'not_found', `No party with invite code ${code}`)
    return this.partyView(party)
  }

  getParty(actor: Actor, partyId: number) {
    this.require(actor, 'party.checkin', 'party.manage', 'dashboard.view')
    return this.partyView(this.getPartyRow(partyId))
  }

  private partyView(p: PartyRow) {
    const counts = this.db
      .query<{ type: BandType; inside: number; n: number }, [number]>(
        `SELECT type, inside, COUNT(*) AS n FROM bands WHERE group_id = ? AND status != 'void' GROUP BY type, inside`,
      )
      .all(p.group_id)
    const checkedIn = { adult: 0, kid: 0, under2: 0, total: 0 }
    let inside = 0
    for (const c of counts) {
      checkedIn[c.type] += c.n
      checkedIn.total += c.n
      if (c.inside) inside += c.n
    }
    const now = this.clock.now()
    return {
      id: p.id,
      groupId: p.group_id,
      name: p.name,
      room: p.room,
      startAt: p.start_at,
      endAt: p.end_at,
      expectedGuests: p.expected_guests,
      inviteCode: p.invite_code,
      hostName: p.host_name,
      hostPhone: p.host_phone,
      checkedIn,
      inside,
      running: now >= p.start_at && now <= p.end_at,
    }
  }

  // ---------------------------------------------------------------- packages

  createPackage(actor: Actor, input: { name?: unknown; phone?: unknown; receiptNo?: unknown }) {
    this.require(actor, 'package.use')
    const name = text(input.name, 'Name', { max: 80 })
    const phone = normalizePhone(text(input.phone, 'Phone', { max: 30 }))
    if (phone.replace(/\D/g, '').length < 7) throw new AppError(400, 'bad_phone', 'Phone number looks too short')
    const receiptNo = text(input.receiptNo, 'StoreHub receipt number', { max: 40 })
    const s = this.cachedSettings
    const now = this.clock.now()
    let expiresAt: number | null = null
    if (s.packageExpiryMonths > 0) {
      const d = new Date(now)
      d.setUTCMonth(d.getUTCMonth() + s.packageExpiryMonths)
      expiresAt = d.getTime()
    }
    const id = this.tx(() => {
      const id = Number(
        this.db
          .query('INSERT INTO package_accounts (name, phone, visits_left, receipt_no, expires_at, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
          .run(name, phone, s.packageVisits, receiptNo, expiresAt, actor.id, now).lastInsertRowid,
      )
      this.db
        .query(`INSERT INTO package_ledger (account_id, at, delta, kind, receipt_no, staff_id) VALUES (?, ?, ?, 'purchase', ?, ?)`)
        .run(id, now, s.packageVisits, receiptNo, actor.id)
      this.audit(actor.id, 'package.create', { accountId: id, visits: s.packageVisits, receiptNo })
      return id
    })
    return this.packageView(this.getPackageRow(id))
  }

  findPackages(actor: Actor, phone: unknown) {
    this.require(actor, 'package.use')
    const digits = String(phone ?? '').replace(/\D/g, '')
    if (digits.length < 4) throw new AppError(400, 'bad_phone', 'Enter at least 4 digits of the phone number')
    return this.db
      .query<PackageRow, [string]>(`SELECT * FROM package_accounts WHERE REPLACE(phone, '+', '') LIKE ? ORDER BY created_at DESC LIMIT 20`)
      .all(`%${digits}%`)
      .map(p => this.packageView(p))
  }

  getPackage(actor: Actor, id: number) {
    this.require(actor, 'package.use')
    const account = this.packageView(this.getPackageRow(id))
    const history = this.db
      .query<{ id: number; at: number; delta: number; kind: string; group_id: number | null; counterparty_account_id: number | null; receipt_no: string | null; note: string | null; staff: string }, [number]>(
        `SELECT l.*, s.name AS staff FROM package_ledger l JOIN staff s ON s.id = l.staff_id WHERE l.account_id = ? ORDER BY l.at DESC, l.id DESC`,
      )
      .all(id)
      .map(h => ({
        id: h.id,
        at: h.at,
        delta: h.delta,
        kind: h.kind,
        groupId: h.group_id,
        counterpartyAccountId: h.counterparty_account_id,
        receiptNo: h.receipt_no,
        note: h.note,
        staff: h.staff,
      }))
    return { ...account, history }
  }

  private packageView(p: PackageRow) {
    return {
      id: p.id,
      name: p.name,
      phone: p.phone,
      visitsLeft: p.visits_left,
      receiptNo: p.receipt_no,
      expiresAt: p.expires_at,
      expired: p.expires_at !== null && this.clock.now() > p.expires_at,
      createdAt: p.created_at,
    }
  }

  private deductInTx(actor: Actor, accountId: number, kids: number, groupId: number | null): void {
    const s = this.cachedSettings
    const account = this.getPackageRow(accountId)
    const now = this.clock.now()
    if (account.expires_at !== null && now > account.expires_at) throw new AppError(409, 'package_expired', 'This package has expired')
    if (s.packageWeekdayOnly && dayType(now, s.timeZone, s.publicHolidays) !== 'weekday') {
      throw new AppError(409, 'package_weekday_only', 'Packages can only be used on weekdays')
    }
    if (account.visits_left < kids) {
      throw new AppError(409, 'package_empty', `Only ${account.visits_left} visit(s) left on this package, ${kids} needed`)
    }
    this.db.query('UPDATE package_accounts SET visits_left = visits_left - ? WHERE id = ?').run(kids, accountId)
    this.db
      .query(`INSERT INTO package_ledger (account_id, at, delta, kind, group_id, staff_id) VALUES (?, ?, ?, 'visit', ?, ?)`)
      .run(accountId, now, -kids, groupId, actor.id)
    this.audit(actor.id, 'package.deduct', { accountId, kids, groupId })
  }

  deductVisits(actor: Actor, accountId: number, kids: unknown, groupId?: unknown) {
    this.require(actor, 'package.use')
    const n = wholeNumber(kids, 'Number of kids', 1, 50)
    const gid = groupId === undefined || groupId === null || groupId === '' ? null : wholeNumber(groupId, 'Group', 1, Number.MAX_SAFE_INTEGER)
    this.tx(() => this.deductInTx(actor, accountId, n, gid))
    return this.getPackage(actor, accountId)
  }

  /** Moves every remaining visit to another account. Manager or owner only; the RM fee is paid in StoreHub first. */
  transferPackage(actor: Actor, fromId: number, input: { toAccountId?: unknown; newAccount?: { name?: unknown; phone?: unknown }; receiptNo?: unknown; reason?: unknown }) {
    if (!can(actor.role, 'package.transfer')) {
      throw new AppError(403, 'manager_required', 'A manager must approve package transfers')
    }
    const receiptNo = text(input.receiptNo, 'StoreHub receipt number for the transfer fee', { max: 40 })
    const why = reasonText(input.reason)
    const result = this.tx(() => {
      const from = this.getPackageRow(fromId)
      if (from.visits_left <= 0) throw new AppError(409, 'package_empty', 'There are no visits left to transfer')
      let toId: number
      if (input.newAccount) {
        toId = this.createPackageShell(actor, input.newAccount)
      } else {
        toId = wholeNumber(input.toAccountId, 'Target account', 1, Number.MAX_SAFE_INTEGER)
        this.getPackageRow(toId)
      }
      if (toId === fromId) throw new AppError(400, 'same_account', 'Cannot transfer to the same account')
      const visits = from.visits_left
      const now = this.clock.now()
      this.db.query('UPDATE package_accounts SET visits_left = 0 WHERE id = ?').run(fromId)
      this.db.query('UPDATE package_accounts SET visits_left = visits_left + ? WHERE id = ?').run(visits, toId)
      const ledger = this.db.query(
        'INSERT INTO package_ledger (account_id, at, delta, kind, counterparty_account_id, receipt_no, staff_id, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      )
      ledger.run(fromId, now, -visits, 'transfer_out', toId, receiptNo, actor.id, why)
      ledger.run(toId, now, visits, 'transfer_in', fromId, receiptNo, actor.id, why)
      this.override(actor, 'package_transfer', why, { details: { fromId, toId, visits, receiptNo } })
      return { fromId, toId, visits }
    })
    return result
  }

  private createPackageShell(actor: Actor, input: { name?: unknown; phone?: unknown }): number {
    const name = text(input.name, 'Name', { max: 80 })
    const phone = normalizePhone(text(input.phone, 'Phone', { max: 30 }))
    if (phone.replace(/\D/g, '').length < 7) throw new AppError(400, 'bad_phone', 'Phone number looks too short')
    const id = Number(
      this.db
        .query('INSERT INTO package_accounts (name, phone, visits_left, receipt_no, expires_at, created_by, created_at) VALUES (?, ?, 0, NULL, NULL, ?, ?)')
        .run(name, phone, actor.id, this.clock.now()).lastInsertRowid,
    )
    this.audit(actor.id, 'package.create', { accountId: id, visits: 0, viaTransfer: true })
    return id
  }

  // ---------------------------------------------------------------- views

  private bandView(b: BandRow) {
    return {
      barcode: b.barcode,
      type: b.type,
      status: b.status,
      groupId: b.group_id,
      inside: b.inside === 1,
      firstInAt: b.first_in_at,
      lastScanAt: b.last_scan_at,
      activatedAt: b.activated_at,
    }
  }

  groupSummary(g: GroupRow, now = this.clock.now()) {
    const t = this.timing(g, now)
    const bands = this.db.query<BandRow, [number]>('SELECT * FROM bands WHERE group_id = ?').all(g.id)
    const counts = { adult: 0, kid: 0, under2: 0, total: 0, inside: 0, kidsInside: 0 }
    for (const b of bands) {
      if (b.status === 'void') continue
      counts[b.type]++
      counts.total++
      if (b.inside) {
        counts.inside++
        if (b.type === 'kid' || (b.type === 'under2' && this.cachedSettings.overtimeChargesUnder2)) counts.kidsInside++
      }
    }
    const party = g.party_id ? this.getPartyRow(g.party_id) : null
    return {
      id: g.id,
      type: g.type,
      receiptNo: g.receipt_no,
      tableNo: g.table_no,
      partyId: g.party_id,
      partyName: party?.name ?? null,
      packageAccountId: g.package_account_id,
      status: g.status,
      createdAt: g.created_at,
      firstScanAt: g.first_scan_at,
      ...t,
      blocksPaid: g.blocks_paid,
      clearedAt: g.cleared_at,
      extensionMinutes: g.extension_minutes,
      counts,
      amountOwed: t.blocksOwed * counts.kidsInside * this.cachedSettings.overtimeBlockPrice,
    }
  }

  groupDetail(actor: Actor, groupId: number) {
    this.require(actor, 'group.view')
    const g = this.getGroup(groupId)
    const bands = this.db.query<BandRow, [number]>('SELECT * FROM bands WHERE group_id = ? ORDER BY type, barcode').all(groupId)
    const scans = this.db
      .query<ScanRow, [number]>('SELECT * FROM scans WHERE group_id = ? ORDER BY at DESC, id DESC LIMIT 200')
      .all(groupId)
      .map(s => ({ id: s.id, at: s.at, lane: s.lane, barcode: s.barcode, result: s.result, code: s.code, message: MESSAGES[s.code], source: s.source }))
    const payments = this.db
      .query<{ at: number; blocks: number; kids: number; amount: number; receipt_no: string | null; staff: string }, [number]>(
        'SELECT o.*, s.name AS staff FROM overtime_payments o JOIN staff s ON s.id = o.staff_id WHERE o.group_id = ? ORDER BY o.at',
      )
      .all(groupId)
      .map(p => ({ at: p.at, blocks: p.blocks, kids: p.kids, amount: p.amount, receiptNo: p.receipt_no, staff: p.staff }))
    const overrides = this.db
      .query<{ at: number; action: string; reason: string; lane: string | null; barcode: string | null; staff: string }, [number]>(
        'SELECT o.*, s.name AS staff FROM overrides o JOIN staff s ON s.id = o.staff_id WHERE o.group_id = ? ORDER BY o.at DESC',
      )
      .all(groupId)
      .map(o => ({ at: o.at, action: o.action, reason: o.reason, lane: o.lane, barcode: o.barcode, staff: o.staff }))
    return {
      ...this.groupSummary(g),
      bands: bands.map(b => this.bandView(b)),
      scans,
      payments,
      overrides,
      party: g.party_id ? this.partyView(this.getPartyRow(g.party_id)) : null,
    }
  }

  dashboard(actor: Actor) {
    this.require(actor, 'dashboard.view')
    const now = this.clock.now()
    const groups = this.db
      .query<GroupRow, []>(`SELECT * FROM visit_groups WHERE status = 'active' ORDER BY id`)
      .all()
      .map(g => this.groupSummary(g, now))
    const inside = { adult: 0, kid: 0, under2: 0, total: 0 }
    for (const r of this.db.query<{ type: BandType; n: number }, []>('SELECT type, COUNT(*) AS n FROM bands WHERE inside = 1 GROUP BY type').all()) {
      inside[r.type] = r.n
      inside.total += r.n
    }
    const recentFrom = now - 10 * MINUTE
    const atGate = new Set(
      this.db
        .query<{ group_id: number }, [number]>(`SELECT DISTINCT group_id FROM scans WHERE code = 'see_host' AND at >= ? AND group_id IS NOT NULL`)
        .all(recentFrom)
        .map(r => r.group_id),
    )
    // Kids refused by the exit rule in the last 10 minutes who are still inside.
    const blockedKids = this.db
      .query<{ barcode: string; group_id: number; at: number }, [number]>(
        `SELECT s.barcode, s.group_id, MAX(s.at) AS at FROM scans s JOIN bands b ON b.barcode = s.barcode
         WHERE s.code = 'adult_first' AND s.at >= ? AND b.inside = 1
         GROUP BY s.barcode ORDER BY at DESC`,
      )
      .all(recentFrom)
      .map(r => ({ barcode: r.barcode, groupId: r.group_id, at: r.at }))
    const alerts = this.db
      .query<ScanRow, [number]>(
        `SELECT * FROM scans WHERE result = 'refused' AND code IN ('adult_first', 'see_host', 'already_inside') AND at >= ? ORDER BY at DESC LIMIT 20`,
      )
      .all(now - 30 * MINUTE)
      .map(s => ({ at: s.at, lane: s.lane, barcode: s.barcode, groupId: s.group_id, code: s.code, message: MESSAGES[s.code] }))
    const withPeople = groups.filter(g => g.counts.inside > 0)
    const parties = this.db
      .query<PartyRow, [number, number]>('SELECT * FROM parties WHERE start_at <= ? AND end_at >= ? ORDER BY start_at')
      .all(now + HOUR, now - 30 * MINUTE)
      .map(p => this.partyView(p))
    return {
      now,
      fire: this.fire,
      lanes: this.laneStates(),
      capacity: this.capacity(),
      inside,
      endingSoon: withPeople
        .filter(g => (g.phase === 'playing' && g.msLeft !== null && g.msLeft <= 15 * MINUTE) || g.phase === 'grace')
        .sort((a, b) => (a.msLeft ?? 0) - (b.msLeft ?? 0)),
      overtime: withPeople.filter(g => g.exitLocked).map(g => ({ ...g, atGate: atGate.has(g.id) })),
      blockedKids,
      parties,
      alerts,
      groups: groups.sort((a, b) => (a.msLeft ?? Number.MAX_SAFE_INTEGER) - (b.msLeft ?? Number.MAX_SAFE_INTEGER)),
    }
  }

  /** Bands the simulator can scan. Only exposed when the server runs in simulator mode. */
  simBands() {
    return this.db
      .query<BandRow & { gtype: GroupType; party_name: string | null }, []>(
        `SELECT b.*, g.type AS gtype, p.name AS party_name FROM bands b
         JOIN visit_groups g ON g.id = b.group_id LEFT JOIN parties p ON p.id = g.party_id
         WHERE b.status = 'active' OR b.inside = 1 ORDER BY b.group_id DESC, b.type, b.barcode LIMIT 300`,
      )
      .all()
      .map(b => ({ ...this.bandView(b), groupType: b.gtype, partyName: b.party_name }))
  }

  // ---------------------------------------------------------------- end of day

  /** Called every minute. Closes every open group once the end-of-day time has passed. */
  tick(): void {
    const s = this.cachedSettings
    const now = this.clock.now()
    const p = localParts(now, s.timeZone)
    const hhmm = `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`
    const last = this.db.query<{ value: string }, []>(`SELECT value FROM system_state WHERE key = 'last_end_of_day'`).get()?.value
    if (hhmm < s.endOfDayTime || last === p.date) return
    this.endOfDay(p.date)
  }

  endOfDay(date: string): number {
    const closed = this.tx(() => {
      const now = this.clock.now()
      // Party groups for future dates stay open; only groups that should already be over are closed.
      const ids = this.db
        .query<{ id: number }, [number]>(
          `SELECT g.id FROM visit_groups g LEFT JOIN parties p ON p.id = g.party_id
           WHERE g.status = 'active' AND (p.id IS NULL OR p.end_at <= ?)`,
        )
        .all(now)
        .map(r => r.id)
      for (const id of ids) this.closeGroupInTx(id, now)
      this.db
        .query(`INSERT INTO system_state (key, value) VALUES ('last_end_of_day', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
        .run(date)
      this.audit(null, 'system.end_of_day', { date, closedGroups: ids.length })
      return ids.length
    })
    this.emit({ type: 'changed' })
    return closed
  }

  // ---------------------------------------------------------------- reports

  dailyReport(actor: Actor, date: unknown) {
    this.require(actor, 'reports.view')
    const s = this.cachedSettings
    const tz = s.timeZone
    const day = typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : localParts(this.clock.now(), tz).date
    const [from, to] = dayBounds(day, tz)

    const visitors = this.db
      .query<{ barcode: string; type: BandType; first_in_at: number; gtype: GroupType; group_id: number; package_account_id: number | null }, [number, number]>(
        `SELECT b.barcode, b.type, b.first_in_at, g.type AS gtype, g.id AS group_id, g.package_account_id
         FROM bands b JOIN visit_groups g ON g.id = b.group_id WHERE b.first_in_at >= ? AND b.first_in_at < ?`,
      )
      .all(from, to)
    const byHour = new Array(24).fill(0) as number[]
    const people = { total: 0, adult: 0, kid: 0, under2: 0, walkin: 0, party: 0 }
    const groupIds = { walkin: new Set<number>(), party: new Set<number>() }
    let paidWalkinKids = 0
    for (const v of visitors) {
      byHour[localParts(v.first_in_at, tz).hour]!++
      people.total++
      people[v.type]++
      people[v.gtype]++
      groupIds[v.gtype].add(v.group_id)
      if (v.gtype === 'walkin' && v.type === 'kid' && v.package_account_id === null) paidWalkinKids++
    }
    const dt = dayType(from + 12 * HOUR, tz, s.publicHolidays)
    const passPrice = dt === 'weekday' ? s.playPassPrice.weekday : s.playPassPrice.weekend

    // Average stay: groups that started today and have fully left.
    const stays = this.db
      .query<{ id: number; first_scan_at: number; last_out: number | null; inside: number }, [number, number]>(
        `SELECT g.id, g.first_scan_at,
           (SELECT MAX(at) FROM scans WHERE group_id = g.id AND lane = 'out' AND result = 'opened') AS last_out,
           (SELECT COUNT(*) FROM bands WHERE group_id = g.id AND inside = 1) AS inside
         FROM visit_groups g WHERE g.first_scan_at >= ? AND g.first_scan_at < ?`,
      )
      .all(from, to)
      .filter(r => r.inside === 0 && r.last_out !== null)
      .map(r => (r.last_out! - r.first_scan_at) / MINUTE)
    const averageStayMinutes = stays.length ? Math.round(stays.reduce((a, b) => a + b, 0) / stays.length) : null

    const overtimeItems = this.db
      .query<{ group_id: number; at: number; blocks: number; kids: number; amount: number; receipt_no: string | null; staff: string; group_receipt: string | null }, [number, number]>(
        `SELECT o.*, s.name AS staff, g.receipt_no AS group_receipt FROM overtime_payments o
         JOIN staff s ON s.id = o.staff_id JOIN visit_groups g ON g.id = o.group_id
         WHERE o.at >= ? AND o.at < ? ORDER BY o.at`,
      )
      .all(from, to)
      .map(o => ({ groupId: o.group_id, at: o.at, blocks: o.blocks, kids: o.kids, amount: o.amount, receiptNo: o.receipt_no, groupReceiptNo: o.group_receipt, staff: o.staff }))

    const scans = this.db.query<ScanRow, [number, number]>('SELECT * FROM scans WHERE at >= ? AND at < ? ORDER BY at, id').all(from, to)
    const refusals: Record<string, number> = {}
    let opened = 0
    let headcount = 0
    let peak = { headcount: 0, at: null as number | null }
    for (const sc of scans) {
      if (sc.result === 'refused') {
        refusals[sc.code] = (refusals[sc.code] ?? 0) + 1
        continue
      }
      opened++
      headcount += sc.lane === 'in' ? 1 : -1
      if (headcount < 0) headcount = 0
      if (headcount > peak.headcount) peak = { headcount, at: sc.at }
    }

    const overrides = this.db
      .query<{ at: number; action: string; reason: string; group_id: number | null; lane: string | null; barcode: string | null; staff: string }, [number, number]>(
        'SELECT o.*, s.name AS staff FROM overrides o JOIN staff s ON s.id = o.staff_id WHERE o.at >= ? AND o.at < ? ORDER BY o.at',
      )
      .all(from, to)
      .map(o => ({ at: o.at, action: o.action, reason: o.reason, groupId: o.group_id, lane: o.lane, barcode: o.barcode, staff: o.staff }))

    const visitsUsed = -(
      this.db
        .query<{ n: number | null }, [number, number]>(`SELECT SUM(delta) AS n FROM package_ledger WHERE kind = 'visit' AND at >= ? AND at < ?`)
        .get(from, to)!.n ?? 0
    )
    const packagesSold = this.db
      .query<{ n: number }, [number, number]>(`SELECT COUNT(*) AS n FROM package_ledger WHERE kind = 'purchase' AND at >= ? AND at < ?`)
      .get(from, to)!.n
    const transfers = this.db
      .query<{ at: number; account_id: number; counterparty_account_id: number; delta: number; receipt_no: string | null; staff: string }, [number, number]>(
        `SELECT l.*, s.name AS staff FROM package_ledger l JOIN staff s ON s.id = l.staff_id
         WHERE l.kind = 'transfer_out' AND l.at >= ? AND l.at < ? ORDER BY l.at`,
      )
      .all(from, to)
      .map(t => ({ at: t.at, fromId: t.account_id, toId: t.counterparty_account_id, visits: -t.delta, receiptNo: t.receipt_no, staff: t.staff }))
    const balances = this.db
      .query<PackageRow, []>('SELECT * FROM package_accounts WHERE visits_left > 0 ORDER BY name')
      .all()
      .map(p => ({ id: p.id, name: p.name, phone: p.phone, visitsLeft: p.visits_left }))

    return {
      date: day,
      dayType: dt,
      people,
      groups: { walkin: groupIds.walkin.size, party: groupIds.party.size, total: groupIds.walkin.size + groupIds.party.size },
      visitsByHour: byHour.map((n, hour) => ({ hour, people: n })),
      averageStayMinutes,
      playPasses: { paidWalkinKids, price: passPrice, expectedStoreHubTotal: paidWalkinKids * passPrice },
      overtime: {
        groups: new Set(overtimeItems.map(o => o.groupId)).size,
        blocks: overtimeItems.reduce((a, o) => a + o.blocks, 0),
        amount: overtimeItems.reduce((a, o) => a + o.amount, 0),
        items: overtimeItems,
      },
      gate: { scans: scans.length, opened, refused: scans.length - opened, refusals, kidsBlocked: refusals.adult_first ?? 0 },
      overrides,
      packages: { sold: packagesSold, visitsUsed, transfers, balances },
      peak,
    }
  }

  dailyReportCsv(actor: Actor, date: unknown): string {
    const r = this.dailyReport(actor, date)
    const tz = this.cachedSettings.timeZone
    const rows: (string | number | null)[][] = [['section', 'item', 'value', 'detail']]
    const t = (ms: number | null) => (ms === null ? '' : formatLocal(ms, tz))
    rows.push(['summary', 'date', r.date, r.dayType])
    rows.push(['summary', 'people', r.people.total, `adults ${r.people.adult}, kids ${r.people.kid}, under-2 ${r.people.under2}`])
    rows.push(['summary', 'walk-in people', r.people.walkin, `${r.groups.walkin} groups`])
    rows.push(['summary', 'party people', r.people.party, `${r.groups.party} parties`])
    rows.push(['summary', 'average stay (min)', r.averageStayMinutes, ''])
    rows.push(['summary', 'peak headcount', r.peak.headcount, t(r.peak.at)])
    rows.push(['summary', 'paid walk-in kids', r.playPasses.paidWalkinKids, `expected StoreHub play passes RM ${r.playPasses.expectedStoreHubTotal}`])
    for (const h of r.visitsByHour) if (h.people) rows.push(['visits by hour', `${String(h.hour).padStart(2, '0')}:00`, h.people, ''])
    rows.push(['overtime', 'groups', r.overtime.groups, ''])
    rows.push(['overtime', 'blocks', r.overtime.blocks, ''])
    rows.push(['overtime', 'amount (RM)', r.overtime.amount, ''])
    for (const o of r.overtime.items) {
      rows.push(['overtime item', `group ${o.groupId}`, o.amount, `${o.blocks} block(s) x ${o.kids} kid(s); receipt ${o.receiptNo ?? ''}; by ${o.staff} at ${t(o.at)}`])
    }
    rows.push(['gate', 'scans', r.gate.scans, `${r.gate.opened} opened, ${r.gate.refused} refused`])
    rows.push(['gate', 'kids blocked', r.gate.kidsBlocked, ''])
    for (const [code, n] of Object.entries(r.gate.refusals)) rows.push(['gate refusals', code, n, ''])
    for (const o of r.overrides) rows.push(['override', o.action, o.staff, `${t(o.at)}; ${o.reason}${o.groupId ? `; group ${o.groupId}` : ''}${o.lane ? `; lane ${o.lane}` : ''}`])
    rows.push(['packages', 'sold', r.packages.sold, ''])
    rows.push(['packages', 'visits used', r.packages.visitsUsed, ''])
    for (const tr of r.packages.transfers) rows.push(['package transfer', `${tr.fromId} -> ${tr.toId}`, tr.visits, `receipt ${tr.receiptNo ?? ''}; by ${tr.staff}`])
    for (const b of r.packages.balances) rows.push(['package balance', b.name, b.visitsLeft, b.phone])
    return toCsv(rows)
  }

  scansCsv(actor: Actor, date: unknown): string {
    this.require(actor, 'reports.view')
    const tz = this.cachedSettings.timeZone
    const day = typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : localParts(this.clock.now(), tz).date
    const [from, to] = dayBounds(day, tz)
    const rows: (string | number | null)[][] = [['time', 'lane', 'barcode', 'band_type', 'group', 'result', 'reason', 'source']]
    for (const s of this.db.query<ScanRow, [number, number]>('SELECT * FROM scans WHERE at >= ? AND at < ? ORDER BY at, id').all(from, to)) {
      rows.push([formatLocal(s.at, tz), s.lane, s.barcode, s.band_type, s.group_id, s.result, s.code, s.source])
    }
    return toCsv(rows)
  }

  /** Every record, for Naru's own archive. PIN hashes and login sessions are left out. */
  exportAll(actor: Actor) {
    this.require(actor, 'data.export')
    const all = (sql: string) => this.db.query(sql).all()
    return {
      exportedAt: this.clock.now(),
      settings: this.cachedSettings,
      staff: all('SELECT id, name, role, active, created_at FROM staff'),
      groups: all('SELECT * FROM visit_groups'),
      parties: all('SELECT * FROM parties'),
      bands: all('SELECT * FROM bands'),
      scans: all('SELECT * FROM scans'),
      packageAccounts: all('SELECT * FROM package_accounts'),
      packageLedger: all('SELECT * FROM package_ledger'),
      overtimePayments: all('SELECT * FROM overtime_payments'),
      overrides: all('SELECT * FROM overrides'),
      auditLog: all('SELECT * FROM audit_log'),
    }
  }
}

function toCsv(rows: (string | number | null)[][]): string {
  return (
    rows
      .map(r =>
        r
          .map(v => {
            const s = v === null || v === undefined ? '' : String(v)
            // Prefix cells that a spreadsheet would treat as a formula.
            const safe = /^[=+\-@]/.test(s) && !/^-?\d/.test(s) ? `'${s}` : s
            return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe
          })
          .join(','),
      )
      .join('\n') + '\n'
  )
}

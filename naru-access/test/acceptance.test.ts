/**
 * Section 9 of the developer brief, one test per sign-off item, in the same order.
 * The clock is simulated, so "3:16" means exactly 3:16 pm Kuala Lumpur time.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SimClock } from '../src/core/clock.ts'
import { AccessSystem, type SystemEvent } from '../src/core/system.ts'
import { openDatabase } from '../src/db/database.ts'
import { encodeQr } from '../src/qr.ts'
import { at, decodeQr, setup, walkIn } from './helpers.ts'

const FAMILY = ['A-000001', 'A-000002', 'K-000001', 'K-000002', 'K-000003']
const ADULTS = FAMILY.slice(0, 2)
const KIDS = FAMILY.slice(2)

/** Family enters at 12:00, so play time ends at 15:00 and grace at 15:15. */
function familyInside() {
  const env = setup(at('11:55'))
  const group = walkIn(env, FAMILY)
  env.time('12:00')
  for (const b of FAMILY) expect(env.system.scan('in', b).open).toBe(true)
  return { env, group }
}

describe('Section 9 acceptance tests', () => {
  test('1. Family of 2 adults and 3 kids: 2 A + 3 K bands linked to one group and receipt', () => {
    const env = setup()
    const group = walkIn(env, FAMILY, 'SH-88812', '7')
    const detail = env.system.groupDetail(env.staff.supervisor, group.id)
    expect(detail.receiptNo).toBe('SH-88812')
    expect(detail.tableNo).toBe('7')
    expect(detail.counts).toMatchObject({ adult: 2, kid: 3, total: 5 })
    expect(detail.bands.every(b => b.groupId === group.id)).toBe(true)
    expect(detail.bands.filter(b => b.type === 'adult').map(b => b.barcode)).toEqual(ADULTS)
  })

  test('2. Timer starts at the first gate scan, not at activation', () => {
    const env = setup(at('11:00'))
    const group = walkIn(env, FAMILY)
    env.time('11:40')
    expect(env.system.groupDetail(env.staff.supervisor, group.id).phase).toBe('not_started')
    env.system.scan('in', 'A-000001')
    const detail = env.system.groupDetail(env.staff.supervisor, group.id)
    expect(detail.firstScanAt).toBe(at('11:40'))
    expect(detail.effectiveEnd).toBe(at('14:40'))
    // A second family member scanning later does not restart the timer.
    env.time('11:50')
    env.system.scan('in', 'K-000001')
    expect(env.system.groupDetail(env.staff.supervisor, group.id).effectiveEnd).toBe(at('14:40'))
  })

  test('3. Kid scans out alone: gate shut, "Adult must scan out first", supervisor alerted', () => {
    const { env, group } = familyInside()
    const alerts: SystemEvent[] = []
    env.system.onEvent(e => e.type === 'alert' && alerts.push(e))
    env.time('13:00')
    const d = env.system.scan('out', 'K-000001')
    expect(d.open).toBe(false)
    expect(d.message).toBe('Adult must scan out first')
    expect(alerts).toHaveLength(1)
    const dash = env.system.dashboard(env.staff.supervisor)
    expect(dash.blockedKids).toEqual([{ barcode: 'K-000001', groupId: group.id, at: at('13:00') }])
  })

  test('4. Adult scans out, kids follow within 1 minute: gate opens; after 1 minute: shut', () => {
    const { env } = familyInside()
    env.time('13:00')
    expect(env.system.scan('out', 'A-000001').open).toBe(true)
    env.clock.advance(30_000)
    expect(env.system.scan('out', 'K-000001').open).toBe(true)
    env.clock.advance(29_000) // 59 s after the adult
    expect(env.system.scan('out', 'K-000002').open).toBe(true)
    env.clock.advance(2_000) // 61 s after the adult
    const late = env.system.scan('out', 'K-000003')
    expect(late.open).toBe(false)
    expect(late.message).toBe('Adult must scan out first')
  })

  test('5a. Group leaves at 3:14: gate opens', () => {
    const { env } = familyInside()
    env.time('15:14')
    expect(env.system.scan('out', 'A-000001').open).toBe(true)
    for (const k of KIDS) expect(env.system.scan('out', k).open).toBe(true)
    expect(env.system.scan('out', 'A-000002').open).toBe(true)
  })

  test('5b. Group leaves at 3:16: shut until cleared, dashboard shows 1 block x 3 kids = RM 90', () => {
    const { env, group } = familyInside()
    env.time('15:16')
    const d = env.system.scan('out', 'A-000001')
    expect(d.open).toBe(false)
    expect(d.message).toBe('Please see our host')

    const dash = env.system.dashboard(env.staff.supervisor)
    expect(dash.overtime).toHaveLength(1)
    expect(dash.overtime[0]).toMatchObject({ id: group.id, blocksOwed: 1, atGate: true, amountOwed: 90 })
    expect(dash.overtime[0]!.counts.kidsInside).toBe(3)

    // Clearing needs a reason, and the StoreHub receipt for the overtime.
    expect(() => env.system.clearGroup(env.staff.supervisor, group.id, { reason: 'paid' })).toThrow(/receipt/)
    const cleared = env.system.clearGroup(env.staff.supervisor, group.id, { reason: 'Paid overtime', receiptNo: 'SH-OT-1' })
    expect(cleared).toMatchObject({ blocks: 1, kids: 3, amount: 90 })
    expect(env.system.scan('out', 'A-000001').open).toBe(true)
    for (const k of KIDS) expect(env.system.scan('out', k).open).toBe(true)
  })

  test('6. Group leaves at 3:40: dashboard shows 2 blocks', () => {
    const { env } = familyInside()
    env.time('15:40')
    expect(env.system.scan('out', 'A-000001').open).toBe(false)
    const [g] = env.system.dashboard(env.staff.supervisor).overtime
    expect(g).toMatchObject({ blocksOwed: 2, amountOwed: 180 })
  })

  test('7. Re-entry during the session works; timer keeps running', () => {
    const { env, group } = familyInside()
    env.time('13:00')
    expect(env.system.scan('out', 'A-000001').open).toBe(true)
    expect(env.system.scan('out', 'K-000001').open).toBe(true)
    env.time('13:10')
    expect(env.system.scan('in', 'A-000001').open).toBe(true)
    expect(env.system.scan('in', 'K-000001').open).toBe(true)
    const detail = env.system.groupDetail(env.staff.supervisor, group.id)
    expect(detail.effectiveEnd).toBe(at('15:00'))
    expect(detail.counts.inside).toBe(5)
    // The kids exit rule still applies after re-entry.
    env.time('13:30')
    expect(env.system.scan('out', 'K-000001').open).toBe(false)
  })

  test('8. Party bands work only inside the party block, with no grace', () => {
    const env = setup(at('10:00'))
    const party = env.system.createParty(env.staff.events, {
      name: "Aisha's 6th birthday", room: 'Private Room A', date: '2026-10-03', startTime: '14:00', endTime: '17:00',
      expectedGuests: 20, hostName: 'Farah', hostPhone: '012-345 6789',
    })
    env.system.addBand(env.staff.receptionist, party.groupId, 'A-100001')
    env.system.addBand(env.staff.receptionist, party.groupId, 'K-100001')
    env.time('13:50')
    expect(env.system.scan('in', 'K-100001').code).toBe('party_not_started')
    env.time('14:00')
    expect(env.system.scan('in', 'A-100001').open).toBe(true)
    expect(env.system.scan('in', 'K-100001').open).toBe(true)
    env.time('17:00')
    expect(env.system.scan('out', 'A-100001').open).toBe(true)
    env.time('17:01')
    expect(env.system.scan('in', 'A-100001').code).toBe('party_ended')
    // No grace: one minute after the block the exit is held.
    expect(env.system.scan('out', 'K-100001').message).toBe('Please see our host')
  })

  test('9. Reception finds a party by e-invite code and activates 30 bands in under 10 minutes', () => {
    const env = setup(at('13:30'))
    const party = env.system.createParty(env.staff.events, {
      name: 'Party of 30', room: 'Private Room B', date: '2026-10-03', startTime: '14:00',
      expectedGuests: 30, hostName: 'Lim', hostPhone: '0123456789',
    })
    expect(party.endAt - party.startAt).toBe(180 * 60_000) // default block length setting
    const started = performance.now()
    // Reception scans the QR on the guest's e-invite; the scanner types what the QR holds.
    const scanned = decodeQr(encodeQr(party.inviteCode, 'Q'))
    expect(scanned).toBe(party.inviteCode)
    const found = env.system.findPartyByCode(env.staff.receptionist, scanned!)
    expect(found.id).toBe(party.id)
    // A typed code or a link ending in the code also works.
    expect(env.system.findPartyByCode(env.staff.receptionist, `https://naru.example/invite/${party.inviteCode.toLowerCase()}`).id).toBe(party.id)
    for (let i = 1; i <= 30; i++) {
      env.system.addBand(env.staff.receptionist, found.groupId, i <= 12 ? `A-2000${String(i).padStart(2, '0')}` : `K-2000${String(i).padStart(2, '0')}`)
    }
    const elapsed = performance.now() - started
    const after = env.system.getParty(env.staff.receptionist, party.id)
    expect(after.checkedIn).toMatchObject({ total: 30, adult: 12, kid: 18 })
    expect(elapsed).toBeLessThan(10 * 60_000)
    expect(elapsed).toBeLessThan(2_000) // the system itself adds almost nothing to the 10 minutes
  })

  test('10. Package: 12 visits, 2 kids in one visit deducts 2, refuses at 0', () => {
    const env = setup()
    const account = env.system.createPackage(env.staff.cashier, { name: 'Tan Mei Ling', phone: '+60 12-888 1234', receiptNo: 'SH-PKG-1' })
    expect(account.visitsLeft).toBe(12)
    const [found] = env.system.findPackages(env.staff.cashier, '8881234')
    expect(found!.id).toBe(account.id)
    const group = env.system.createGroup(env.staff.cashier, { tableNo: '3', packageAccountId: account.id, packageKids: 2 })
    expect(group.receiptNo).toContain('SH-PKG-1')
    expect(env.system.getPackage(env.staff.cashier, account.id).visitsLeft).toBe(10)
    env.system.deductVisits(env.staff.cashier, account.id, 10)
    expect(env.system.getPackage(env.staff.cashier, account.id).visitsLeft).toBe(0)
    expect(() => env.system.deductVisits(env.staff.cashier, account.id, 1)).toThrow(/Only 0 visit/)
  })

  test('11. Package transfer blocked without manager approval; both histories updated', () => {
    const env = setup()
    const from = env.system.createPackage(env.staff.cashier, { name: 'Ahmad', phone: '0171112222', receiptNo: 'SH-1' })
    env.system.deductVisits(env.staff.cashier, from.id, 3)
    const transfer = { newAccount: { name: 'Siti', phone: '0193334444' }, receiptNo: 'SH-FEE-9', reason: 'Family moved away' }
    expect(() => env.system.transferPackage(env.staff.cashier, from.id, transfer)).toThrow(/manager must approve/)
    expect(() => env.system.transferPackage(env.staff.supervisor, from.id, transfer)).toThrow(/manager must approve/)
    const result = env.system.transferPackage(env.staff.manager, from.id, transfer)
    expect(result.visits).toBe(9)
    const a = env.system.getPackage(env.staff.cashier, from.id)
    const b = env.system.getPackage(env.staff.cashier, result.toId)
    expect(a.visitsLeft).toBe(0)
    expect(b.visitsLeft).toBe(9)
    expect(a.history[0]).toMatchObject({ kind: 'transfer_out', delta: -9, counterpartyAccountId: b.id, receiptNo: 'SH-FEE-9' })
    expect(b.history[0]).toMatchObject({ kind: 'transfer_in', delta: 9, counterpartyAccountId: a.id, receiptNo: 'SH-FEE-9' })
  })

  test('12. Capacity warning at 135, activation blocked at 150', () => {
    const env = setup()
    const group = env.system.createGroup(env.staff.cashier, { receiptNo: 'SH-BIG', tableNo: '1' })
    for (let i = 1; i <= 134; i++) env.system.addBand(env.staff.cashier, group.id, `A-${String(i).padStart(6, '0')}`)
    expect(env.system.capacity().warn).toBe(false)
    const r = env.system.addBand(env.staff.cashier, group.id, 'A-000135')
    expect(r.capacity).toMatchObject({ occupancy: 135, warn: true, full: false })
    for (let i = 136; i <= 150; i++) env.system.addBand(env.staff.cashier, group.id, `A-${String(i).padStart(6, '0')}`)
    expect(env.system.capacity()).toMatchObject({ occupancy: 150, full: true })
    expect(() => env.system.addBand(env.staff.cashier, group.id, 'A-000151')).toThrow(/full/)
  })

  test('13. 150 bands scanning in and out in a simulated rush: no errors, each decision under 1 second', () => {
    const env = setup(at('11:00'))
    const groups: string[][] = []
    for (let g = 0; g < 30; g++) {
      const codes = [0, 1].map(i => `A-${g}${i}0000`).concat([0, 1, 2].map(i => `K-${g}${i}0000`))
      walkIn(env, codes, `SH-${g}`)
      groups.push(codes)
    }
    expect(env.system.capacity().occupancy).toBe(150)
    const times: number[] = []
    env.time('11:30')
    for (const codes of groups) for (const c of codes) {
      const d = env.system.scan('in', c)
      expect(d.open).toBe(true)
      times.push(d.decisionMs)
    }
    expect(env.system.capacity().inside).toBe(150)
    env.time('14:00')
    for (const codes of groups) for (const c of codes) {
      const d = env.system.scan('out', c) // adults first, then kids, per group
      expect(d.open).toBe(true)
      times.push(d.decisionMs)
    }
    expect(env.system.capacity().inside).toBe(0)
    expect(times).toHaveLength(300)
    expect(Math.max(...times)).toBeLessThan(1000)
  })

  test('14. Internet unplugged mid-session: everything keeps working', async () => {
    const { env, group } = familyInside()
    const realFetch = globalThis.fetch
    let networkCalls = 0
    globalThis.fetch = (() => {
      networkCalls++
      throw new Error('network is down')
    }) as unknown as typeof fetch
    try {
      env.time('15:20')
      expect(env.system.scan('out', 'A-000001').open).toBe(false)
      env.system.clearGroup(env.staff.supervisor, group.id, { reason: 'Paid overtime', receiptNo: 'SH-77' })
      expect(env.system.scan('out', 'A-000001').open).toBe(true)
      env.system.dailyReportCsv(env.staff.manager, '2026-10-03')
      expect(networkCalls).toBe(0)
    } finally {
      globalThis.fetch = realFetch
    }
  })

  describe('15. Power cut: sessions intact after restart', () => {
    let dir = ''
    afterEach(() => dir && rmSync(dir, { recursive: true, force: true }))

    test('a restarted server keeps every band, timer and the fire state', () => {
      dir = mkdtempSync(join(tmpdir(), 'naru-'))
      const file = join(dir, 'naru.db')
      const env = setup(at('11:55'), file)
      const group = walkIn(env, FAMILY)
      env.time('12:00')
      for (const b of FAMILY) env.system.scan('in', b)
      env.system.db.close() // power cut

      const restarted = new AccessSystem(openDatabase(file), new SimClock(at('15:16')))
      const supervisor = restarted.login('444444').staff
      const detail = restarted.groupDetail(supervisor, group.id)
      expect(detail.effectiveEnd).toBe(at('15:00'))
      expect(detail.counts.inside).toBe(5)
      expect(restarted.scan('out', 'A-000001').message).toBe('Please see our host')
      expect(restarted.verifyAuditChain().ok).toBe(true)
    })
    // The gates themselves opening on power loss is hardware (fail-open gates); the lane
    // controller's own fail-open when it loses the server is covered in lane.test.ts.
  })

  test('16. Fire alarm signal: both lanes open immediately', () => {
    const { env } = familyInside()
    const events: SystemEvent[] = []
    env.system.onEvent(e => events.push(e))
    env.system.setFireAlarm(true, 'fire panel')
    const laneEvent = events.find(e => e.type === 'lane')
    expect(laneEvent).toMatchObject({ type: 'lane', fire: true })
    expect(env.system.laneStates().every(l => l.held)).toBe(true)
    // Every rule is ignored: a kid alone, in overtime, still gets out.
    env.time('16:00')
    const d = env.system.scan('out', 'K-000001')
    expect(d).toMatchObject({ open: true, code: 'fire' })
    env.system.setFireAlarm(false, 'fire panel reset')
    expect(env.system.laneStates().every(l => !l.held)).toBe(true)
  })

  test('17. Manual release and handheld backup both work', () => {
    const { env } = familyInside()
    const gates: SystemEvent[] = []
    env.system.onEvent(e => e.type === 'gate' && gates.push(e))
    // Manual open needs a reason and is logged with the staff name.
    expect(() => env.system.manualOpen(env.staff.supervisor, 'out', '')).toThrow(/reason/i)
    expect(() => env.system.manualOpen(env.staff.cashier, 'out', 'stroller stuck')).toThrow(/not allowed/)
    env.system.manualOpen(env.staff.supervisor, 'out', 'Stroller stuck')
    expect(gates.at(-1)).toMatchObject({ lane: 'out', decision: { open: true, code: 'manual' } })
    // Reader failed: supervisor scans the band with the handheld; the same rules apply.
    env.time('13:00')
    expect(() => env.system.scan('out', 'A-000001', 'handheld')).toThrow(/login/)
    const kidAlone = env.system.scan('out', 'K-000001', 'handheld', env.staff.supervisor)
    expect(kidAlone.open).toBe(false)
    expect(env.system.scan('out', 'A-000001', 'handheld', env.staff.supervisor).open).toBe(true)
    // Releasing one specific band records it as having left.
    env.system.releaseBand(env.staff.supervisor, 'K-000002', 'out', 'Parent waiting outside')
    const report = env.system.dailyReport(env.staff.manager, '2026-10-03')
    expect(report.overrides.map(o => [o.action, o.staff])).toEqual([
      ['manual_open', 'supervisor person'],
      ['release_band', 'supervisor person'],
    ])
  })

  test('18. Daily report exports (CSV for Google Sheets) and matches the day\'s scans', () => {
    const { env, group } = familyInside()
    env.time('13:00')
    env.system.scan('out', 'K-000001') // refused: kids exit rule
    env.time('15:16')
    env.system.scan('out', 'A-000001') // refused: overtime
    env.system.clearGroup(env.staff.supervisor, group.id, { reason: 'Paid', receiptNo: 'SH-OT' })
    for (const b of FAMILY) env.system.scan('out', b)

    const report = env.system.dailyReport(env.staff.manager, '2026-10-03')
    expect(report.dayType).toBe('weekend')
    expect(report.people).toMatchObject({ total: 5, adult: 2, kid: 3, walkin: 5 })
    expect(report.visitsByHour[12]!.people).toBe(5)
    expect(report.gate).toMatchObject({ scans: 12, opened: 10, refused: 2, kidsBlocked: 1 })
    expect(report.overtime).toMatchObject({ groups: 1, blocks: 1, amount: 90 })
    expect(report.peak).toEqual({ headcount: 5, at: at('12:00') })
    expect(report.averageStayMinutes).toBe(196)
    expect(report.playPasses).toEqual({ paidWalkinKids: 3, price: 50, expectedStoreHubTotal: 150 })

    const scansCsv = env.system.scansCsv(env.staff.manager, '2026-10-03').trim().split('\n')
    expect(scansCsv).toHaveLength(1 + 12)
    expect(scansCsv[1]).toBe('2026-10-03 12:00:00,in,A-000001,adult,1,opened,ok_in,reader')
    const summary = env.system.dailyReportCsv(env.staff.manager, '2026-10-03')
    expect(summary).toContain('gate,scans,12,"10 opened, 2 refused"')
    expect(summary).toContain('overtime,amount (RM),90,')
  })
})

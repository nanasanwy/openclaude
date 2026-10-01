/**
 * Every business rule from section 2 of the brief lives here so a manager can
 * change it in the Settings screen. Nothing in the rules engine is hard-coded.
 */
export interface Settings {
  venueName: string
  timeZone: string
  openingHours: { weekday: { open: string; close: string }; weekend: { open: string; close: string } }
  /** Local time after which every open group and band is closed for the day. */
  endOfDayTime: string
  publicHolidays: string[]

  bandPrefixes: { adult: string; kid: string; under2: string }
  bandColours: { adult: string; kid: string; under2: string }

  playPassPrice: { weekday: number; weekend: number }
  sessionMinutes: number
  graceMinutes: number
  overtimeBlockMinutes: number
  overtimeBlockPrice: number
  overtimeChargesUnder2: boolean
  /** After a supervisor clears a group, the exit stays open for this long even if a new block starts. */
  clearExitWindowMinutes: number
  kidExitWindowSeconds: number
  /** Refuse an IN scan for a band that is already inside. */
  antiPassback: boolean

  capacity: number
  capacityWarnPercent: number

  partyRooms: string[]
  partyBlockMinutes: number
  partyGraceMinutes: number
  partyEarlyEntryMinutes: number

  packageVisits: number
  packagePrice: number | null
  packageExpiryMonths: number
  packageWeekdayOnly: boolean
  packageTransferFee: number
}

export const DEFAULT_SETTINGS: Settings = {
  venueName: 'Naru Hartamas',
  timeZone: 'Asia/Kuala_Lumpur',
  openingHours: { weekday: { open: '11:00', close: '22:00' }, weekend: { open: '10:00', close: '22:00' } },
  endOfDayTime: '23:30',
  publicHolidays: [],

  bandPrefixes: { adult: 'A-', kid: 'K-', under2: 'U-' },
  bandColours: { adult: '', kid: '', under2: '' },

  playPassPrice: { weekday: 35, weekend: 50 },
  sessionMinutes: 180,
  graceMinutes: 15,
  overtimeBlockMinutes: 30,
  overtimeBlockPrice: 30,
  overtimeChargesUnder2: false,
  clearExitWindowMinutes: 10,
  kidExitWindowSeconds: 60,
  antiPassback: true,

  capacity: 150,
  capacityWarnPercent: 90,

  partyRooms: ['Private Room A', 'Private Room B'],
  partyBlockMinutes: 180,
  partyGraceMinutes: 0,
  partyEarlyEntryMinutes: 0,

  packageVisits: 12,
  packagePrice: null,
  packageExpiryMonths: 0,
  packageWeekdayOnly: false,
  packageTransferFee: 20,
}

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/
const DATE = /^\d{4}-\d{2}-\d{2}$/

function sameShape(def: unknown, value: unknown, path: string, errors: string[]): void {
  if (def === null) {
    if (value !== null && typeof value !== 'number') errors.push(`${path} must be a number or empty`)
    return
  }
  if (Array.isArray(def)) {
    if (!Array.isArray(value) || value.some(v => typeof v !== 'string')) errors.push(`${path} must be a list of text`)
    return
  }
  if (typeof def === 'object') {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      errors.push(`${path} must be an object`)
      return
    }
    for (const key of Object.keys(def as object)) {
      sameShape((def as Record<string, unknown>)[key], (value as Record<string, unknown>)[key], `${path}.${key}`, errors)
    }
    return
  }
  if (typeof value !== typeof def) errors.push(`${path} must be a ${typeof def}`)
  else if (typeof value === 'number' && (!Number.isFinite(value) || value < 0)) errors.push(`${path} must be zero or more`)
}

/** Merges a partial update onto the current settings and validates the result. Throws with every problem found. */
export function mergeSettings(current: Settings, patch: unknown): Settings {
  if (typeof patch !== 'object' || patch === null) throw new Error('Settings update must be an object')
  const merged = structuredClone(current) as unknown as Record<string, unknown>
  for (const [key, value] of Object.entries(patch as Record<string, unknown>)) {
    if (!(key in DEFAULT_SETTINGS)) throw new Error(`Unknown setting: ${key}`)
    const def = (DEFAULT_SETTINGS as unknown as Record<string, unknown>)[key]
    merged[key] =
      def && typeof def === 'object' && !Array.isArray(def) && value && typeof value === 'object'
        ? { ...(merged[key] as object), ...(value as object) }
        : value
  }
  const s = merged as unknown as Settings
  const errors: string[] = []
  sameShape(DEFAULT_SETTINGS, s, 'settings', errors)
  if (errors.length === 0) {
    for (const t of [s.endOfDayTime, s.openingHours.weekday.open, s.openingHours.weekday.close, s.openingHours.weekend.open, s.openingHours.weekend.close]) {
      if (!TIME.test(t)) errors.push(`Time "${t}" must be HH:MM`)
    }
    for (const d of s.publicHolidays) if (!DATE.test(d)) errors.push(`Holiday "${d}" must be YYYY-MM-DD`)
    const prefixes = Object.values(s.bandPrefixes).map(p => p.trim().toUpperCase())
    if (prefixes.some(p => p === '')) errors.push('Band prefixes cannot be empty')
    if (prefixes.some((p, i) => prefixes.some((q, j) => i !== j && (p.startsWith(q) || q.startsWith(p))))) {
      errors.push('Band prefixes must not overlap')
    }
    if (s.capacity < 1) errors.push('Capacity must be at least 1')
    if (s.capacityWarnPercent > 100) errors.push('Capacity warning must be 100% or less')
    if (s.sessionMinutes < 1 || s.overtimeBlockMinutes < 1 || s.partyBlockMinutes < 1) errors.push('Session, block and party lengths must be at least 1 minute')
    if (s.packageVisits < 1 || !Number.isInteger(s.packageVisits)) errors.push('Package visits must be a whole number of at least 1')
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: s.timeZone })
    } catch {
      errors.push(`Unknown time zone: ${s.timeZone}`)
    }
  }
  if (errors.length) throw new Error(errors.join('; '))
  s.bandPrefixes = {
    adult: s.bandPrefixes.adult.trim().toUpperCase(),
    kid: s.bandPrefixes.kid.trim().toUpperCase(),
    under2: s.bandPrefixes.under2.trim().toUpperCase(),
  }
  return s
}

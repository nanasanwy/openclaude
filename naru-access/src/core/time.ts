export const MINUTE = 60_000
export const HOUR = 60 * MINUTE
export const DAY = 24 * HOUR

const formatters = new Map<string, Intl.DateTimeFormat>()

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone)
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
      weekday: 'short',
    })
    formatters.set(timeZone, f)
  }
  return f
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

export interface LocalParts {
  date: string // YYYY-MM-DD
  hour: number
  minute: number
  second: number
  weekday: number // 0 = Sunday
}

export function localParts(ms: number, timeZone: string): LocalParts {
  const parts: Record<string, string> = {}
  for (const p of formatter(timeZone).formatToParts(new Date(ms))) parts[p.type] = p.value
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
    weekday: WEEKDAYS.indexOf(parts.weekday!),
  }
}

/** Offset of `timeZone` from UTC at instant `ms`, in milliseconds. */
function zoneOffset(ms: number, timeZone: string): number {
  const p = localParts(ms, timeZone)
  const [y, m, d] = p.date.split('-').map(Number)
  const asUtc = Date.UTC(y!, m! - 1, d!, p.hour, p.minute, p.second)
  return asUtc - Math.floor(ms / 1000) * 1000
}

/** Converts a local wall-clock date ("2026-10-03") and time ("14:30") to epoch ms. */
export function localToMs(date: string, time: string, timeZone: string): number {
  const dm = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date)
  const tm = /^(\d{1,2}):(\d{2})$/.exec(time)
  if (!dm || !tm) throw new Error(`Invalid date/time: ${date} ${time}`)
  const guess = Date.UTC(+dm[1]!, +dm[2]! - 1, +dm[3]!, +tm[1]!, +tm[2]!)
  const first = guess - zoneOffset(guess, timeZone)
  // Second pass corrects for an offset change between the guess and the answer.
  return guess - zoneOffset(first, timeZone)
}

/** Start (inclusive) and end (exclusive) of a local calendar date, in epoch ms. */
export function dayBounds(date: string, timeZone: string): [number, number] {
  const start = localToMs(date, '00:00', timeZone)
  const next = new Date(Date.UTC(+date.slice(0, 4), +date.slice(5, 7) - 1, +date.slice(8, 10) + 1))
  const nextDate = next.toISOString().slice(0, 10)
  return [start, localToMs(nextDate, '00:00', timeZone)]
}

export type DayType = 'weekday' | 'weekend' | 'holiday'

export function dayType(ms: number, timeZone: string, publicHolidays: string[]): DayType {
  const p = localParts(ms, timeZone)
  if (publicHolidays.includes(p.date)) return 'holiday'
  return p.weekday === 0 || p.weekday === 6 ? 'weekend' : 'weekday'
}

export function formatLocal(ms: number, timeZone: string): string {
  const p = localParts(ms, timeZone)
  return `${p.date} ${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}:${String(p.second).padStart(2, '0')}`
}

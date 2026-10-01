import type { SimClock } from './core/clock.ts'
import type { Role } from './core/permissions.ts'
import type { AccessSystem } from './core/system.ts'
import { localParts, MINUTE } from './core/time.ts'

export const DEMO_STAFF: { role: Role; name: string; pin: string }[] = [
  { role: 'manager', name: 'Demo Manager', pin: '1111' },
  { role: 'cashier', name: 'Demo Cashier', pin: '2222' },
  { role: 'runner', name: 'Demo Runner', pin: '2223' },
  { role: 'receptionist', name: 'Demo Reception', pin: '3333' },
  { role: 'supervisor', name: 'Demo Supervisor', pin: '4444' },
  { role: 'events', name: 'Demo Events', pin: '5555' },
]

/**
 * Demo data for the simulator: one staff member per role, a party starting soon,
 * a package account, and two families already playing (one about to run over time).
 */
export function seedDemo(system: AccessSystem, clock: SimClock): void {
  system.ensureOwner('1000')
  const owner = system.login('1000').staff
  const ids: Record<string, ReturnType<AccessSystem['createStaff']>> = {}
  for (const s of DEMO_STAFF) ids[s.role] = system.createStaff(owner, s)
  const as = (role: Role) => ({ id: ids[role]!.id, name: ids[role]!.name, role })

  const start = clock.now()
  const tz = system.settings().timeZone
  const p = localParts(start + 30 * MINUTE, tz)
  const hhmm = `${String(p.hour).padStart(2, '0')}:${String(Math.floor(p.minute / 15) * 15).padStart(2, '0')}`
  system.createParty(as('events'), {
    name: 'Demo birthday party', room: 'Private Room A', date: p.date, startTime: hhmm,
    expectedGuests: 12, hostName: 'Demo Host', hostPhone: '0120000000', receiptNo: 'SH-DEMO-PARTY',
  })
  system.createPackage(as('cashier'), { name: 'Demo Package Family', phone: '0123334444', receiptNo: 'SH-DEMO-PKG' })

  // Families that entered earlier: one 2h50m ago (ends in 10 min), one 1 hour ago.
  const families: [number, string[]][] = [
    [170, ['A-900001', 'K-900001', 'K-900002']],
    [60, ['A-900011', 'A-900012', 'K-900011', 'U-900011']],
  ]
  for (const [minutesAgo, bands] of families) {
    clock.set(start - (minutesAgo + 5) * MINUTE)
    const g = system.createGroup(as('cashier'), { receiptNo: `SH-DEMO-${minutesAgo}`, tableNo: String((minutesAgo % 20) + 1) })
    for (const b of bands) system.addBand(as('cashier'), g.id, b)
    clock.set(start - minutesAgo * MINUTE)
    for (const b of bands) system.scan('in', b, 'sim')
  }
  clock.set(start)
}

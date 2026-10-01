import { SimClock } from '../src/core/clock.ts'
import type { Actor } from '../src/core/system.ts'
import { AccessSystem } from '../src/core/system.ts'
import { localToMs, MINUTE } from '../src/core/time.ts'
import { openDatabase } from '../src/db/database.ts'
import type { Role } from '../src/core/permissions.ts'

export const TZ = 'Asia/Kuala_Lumpur'

/** Local Kuala Lumpur time on Saturday 3 October 2026 (a weekend day). */
export function at(time: string, date = '2026-10-03'): number {
  return localToMs(date, time, TZ)
}

export function setup(start = at('12:00'), dbPath = ':memory:') {
  const clock = new SimClock(start)
  const system = new AccessSystem(openDatabase(dbPath), clock)
  system.ensureOwner('999999')
  const owner = system.login('999999').staff
  const staff: Record<string, Actor> = { owner }
  const roles: [Role, string][] = [
    ['manager', '111111'],
    ['cashier', '222222'],
    ['receptionist', '333333'],
    ['supervisor', '444444'],
    ['events', '555555'],
  ]
  for (const [role, pin] of roles) {
    const created = system.createStaff(owner, { name: `${role} person`, role, pin })
    staff[role] = { id: created.id, name: created.name, role }
  }
  return {
    clock,
    system,
    staff: staff as Record<'owner' | Role, Actor>,
    /** Sets the clock to a local time today. */
    time(t: string, date?: string) {
      clock.set(at(t, date))
    },
    advance(minutes: number) {
      clock.advance(minutes * MINUTE)
    },
  }
}

export type Env = ReturnType<typeof setup>

/** Creates a walk-in group and activates the given band barcodes at the cashier. */
export function walkIn(env: Env, barcodes: string[], receiptNo = 'SH-1001', tableNo = '12') {
  const group = env.system.createGroup(env.staff.cashier!, { receiptNo, tableNo })
  for (const code of barcodes) env.system.addBand(env.staff.cashier!, group.id, code)
  return group
}

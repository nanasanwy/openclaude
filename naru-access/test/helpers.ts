import jsQR from 'jsqr'
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

/** Renders a QR matrix to pixels (with quiet zone) and reads it back with an independent decoder. */
export function decodeQr(qr: { size: number; modules: boolean[][] } | { rows: string[] }, scale = 4): string | null {
  const modules = 'rows' in qr ? qr.rows.map(r => [...r].map(c => c === '1')) : qr.modules
  const border = 4
  const dim = (modules.length + border * 2) * scale
  const pixels = new Uint8ClampedArray(dim * dim * 4).fill(255)
  modules.forEach((row, y) =>
    row.forEach((dark, x) => {
      if (!dark) return
      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) {
          const i = (((y + border) * scale + dy) * dim + (x + border) * scale + dx) * 4
          pixels[i] = pixels[i + 1] = pixels[i + 2] = 0
        }
      }
    }),
  )
  return jsQR(pixels, dim, dim)?.data ?? null
}

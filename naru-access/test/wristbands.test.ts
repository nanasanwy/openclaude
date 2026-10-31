import { describe, expect, test } from 'bun:test'
import { DEFAULT_SETTINGS } from '../src/core/settings.ts'
import { sendToPrinter, wristbandZpl } from '../src/print/wristband.ts'
import { createApi } from '../src/server/api.ts'
import { at, decodeQr, setup } from './helpers.ts'

const CODE = /^(A|K|U)-[A-HJ-NP-Z2-9]{8}$/

describe('printed QR wristbands', () => {
  test('a sale creates the group and its wristbands in one step, with random codes', () => {
    const env = setup(at('11:55'))
    const group = env.system.createGroup(env.staff.cashier, { receiptNo: 'SH-501', tableNo: '7', wristbands: { adults: 2, kids: 3 } })
    expect(group.bands.map(b => b.type)).toEqual(['adult', 'adult', 'kid', 'kid', 'kid'])
    for (const b of group.bands) expect(b.barcode).toMatch(CODE)
    expect(new Set(group.bands.map(b => b.barcode)).size).toBe(5)
    // The printed codes work at the gate exactly like pre-printed bands.
    env.time('12:00')
    const [a1, , k1] = group.bands
    expect(env.system.scan('in', a1!.barcode).open).toBe(true)
    expect(env.system.scan('in', k1!.barcode).open).toBe(true)
    env.time('13:00')
    expect(env.system.scan('out', k1!.barcode).message).toBe('Adult must scan out first')
    expect(env.system.scan('out', a1!.barcode).open).toBe(true)
    expect(env.system.scan('out', k1!.barcode).open).toBe(true)
  })

  test('a group that does not fit is refused whole, and no package visit is used', () => {
    const env = setup()
    env.system.updateSettings(env.staff.manager, { capacity: 5 })
    env.system.createGroup(env.staff.cashier, { receiptNo: 'SH-1', wristbands: { adults: 1, kids: 2 } })
    const pkg = env.system.createPackage(env.staff.cashier, { name: 'Lee', phone: '0123456789', receiptNo: 'SH-P' })
    expect(() =>
      env.system.createGroup(env.staff.cashier, { tableNo: '2', packageAccountId: pkg.id, packageKids: 2, wristbands: { adults: 1, kids: 2 } }),
    ).toThrow(/Only 2 spaces left/)
    expect(env.system.getPackage(env.staff.cashier, pkg.id).visitsLeft).toBe(12)
    expect(env.system.capacity().occupancy).toBe(3)
  })

  test('party wristbands are printed by reception, not the cashier', () => {
    const env = setup(at('10:00'))
    const party = env.system.createParty(env.staff.events, {
      name: 'Party', room: 'Private Room A', date: '2026-10-03', startTime: '14:00', expectedGuests: 10, hostName: 'H', hostPhone: '0120000000',
    })
    expect(() => env.system.issueBands(env.staff.cashier, party.groupId, { adults: 1 })).toThrow(/not allowed/)
    const { bands } = env.system.issueBands(env.staff.receptionist, party.groupId, { adults: 2, kids: 4 })
    expect(bands).toHaveLength(6)
    expect(env.system.getParty(env.staff.receptionist, party.id).checkedIn.total).toBe(6)
    expect(() => env.system.issueBands(env.staff.receptionist, party.groupId, {})).toThrow(/how many/)
  })

  test('a damaged band is replaced: the new one carries on, the old one stops working', () => {
    const env = setup(at('11:55'))
    const { bands } = env.system.createGroup(env.staff.cashier, { receiptNo: 'SH-9', wristbands: { adults: 1, kids: 1 } })
    env.time('12:00')
    for (const b of bands) env.system.scan('in', b.barcode)
    const kid = bands[1]!.barcode
    expect(() => env.system.replaceBand(env.staff.cashier, kid, '')).toThrow(/reason/i)
    const r = env.system.replaceBand(env.staff.cashier, kid, 'Band torn at the ball pit')
    expect(r.barcode).toMatch(CODE)
    expect(r.type).toBe('kid')
    expect(env.system.capacity().inside).toBe(2) // the swap does not change the headcount
    env.time('13:00')
    expect(env.system.scan('out', bands[0]!.barcode).open).toBe(true)
    expect(env.system.scan('out', kid).message).toBe('Band not active')
    expect(env.system.scan('out', r.barcode).open).toBe(true)
  })
})

describe('Zebra wristband label (ZPL)', () => {
  const info = [
    { barcode: 'K-7F3K9Q2M', type: 'kid' as const, groupLabel: 'Table 12', dateLabel: 'Sat, 3 Oct' },
    { barcode: 'A-2B4C6D8E', type: 'adult' as const, groupLabel: 'Bad^name~here', dateLabel: 'Sat, 3 Oct' },
  ]
  const zpl = wristbandZpl(info, 'Naru Hartamas', DEFAULT_SETTINGS.wristbands)

  test('one label per band, sized to a 25 x 254 mm band at 300 dpi, with two QR codes each', () => {
    expect(zpl.match(/\^XA/g)).toHaveLength(2)
    expect(zpl.match(/\^XZ/g)).toHaveLength(2)
    expect(zpl).toContain('^PW295')
    expect(zpl).toContain('^LL3000')
    expect(zpl.match(/\^BQN,2,\d+\^FDMA,K-7F3K9Q2M\^FS/g)).toHaveLength(2)
    expect(zpl).toContain('^FDKID^FS')
    expect(zpl).toContain('^FDADULT^FS')
  })

  test('names cannot inject printer commands', () => {
    expect(zpl).toContain('Bad name here')
    expect(zpl).not.toContain('Bad^name')
  })

  test('everything lands on the band', () => {
    for (const m of zpl.matchAll(/\^FO(\d+),(\d+)(\^BQN,2,(\d+))?/g)) {
      const x = Number(m[1])
      const y = Number(m[2])
      expect(x).toBeLessThan(295)
      expect(y).toBeLessThan(3000)
      if (m[4]) expect(x + 21 * Number(m[4])).toBeLessThanOrEqual(295) // QR fits across the band
    }
  })

  test('is sent to a network printer, and a dead printer gives a clear message', async () => {
    let received = ''
    const printer = Bun.listen({
      hostname: '127.0.0.1',
      port: 0,
      socket: { data(_s, d) { received += d.toString() } },
    })
    await sendToPrinter('127.0.0.1', printer.port, zpl)
    await Bun.sleep(50)
    expect(received).toBe(zpl)
    const port = printer.port
    printer.stop(true)
    await expect(sendToPrinter('127.0.0.1', port, zpl, 1500)).rejects.toThrow(/127\.0\.0\.1/)
  })
})

describe('wristband API', () => {
  async function call(api: ReturnType<typeof createApi>, token: string, path: string, body: unknown) {
    const res = await api.handle(new Request(`http://x${path}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify(body) }))
    return { status: res.status, data: (await res.json()) as any }
  }

  test('browser printing returns each band with a QR that scans back to its code', async () => {
    const env = setup()
    const api = createApi({ system: env.system, laneKey: null })
    const token = env.system.login('222222').token
    const r = await call(api, token, '/api/groups', { receiptNo: 'SH-77', tableNo: '4', wristbands: { adults: 1, kids: 1 } })
    expect(r.status).toBe(200)
    expect(r.data.print).toMatchObject({ mode: 'browser', ok: true })
    for (const b of r.data.print.bands) expect(decodeQr({ rows: b.qr })).toBe(b.barcode)
    expect(r.data.print.bands[0]).toMatchObject({ type: 'adult', groupLabel: 'Table 4' })
  })

  test('Zebra printing sends ZPL; if the printer is down the bands still exist and can be reprinted', async () => {
    const env = setup()
    env.system.updateSettings(env.staff.manager, { wristbands: { printer: 'zebra', printerAddress: '192.168.1.50' } })
    const sent: string[] = []
    let printerUp = false
    const api = createApi({
      system: env.system,
      laneKey: null,
      sendZpl: async (address, port, zpl) => {
        if (!printerUp) throw new Error(`The wristband printer at ${address} did not answer.`)
        sent.push(`${address}:${port}\n${zpl}`)
      },
    })
    const token = env.system.login('222222').token
    const r = await call(api, token, '/api/groups', { receiptNo: 'SH-78', wristbands: { kids: 2 } })
    expect(r.data.print).toMatchObject({ mode: 'zebra', ok: false })
    expect(r.data.print.error).toContain('192.168.1.50')
    expect(r.data.bands).toHaveLength(2)
    printerUp = true
    const again = await call(api, token, '/api/wristbands/print', { barcodes: r.data.bands.map((b: any) => b.barcode) })
    expect(again.data).toMatchObject({ mode: 'zebra', ok: true })
    expect(sent[0]).toStartWith('192.168.1.50:9100\n^XA')
    expect(sent[0]!.match(/\^XA/g)).toHaveLength(2)
  })

  test('only a manager can print a test band, and it never opens the gate', async () => {
    const env = setup()
    const api = createApi({ system: env.system, laneKey: null })
    expect((await call(api, env.system.login('222222').token, '/api/wristbands/test', {})).status).toBe(403)
    const t = await call(api, env.system.login('111111').token, '/api/wristbands/test', {})
    expect(t.data.bands[0].barcode).toBe('K-TEST0000')
    expect(env.system.scan('in', 'K-TEST0000').message).toBe('Band not active')
  })
})

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { LaneController } from '../src/lane/controller.ts'
import { LogRelay } from '../src/lane/relay.ts'
import { createServer } from '../src/server/http.ts'
import { at, decodeQr, setup } from './helpers.ts'

const LANE_KEY = 'test-lane-key'
let env: ReturnType<typeof setup>
let server: ReturnType<typeof createServer>
let base = ''

async function api(path: string, opts: { method?: string; token?: string; body?: unknown; laneKey?: string } = {}) {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (opts.token) headers.authorization = `Bearer ${opts.token}`
  if (opts.laneKey) headers['x-lane-key'] = opts.laneKey
  const res = await fetch(base + path, { method: opts.method ?? (opts.body ? 'POST' : 'GET'), headers, body: opts.body ? JSON.stringify(opts.body) : undefined })
  const text = await res.text()
  let data: any = text
  try {
    data = JSON.parse(text)
  } catch {}
  return { status: res.status, data }
}

async function waitFor(check: () => boolean, ms = 3000) {
  const until = Date.now() + ms
  while (!check()) {
    if (Date.now() > until) throw new Error('timed out waiting')
    await Bun.sleep(20)
  }
}

beforeAll(() => {
  env = setup(at('11:00'))
  server = createServer({ system: env.system, port: 0, hostname: '127.0.0.1', publicDir: join(import.meta.dir, '..', 'public'), laneKey: LANE_KEY })
  base = `http://127.0.0.1:${server.port}`
})
afterAll(() => server.stop(true))

describe('HTTP API', () => {
  test('PIN login, role permissions, and wrong-PIN lockout', async () => {
    expect((await api('/api/login', { body: { pin: '0000' } })).status).toBe(401)
    const ok = await api('/api/login', { body: { pin: '222222' } })
    expect(ok.status).toBe(200)
    expect(ok.data.staff.role).toBe('cashier')
    expect(ok.data.permissions).toContain('walkin.activate')
    // A cashier cannot open the dashboard or settings.
    expect((await api('/api/dashboard', { token: ok.data.token })).status).toBe(403)
    expect((await api('/api/settings', { method: 'PUT', token: ok.data.token, body: { capacity: 10 } })).status).toBe(403)
    expect((await api('/api/dashboard')).status).toBe(401)
  })

  test('cashier activates, gate decides, lane displays receive the result', async () => {
    const cashier = (await api('/api/login', { body: { pin: '222222' } })).data.token
    const group = await api('/api/groups', { token: cashier, body: { receiptNo: 'SH-HTTP-1', tableNo: '4' } })
    expect(group.status).toBe(200)
    for (const barcode of ['a-555001', 'K-555001']) {
      const r = await api(`/api/groups/${group.data.id}/bands`, { token: cashier, body: { barcode } })
      expect(r.status).toBe(200)
    }
    const dup = await api(`/api/groups/${group.data.id}/bands`, { token: cashier, body: { barcode: 'A-555001' } })
    expect(dup).toMatchObject({ status: 409, data: { error: 'band_used' } })

    const display: any[] = []
    const ws = new WebSocket(`${base.replace('http', 'ws')}/ws?lane=in`)
    ws.onmessage = e => display.push(JSON.parse(String(e.data)))
    await waitFor(() => display.length > 0) // initial lane state

    expect((await api('/api/lanes/in/scan', { body: { barcode: 'A-555001' } })).status).toBe(401)
    const d = await api('/api/lanes/in/scan', { body: { barcode: 'A-555001' }, laneKey: LANE_KEY })
    expect(d.data).toMatchObject({ open: true, message: 'Enjoy!' })
    await waitFor(() => display.some(m => m.type === 'gate'))
    expect(display.find(m => m.type === 'gate').decision.barcode).toBe('A-555001')
    ws.close()
  })

  test('party e-invite returns a scannable QR of the invite code, for party staff only', async () => {
    const events = (await api('/api/login', { body: { pin: '555555' } })).data.token
    const party = await api('/api/parties', { token: events, body: {
      name: 'QR party', room: 'Private Room A', date: '2026-10-03', startTime: '14:00', expectedGuests: 10, hostName: 'Host', hostPhone: '0120000000',
    } })
    const reception = (await api('/api/login', { body: { pin: '333333' } })).data.token
    const invite = await api(`/api/parties/${party.data.id}/invite`, { token: reception })
    expect(invite.status).toBe(200)
    expect(invite.data.venueName).toBe('Naru Hartamas')
    expect(decodeQr(invite.data.qr)).toBe(party.data.inviteCode)
    const cashier = (await api('/api/login', { body: { pin: '222222' } })).data.token
    expect((await api(`/api/parties/${party.data.id}/invite`, { token: cashier })).status).toBe(403)
  })

  test('static files are served and paths cannot escape the public folder', async () => {
    expect((await fetch(`${base}/`)).status).toBe(200)
    expect((await fetch(`${base}/gate?lane=in`)).status).toBe(200)
    expect((await fetch(`${base}/..%2fpackage.json`)).status).toBe(404)
    expect((await fetch(`${base}/sim`)).status).toBe(404) // simulator is off
    expect((await api('/api/sim/state')).status).toBe(404)
  })
})

describe('Lane controller', () => {
  test('pulses the relay on an open decision and on a staff manual open', async () => {
    const relay = new LogRelay(true)
    const lane = new LaneController({ lane: 'out', server: base, laneKey: LANE_KEY, relay, log: () => {} })
    lane.start()
    await waitFor(() => lane.status === 'online')
    const supervisor = (await api('/api/login', { body: { pin: '444444' } })).data.token
    await api('/api/lanes/out/open', { token: supervisor, body: { reason: 'Bench test' } })
    await waitFor(() => relay.events.includes('pulse 500ms'))
    // A refused scan does not pulse.
    const before = relay.events.length
    expect((await lane.scan('K-555001'))?.open).toBe(false) // kid alone
    await Bun.sleep(100)
    expect(relay.events.length).toBe(before)
    lane.stop()
  })

  test('fire alarm holds the gate open; fail-safe opens it when the server is gone', async () => {
    const relay = new LogRelay(true)
    const lane = new LaneController({ lane: 'in', server: base, laneKey: LANE_KEY, relay, failOpenSeconds: 0.3, log: () => {} })
    lane.start()
    await waitFor(() => lane.status === 'online')
    await lane.reportFire(true)
    await waitFor(() => env.system.fireActive())
    expect(relay.events).toContain('hold open')
    await lane.reportFire(false)
    await waitFor(() => relay.events.at(-1) === 'release')

    server.stop(true) // the on-site PC dies
    await waitFor(() => lane.status === 'failsafe')
    expect(relay.events.at(-1)).toBe('hold open')
    lane.stop()
  })
})

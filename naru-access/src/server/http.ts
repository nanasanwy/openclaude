import type { Server, ServerWebSocket } from 'bun'
import { resolve, sep } from 'node:path'
import type { SimClock } from '../core/clock.ts'
import { permissionsFor, ROLE_LABELS, ROLES } from '../core/permissions.ts'
import { AccessSystem, AppError, type Actor, type ScanSource } from '../core/system.ts'
import { MINUTE } from '../core/time.ts'

export interface ServerOptions {
  system: AccessSystem
  port: number
  hostname?: string
  publicDir: string
  /** Shared secret the lane controllers send in the x-lane-key header. */
  laneKey: string | null
  /** Present only in simulator mode; enables /api/sim/* and the simulator page. */
  simClock?: SimClock
}

interface Ctx {
  req: Request
  url: URL
  params: Record<string, string>
  actor: Actor | null
  body: Record<string, unknown>
}

type Handler = (ctx: Ctx) => unknown | Promise<unknown>

interface SocketData {
  topics: string[]
}

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })

const csv = (body: string, filename: string) =>
  new Response(body, { headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="${filename}"` } })

function bearer(req: Request): string | null {
  const h = req.headers.get('authorization')
  return h?.startsWith('Bearer ') ? h.slice(7) : null
}

function needActor(ctx: Ctx): Actor {
  if (!ctx.actor) throw new AppError(401, 'login_required', 'Please log in')
  return ctx.actor
}

function id(ctx: Ctx, name = 'id'): number {
  const n = Number(ctx.params[name])
  if (!Number.isInteger(n) || n < 1) throw new AppError(400, 'bad_id', `Bad ${name}`)
  return n
}

/** Failed-PIN throttle per client address: 5 wrong PINs locks that device out for a minute. */
class LoginThrottle {
  private failures = new Map<string, { count: number; until: number }>()
  check(key: string): void {
    const f = this.failures.get(key)
    if (f && f.count >= 5 && Date.now() < f.until) throw new AppError(429, 'too_many_attempts', 'Too many wrong PINs. Wait a minute and try again.')
  }
  fail(key: string): void {
    const f = this.failures.get(key)
    const fresh = !f || Date.now() >= f.until
    this.failures.set(key, { count: fresh ? 1 : f!.count + 1, until: Date.now() + MINUTE })
  }
  succeed(key: string): void {
    this.failures.delete(key)
  }
}

export function createServer(opts: ServerOptions): Server<SocketData> {
  const { system, simClock } = opts
  const routes: { method: string; pattern: RegExp; keys: string[]; handler: Handler }[] = []
  const throttle = new LoginThrottle()

  const route = (method: string, path: string, handler: Handler) => {
    const keys: string[] = []
    const pattern = new RegExp(`^${path.replace(/:(\w+)/g, (_, k) => (keys.push(k), '([^/]+)'))}$`)
    routes.push({ method, pattern, keys, handler })
  }

  const laneAuthorized = (req: Request) => (opts.laneKey !== null && req.headers.get('x-lane-key') === opts.laneKey) || !!simClock

  // ------------------------------------------------------------ session
  route('POST', '/api/login', ({ req, body }) => {
    const key = server.requestIP(req)?.address ?? 'unknown'
    throttle.check(key)
    try {
      const result = system.login(body.pin)
      throttle.succeed(key)
      return { ...result, permissions: permissionsFor(result.staff.role) }
    } catch (err) {
      throttle.fail(key)
      throw err
    }
  })
  route('POST', '/api/logout', ({ req }) => {
    const token = bearer(req)
    if (token) system.logout(token)
    return { ok: true }
  })
  route('GET', '/api/me', ctx => {
    const actor = needActor(ctx)
    return { staff: actor, permissions: permissionsFor(actor.role) }
  })
  route('GET', '/api/meta', () => ({
    venueName: system.settings().venueName,
    timeZone: system.settings().timeZone,
    roles: ROLES.map(r => ({ id: r, label: ROLE_LABELS[r] })),
    sim: !!simClock,
    now: system.clock.now(),
  }))

  // ------------------------------------------------------------ settings & staff
  route('GET', '/api/settings', ctx => (needActor(ctx), system.settings()))
  route('PUT', '/api/settings', ctx => system.updateSettings(needActor(ctx), ctx.body))
  route('GET', '/api/staff', ctx => system.listStaff(needActor(ctx)))
  route('POST', '/api/staff', ctx => system.createStaff(needActor(ctx), ctx.body))
  route('PUT', '/api/staff/:id', ctx => system.updateStaff(needActor(ctx), id(ctx), ctx.body))

  // ------------------------------------------------------------ activation
  route('GET', '/api/capacity', ctx => (needActor(ctx), system.capacity()))
  route('POST', '/api/groups', ctx => system.createGroup(needActor(ctx), ctx.body))
  route('GET', '/api/groups/:id', ctx => system.groupDetail(needActor(ctx), id(ctx)))
  route('POST', '/api/groups/:id/bands', ctx => system.addBand(needActor(ctx), id(ctx), ctx.body.barcode, ctx.body.type))
  route('POST', '/api/groups/:id/clear', ctx => system.clearGroup(needActor(ctx), id(ctx), ctx.body))
  route('POST', '/api/groups/:id/extend', ctx => system.extendGroup(needActor(ctx), id(ctx), ctx.body.minutes, ctx.body.reason))
  route('POST', '/api/groups/:id/close', ctx => (system.closeGroup(needActor(ctx), id(ctx), ctx.body.reason), { ok: true }))
  route('POST', '/api/bands/:barcode/void', ctx => (system.voidBand(needActor(ctx), ctx.params.barcode, ctx.body.reason), { ok: true }))
  route('POST', '/api/bands/:barcode/release', ctx => system.releaseBand(needActor(ctx), ctx.params.barcode, String(ctx.body.lane), ctx.body.reason))

  // ------------------------------------------------------------ parties
  route('GET', '/api/parties', ctx => system.listParties(needActor(ctx), ctx.url.searchParams.get('date')))
  route('POST', '/api/parties', ctx => system.createParty(needActor(ctx), ctx.body))
  route('GET', '/api/parties/by-code/:code', ctx => system.findPartyByCode(needActor(ctx), ctx.params.code))
  route('GET', '/api/parties/:id', ctx => system.getParty(needActor(ctx), id(ctx)))
  route('PUT', '/api/parties/:id', ctx => system.updateParty(needActor(ctx), id(ctx), ctx.body))

  // ------------------------------------------------------------ packages
  route('GET', '/api/packages', ctx => system.findPackages(needActor(ctx), ctx.url.searchParams.get('phone')))
  route('POST', '/api/packages', ctx => system.createPackage(needActor(ctx), ctx.body))
  route('GET', '/api/packages/:id', ctx => system.getPackage(needActor(ctx), id(ctx)))
  route('POST', '/api/packages/:id/deduct', ctx => system.deductVisits(needActor(ctx), id(ctx), ctx.body.kids, ctx.body.groupId))
  route('POST', '/api/packages/:id/transfer', ctx => system.transferPackage(needActor(ctx), id(ctx), ctx.body))

  // ------------------------------------------------------------ gate
  route('POST', '/api/lanes/:lane/scan', ctx => {
    const source = (ctx.body.source as ScanSource) ?? 'reader'
    if (source === 'handheld') return system.scan(ctx.params.lane!, ctx.body.barcode, 'handheld', needActor(ctx))
    if (!laneAuthorized(ctx.req)) throw new AppError(401, 'lane_key', 'Lane key required')
    return system.scan(ctx.params.lane!, ctx.body.barcode, simClock ? 'sim' : 'reader')
  })
  route('POST', '/api/lanes/:lane/open', ctx => system.manualOpen(needActor(ctx), ctx.params.lane!, ctx.body.reason))
  route('POST', '/api/lanes/:lane/mode', ctx => system.setLaneMode(needActor(ctx), ctx.params.lane!, ctx.body.mode, ctx.body.reason))
  route('GET', '/api/lanes', () => ({ lanes: system.laneStates(), fire: system.fireActive() }))
  route('POST', '/api/system/fire', ctx => {
    if (laneAuthorized(ctx.req)) system.setFireAlarm(Boolean(ctx.body.active), String(ctx.body.source ?? 'lane controller'))
    else system.setFireAlarm(Boolean(ctx.body.active), 'staff', needActor(ctx))
    return { fire: system.fireActive() }
  })

  // ------------------------------------------------------------ dashboard & reports
  route('GET', '/api/dashboard', ctx => system.dashboard(needActor(ctx)))
  route('GET', '/api/reports/daily', ctx => system.dailyReport(needActor(ctx), ctx.url.searchParams.get('date')))
  route('GET', '/api/reports/daily.csv', ctx => {
    const date = ctx.url.searchParams.get('date')
    return csv(system.dailyReportCsv(needActor(ctx), date), `naru-daily-${date ?? 'today'}.csv`)
  })
  route('GET', '/api/reports/scans.csv', ctx => {
    const date = ctx.url.searchParams.get('date')
    return csv(system.scansCsv(needActor(ctx), date), `naru-scans-${date ?? 'today'}.csv`)
  })
  route('GET', '/api/export', ctx => {
    const data = system.exportAll(needActor(ctx))
    return new Response(JSON.stringify(data, null, 2), {
      headers: { 'content-type': 'application/json', 'content-disposition': `attachment; filename="naru-export-${new Date().toISOString().slice(0, 10)}.json"` },
    })
  })
  route('GET', '/api/audit/verify', ctx => {
    needActor(ctx)
    return system.verifyAuditChain()
  })

  // ------------------------------------------------------------ simulator
  if (simClock) {
    route('GET', '/api/sim/state', () => ({ now: simClock.now(), bands: system.simBands(), lanes: system.laneStates(), fire: system.fireActive() }))
    route('POST', '/api/sim/clock', ({ body }) => {
      if (typeof body.advanceMinutes === 'number') simClock.advance(body.advanceMinutes * MINUTE)
      if (typeof body.set === 'number') simClock.set(body.set)
      system.tick()
      return { now: simClock.now() }
    })
    route('POST', '/api/sim/family', ({ body }) => {
      // Acts as the first owner account, which exists in every database.
      const owner = system.db.query<Actor, []>(`SELECT id, name, role FROM staff WHERE role = 'owner' AND active = 1 ORDER BY id LIMIT 1`).get()
      if (!owner) throw new AppError(409, 'no_owner', 'No owner account')
      const adults = Math.min(6, Math.max(0, Number(body.adults ?? 1)))
      const kids = Math.min(8, Math.max(0, Number(body.kids ?? 2)))
      const group = system.createGroup(owner, { receiptNo: `SIM-${Date.now() % 100000}`, tableNo: String(1 + Math.floor(Math.random() * 30)) })
      const prefixes = system.settings().bandPrefixes
      const make = (prefix: string) => {
        for (;;) {
          const code = `${prefix}${String(Math.floor(Math.random() * 1e6)).padStart(6, '0')}`
          try {
            return system.addBand(owner, group.id, code).band.barcode
          } catch (err) {
            if (!(err instanceof AppError && err.code === 'band_used')) throw err
          }
        }
      }
      const bands = [...Array.from({ length: adults }, () => make(prefixes.adult)), ...Array.from({ length: kids }, () => make(prefixes.kid))]
      return { groupId: group.id, bands }
    })
    route('POST', '/api/sim/fire', ({ body }) => {
      system.setFireAlarm(Boolean(body.active), 'simulator')
      return { fire: system.fireActive() }
    })
  }

  const handleApi = async (req: Request, url: URL): Promise<Response> => {
    for (const r of routes) {
      if (r.method !== req.method) continue
      const m = r.pattern.exec(url.pathname)
      if (!m) continue
      const params: Record<string, string> = {}
      r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1]!)))
      let body: Record<string, unknown> = {}
      if (req.method !== 'GET' && req.headers.get('content-type')?.includes('application/json')) {
        try {
          const parsed = await req.json()
          if (parsed && typeof parsed === 'object') body = parsed as Record<string, unknown>
        } catch {
          return json({ error: 'bad_json', message: 'Request body is not valid JSON' }, 400)
        }
      }
      try {
        const result = await r.handler({ req, url, params, body, actor: system.authenticate(bearer(req)) })
        return result instanceof Response ? result : json(result)
      } catch (err) {
        if (err instanceof AppError) return json({ error: err.code, message: err.message }, err.status)
        console.error(err)
        return json({ error: 'server_error', message: 'Something went wrong. It has been logged.' }, 500)
      }
    }
    return json({ error: 'not_found', message: 'No such API route' }, 404)
  }

  const publicRoot = resolve(opts.publicDir)
  const notFound = () => new Response('Not found', { status: 404 })
  const serveStatic = async (url: URL): Promise<Response> => {
    const aliases: Record<string, string> = { '/': '/index.html', '/gate': '/gate.html', '/sim': '/sim.html' }
    const path = aliases[url.pathname] ?? url.pathname
    if (path === '/sim.html' && !simClock) return notFound()
    const file = resolve(publicRoot, `.${decodeURIComponent(path)}`)
    if (!file.startsWith(publicRoot + sep)) return notFound()
    const f = Bun.file(file)
    return (await f.exists()) ? new Response(f) : notFound()
  }

  const server: Server<SocketData> = Bun.serve<SocketData>({
    port: opts.port,
    hostname: opts.hostname,
    async fetch(req, srv) {
      const url = new URL(req.url)
      if (url.pathname === '/ws') {
        // Gate displays and lane controllers subscribe by lane; staff screens need a login.
        const lane = url.searchParams.get('lane')
        const topics: string[] = []
        if (lane === 'in' || lane === 'out') topics.push(`lane:${lane}`)
        else if (system.authenticate(url.searchParams.get('token'))) topics.push('staff')
        else if (simClock && url.searchParams.get('sim') === '1') topics.push('staff') // staff already receives every lane event
        else return new Response('Unauthorized', { status: 401 })
        return srv.upgrade(req, { data: { topics } }) ? undefined : new Response('Upgrade failed', { status: 400 })
      }
      if (url.pathname.startsWith('/api/')) return handleApi(req, url)
      return serveStatic(url)
    },
    websocket: {
      open(ws: ServerWebSocket<SocketData>) {
        for (const t of ws.data.topics) ws.subscribe(t)
        // Tell a newly connected lane controller or display the current gate state.
        ws.send(JSON.stringify({ type: 'lane', lanes: system.laneStates(), fire: system.fireActive() }))
      },
      message() {
        // Clients only listen. Scans go through the HTTP API so every one is authenticated.
      },
    },
  })

  system.onEvent(e => {
    const msg = JSON.stringify(e)
    if (e.type === 'gate') server.publish(`lane:${e.lane}`, msg)
    if (e.type === 'lane') for (const l of e.lanes) server.publish(`lane:${l.lane}`, msg)
    server.publish('staff', msg)
  })

  return server
}

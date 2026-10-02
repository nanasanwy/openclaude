import type { Server, ServerWebSocket } from 'bun'
import { resolve, sep } from 'node:path'
import type { SimClock } from '../core/clock.ts'
import type { AccessSystem } from '../core/system.ts'
import { createApi } from './api.ts'

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

interface SocketData {
  topics: string[]
}

export function createServer(opts: ServerOptions): Server<SocketData> {
  const { system, simClock } = opts
  const api = createApi({ system, laneKey: opts.laneKey, simClock, clientKey: req => server.requestIP(req)?.address ?? 'unknown' })

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
        const topics = api.socketTopics(url)
        if (!topics) return new Response('Unauthorized', { status: 401 })
        return srv.upgrade(req, { data: { topics } }) ? undefined : new Response('Upgrade failed', { status: 400 })
      }
      if (url.pathname.startsWith('/api/')) return api.handle(req)
      return serveStatic(url)
    },
    websocket: {
      open(ws: ServerWebSocket<SocketData>) {
        for (const t of ws.data.topics) ws.subscribe(t)
        ws.send(api.hello())
      },
      message() {
        // Clients only listen. Scans go through the HTTP API so every one is authenticated.
      },
    },
  })

  system.onEvent(e => {
    const msg = JSON.stringify(e)
    for (const topic of api.eventTopics(e)) server.publish(topic, msg)
  })

  return server
}

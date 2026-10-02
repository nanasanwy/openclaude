/**
 * Browser test drive: the real access system (rules, database schema, API) running inside the
 * page with simulated time and test data. Staff screens in iframes reach it through demo-bridge.js.
 */
import { SimClock } from '../core/clock.ts'
import { AccessSystem } from '../core/system.ts'
import { localParts, localToMs, MINUTE } from '../core/time.ts'
import { openDatabase } from '../db/database.ts'
import { seedDemo } from '../seed.ts'
import { createApi } from '../server/api.ts'
import { useSqlJs, type Database } from './sqlite-shim.ts'

const SAVE_KEY = 'naru-demo-v1'
const TZ = 'Asia/Kuala_Lumpur'

interface Saved {
  db: string // base64
  now: number
}

function load(): Saved | null {
  try {
    const raw = localStorage.getItem(SAVE_KEY)
    return raw ? (JSON.parse(raw) as Saved) : null
  } catch {
    return null
  }
}

const toBase64 = (bytes: Uint8Array) => {
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(s)
}
const fromBase64 = (b64: string) => Uint8Array.from(atob(b64), c => c.charCodeAt(0))

export function startDemo(sqlJs: unknown) {
  const saved = load()
  let bytes: Uint8Array | null = null
  try {
    bytes = saved ? fromBase64(saved.db) : null
  } catch {
    bytes = null
  }
  useSqlJs(sqlJs, bytes)
  const today = localParts(Date.now(), TZ).date
  const clock = new SimClock(bytes && saved ? saved.now : localToMs(today, '11:00', TZ), true)
  const db = openDatabase(':memory:')
  const system = new AccessSystem(db, clock)
  if (!bytes) seedDemo(system, clock)

  const api = createApi({ system, laneKey: null, simClock: clock, clientKey: () => 'test-drive' })
  const sockets = new Set<{ topics: string[]; send: (msg: string) => void }>()

  let saveTimer: ReturnType<typeof setTimeout> | null = null
  let stopped = false
  const save = () => {
    if (stopped) return
    try {
      const data: Saved = { db: toBase64((db as unknown as Database).serialize()), now: clock.now() }
      localStorage.setItem(SAVE_KEY, JSON.stringify(data))
    } catch {
      // Private windows and blocked storage: the test drive still works, it just starts fresh next time.
    }
  }
  system.onEvent(e => {
    const msg = JSON.stringify(e)
    const topics = api.eventTopics(e)
    for (const s of sockets) if (s.topics.some(t => topics.includes(t))) s.send(msg)
    if (e.type === 'changed') {
      if (saveTimer) clearTimeout(saveTimer)
      saveTimer = setTimeout(save, 800)
    }
  })
  setInterval(() => system.tick(), 30_000)
  setInterval(save, 60_000) // keeps the simulated time when nothing else changes

  return {
    /** fetch() for /api/* paths, answered by the in-page system. */
    async fetch(path: string, init: RequestInit = {}): Promise<Response> {
      const res = await api.handle(new Request(`https://naru.test${path}`, init))
      return res
    },
    /** A live-update connection like /ws?query. Returns a closer, or null if refused. */
    connect(query: string, onMessage: (data: string) => void): (() => void) | null {
      const topics = api.socketTopics(new URL(`https://naru.test/ws?${query}`))
      if (!topics) return null
      const socket = { topics, send: onMessage }
      sockets.add(socket)
      setTimeout(() => onMessage(api.hello()), 0)
      return () => sockets.delete(socket)
    },
    reset() {
      stopped = true
      try {
        localStorage.removeItem(SAVE_KEY)
      } catch {
        // nothing saved
      }
    },
    nowMs: () => clock.now(),
    advanceMinutes(m: number) {
      clock.advance(m * MINUTE)
      system.tick()
    },
  }
}

;(globalThis as unknown as { NaruDemo: unknown }).NaruDemo = { startDemo }

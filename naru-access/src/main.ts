#!/usr/bin/env bun
/**
 * Naru access server. Runs on the on-site PC; staff tablets, gate displays and lane
 * controllers connect to it over the venue network. No internet connection is needed.
 *
 *   bun run src/main.ts                 production
 *   bun run src/main.ts --sim --seed    simulator with demo staff and data
 */
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { backupDatabase, copyOffsite } from './backup.ts'
import { SimClock, systemClock } from './core/clock.ts'
import { AccessSystem } from './core/system.ts'
import { localParts, localToMs, MINUTE } from './core/time.ts'
import { openDatabase } from './db/database.ts'
import { DEMO_STAFF, seedDemo } from './seed.ts'
import { createServer } from './server/http.ts'

const { values: args } = parseArgs({
  options: {
    port: { type: 'string', default: process.env.NARU_PORT ?? '8080' },
    host: { type: 'string', default: process.env.NARU_HOST ?? '0.0.0.0' },
    data: { type: 'string', default: process.env.NARU_DATA_DIR ?? './data' },
    sim: { type: 'boolean', default: false },
    seed: { type: 'boolean', default: false },
    'sim-start': { type: 'string', default: '11:00' },
  },
})

const dataDir = resolve(args.data!)
mkdirSync(dataDir, { recursive: true })
const dbFile = join(dataDir, args.sim ? 'sim.db' : 'naru.db')

if (args.sim) {
  // The simulator always starts from a clean database so demos are repeatable.
  for (const suffix of ['', '-wal', '-shm']) rmSync(dbFile + suffix, { force: true })
}

const db = openDatabase(dbFile)
let simClock: SimClock | undefined
if (args.sim) {
  const today = localParts(Date.now(), 'Asia/Kuala_Lumpur').date
  simClock = new SimClock(localToMs(today, args['sim-start']!, 'Asia/Kuala_Lumpur'), true)
}
const system = new AccessSystem(db, simClock ?? systemClock)

if (args.sim && args.seed && simClock) {
  seedDemo(system, simClock)
  console.log('\n  Demo PINs: Owner 1000 · ' + DEMO_STAFF.map(s => `${s.name.replace('Demo ', '')} ${s.pin}`).join(' · ') + '\n')
} else {
  const pin = system.ensureOwner(process.env.NARU_OWNER_PIN)
  if (pin) {
    console.log('\n  First start: created the Owner account.')
    console.log(`  Owner PIN: ${pin}   (log in and change it under Staff)\n`)
  }
}

const laneKeyFile = join(dataDir, 'lane-key.txt')
let laneKey = process.env.NARU_LANE_KEY ?? null
if (!laneKey) {
  if (!existsSync(laneKeyFile)) writeFileSync(laneKeyFile, randomBytes(16).toString('hex'), { mode: 0o600 })
  laneKey = readFileSync(laneKeyFile, 'utf8').trim()
}

const server = createServer({
  system,
  port: Number(args.port),
  hostname: args.host,
  publicDir: publicDir(),
  laneKey,
  simClock,
})

/** Source checkout: ../public. Compiled single executable: a public/ folder next to the executable. */
function publicDir(): string {
  if (process.env.NARU_PUBLIC_DIR) return resolve(process.env.NARU_PUBLIC_DIR)
  const source = join(import.meta.dir, '..', 'public')
  return existsSync(source) ? source : join(dirname(process.execPath), 'public')
}

const backupDir = join(dataDir, 'backups')
async function housekeeping() {
  try {
    system.tick()
    if (args.sim) return
    const file = backupDatabase(db, backupDir, localParts(Date.now(), system.settings().timeZone).date)
    if (file) {
      console.log(`Backup written: ${file}`)
      if (process.env.NARU_BACKUP_COMMAND) {
        const ok = await copyOffsite(process.env.NARU_BACKUP_COMMAND, file)
        console.log(ok ? 'Off-site copy done' : 'Off-site copy FAILED (will retry with tomorrow\'s backup)')
      }
    }
  } catch (err) {
    console.error('Housekeeping failed', err)
  }
}
void housekeeping()
const timer = setInterval(housekeeping, MINUTE)

const base = `http://localhost:${server.port}`
console.log(`Naru access system running${args.sim ? ' in SIMULATOR mode' : ''}`)
console.log(`  Staff screens:  ${base}/`)
console.log(`  Gate displays:  ${base}/gate?lane=in   ${base}/gate?lane=out`)
if (args.sim) console.log(`  Simulator:      ${base}/sim`)
else console.log(`  Lane key:       stored in ${laneKeyFile}`)

function shutdown() {
  clearInterval(timer)
  server.stop()
  db.close()
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

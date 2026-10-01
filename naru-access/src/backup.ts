import type { Database } from 'bun:sqlite'
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Writes a consistent snapshot of the live database (safe while the gates are running)
 * and keeps the newest `keep` snapshots. Returns the snapshot path, or null if today's exists.
 */
export function backupDatabase(db: Database, dir: string, date: string, keep = 60, force = false): string | null {
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `naru-${date}.db`)
  if (existsSync(file)) {
    if (!force) return null
    rmSync(file)
  }
  db.query('VACUUM INTO ?').run(file)
  const snapshots = readdirSync(dir).filter(f => /^naru-\d{4}-\d{2}-\d{2}\.db$/.test(f)).sort()
  for (const old of snapshots.slice(0, Math.max(0, snapshots.length - keep))) rmSync(join(dir, old))
  return file
}

/** Runs the optional off-site copy command, e.g. `rclone copy {file} gdrive:naru-backups`. */
export async function copyOffsite(command: string, file: string): Promise<boolean> {
  const proc = Bun.spawn(['sh', '-c', command.replaceAll('{file}', `'${file.replaceAll("'", "'\\''")}'`)], { stdout: 'inherit', stderr: 'inherit' })
  return (await proc.exited) === 0
}

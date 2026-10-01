/** Manual backup: bun run backup [--data ./data] */
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { backupDatabase, copyOffsite } from '../src/backup.ts'
import { openDatabase } from '../src/db/database.ts'

const { values } = parseArgs({ options: { data: { type: 'string', default: process.env.NARU_DATA_DIR ?? './data' } } })
const dataDir = resolve(values.data!)
const db = openDatabase(join(dataDir, 'naru.db'))
const file = backupDatabase(db, join(dataDir, 'backups'), new Date().toISOString().slice(0, 10), 60, true)!
console.log(`Backup written: ${file}`)
if (process.env.NARU_BACKUP_COMMAND) process.exit((await copyOffsite(process.env.NARU_BACKUP_COMMAND, file)) ? 0 : 1)

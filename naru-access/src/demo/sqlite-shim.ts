/**
 * The subset of bun:sqlite the access system uses, implemented on sql.js so the unchanged
 * system code runs in a browser for the test drive. Never used on the venue PC.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
let SQL: any = null
let nextBytes: Uint8Array | null = null

/** Hands over the loaded sql.js module, and optionally a saved database for the next open. */
export function useSqlJs(module: any, savedBytes: Uint8Array | null = null): void {
  SQL = module
  nextBytes = savedBytes
}

type Param = string | number | null
const norm = (params: unknown[]): Param[] =>
  params.map(p => (p === undefined ? null : typeof p === 'boolean' ? (p ? 1 : 0) : (p as Param)))

class Statement {
  constructor(
    private db: Database,
    private sql: string,
  ) {}

  private with<T>(params: unknown[], fn: (s: any) => T): T {
    const s = this.db.prepared(this.sql)
    try {
      s.bind(norm(params))
      return fn(s)
    } finally {
      s.reset()
    }
  }

  get(...params: unknown[]): any {
    return this.with(params, s => (s.step() ? s.getAsObject() : null))
  }

  all(...params: unknown[]): any[] {
    return this.with(params, s => {
      const rows: any[] = []
      while (s.step()) rows.push(s.getAsObject())
      return rows
    })
  }

  run(...params: unknown[]): { changes: number; lastInsertRowid: number } {
    this.with(params, s => {
      while (s.step()) {
        // drain
      }
    })
    const raw = this.db.raw
    const id = raw.exec('SELECT last_insert_rowid() AS id')[0]?.values[0]?.[0] ?? 0
    return { changes: raw.getRowsModified(), lastInsertRowid: Number(id) }
  }
}

export class Database {
  readonly raw: any
  private cache = new Map<string, any>()
  private depth = 0

  constructor(_path?: string, _opts?: unknown) {
    if (!SQL) throw new Error('sql.js is not loaded')
    this.raw = nextBytes ? new SQL.Database(nextBytes) : new SQL.Database()
    nextBytes = null
  }

  prepared(sql: string): any {
    let s = this.cache.get(sql)
    if (!s) {
      s = this.raw.prepare(sql)
      this.cache.set(sql, s)
    }
    return s
  }

  query(sql: string): Statement {
    return new Statement(this, sql)
  }

  exec(sql: string): void {
    this.raw.exec(sql)
  }

  transaction<A extends unknown[], T>(fn: (...args: A) => T): (...args: A) => T {
    return (...args: A) => {
      const sp = `sp${this.depth}`
      this.raw.exec(this.depth === 0 ? 'BEGIN' : `SAVEPOINT ${sp}`)
      this.depth++
      try {
        const result = fn(...args)
        this.depth--
        this.raw.exec(this.depth === 0 ? 'COMMIT' : `RELEASE ${sp}`)
        return result
      } catch (err) {
        this.depth--
        this.raw.exec(this.depth === 0 ? 'ROLLBACK' : `ROLLBACK TO ${sp}; RELEASE ${sp}`)
        throw err
      }
    }
  }

  /** The whole database as bytes, for saving the test drive between visits. */
  serialize(): Uint8Array {
    // sql.js frees every prepared statement when it exports.
    this.cache.clear()
    const bytes = this.raw.export()
    this.raw.exec('PRAGMA foreign_keys = ON')
    return bytes
  }

  close(): void {
    this.cache.clear()
    this.raw.close()
  }
}

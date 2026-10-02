import { describe, expect, test } from 'bun:test'
import * as nodeCrypto from 'node:crypto'
import * as shim from '../src/demo/crypto-shim.ts'

// The browser test drive swaps node:crypto for this shim; PIN logins and the audit chain depend on it matching.
describe('browser crypto shim', () => {
  const samples = ['', 'abc', '246810', 'x'.repeat(55), 'y'.repeat(56), 'z'.repeat(64), 'Parti hari jadi — 6 tahun', 'q'.repeat(1000)]
  test('SHA-256 matches node:crypto', () => {
    for (const s of samples) expect(shim.createHash('sha256').update(s).digest('hex')).toBe(nodeCrypto.createHash('sha256').update(s).digest('hex'))
  })
  test('HMAC-SHA-256 matches node:crypto, including long keys', () => {
    for (const key of ['k', 'a'.repeat(64), 'b'.repeat(100), nodeCrypto.randomBytes(32).toString('hex')]) {
      for (const s of samples) expect(shim.createHmac('sha256', key).update(s).digest('hex')).toBe(nodeCrypto.createHmac('sha256', key).update(s).digest('hex'))
    }
  })
  test('random helpers stay in range', () => {
    expect(shim.randomBytes(24).toString('hex')).toMatch(/^[0-9a-f]{48}$/)
    for (let i = 0; i < 200; i++) {
      const n = shim.randomInt(100000, 1000000)
      expect(n >= 100000 && n < 1000000).toBe(true)
      expect(shim.randomInt(31)).toBeLessThan(31)
    }
  })
})

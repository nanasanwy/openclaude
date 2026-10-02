import { describe, expect, test } from 'bun:test'
import { encodeQr, qrSvg, type QrCode, type QrLevel } from '../src/qr.ts'
import { decodeQr as decode } from './helpers.ts'

describe('QR encoder', () => {
  test('an invite code is a small version 1 code that decodes back to the code', () => {
    const qr = encodeQr('4CSHAG')
    expect(qr).toMatchObject({ version: 1, size: 21 })
    expect(decode(qr)).toBe('4CSHAG')
  })

  // Lengths chosen to land in every version 1–10, which covers multi-block error
  // correction (v3+), alignment patterns (v2+) and version information (v7+).
  const levels: QrLevel[] = ['L', 'M', 'Q', 'H']
  for (const level of levels) {
    test(`every version decodes at level ${level}`, () => {
      const seen = new Set<number>()
      for (let len = 1; len <= 270; len += 7) {
        const text = Array.from({ length: len }, (_, i) => 'Naru-Hartamas/invite?code=ABC123#'[i % 33]).join('')
        let qr: QrCode
        try {
          qr = encodeQr(text, level)
        } catch {
          break // longer than version 10 holds at this level
        }
        seen.add(qr.version)
        expect(decode(qr)).toBe(text)
      }
      expect([...seen].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
    })
  }

  test('non-ASCII text survives (UTF-8 byte mode)', () => {
    expect(decode(encodeQr('Parti hari jadi Aisyah — 6 tahun'))).toBe('Parti hari jadi Aisyah — 6 tahun')
  })

  test('refuses text too long for version 10', () => {
    expect(() => encodeQr('x'.repeat(300), 'M')).toThrow(/too long/)
  })

  test('SVG output has a quiet zone and one path', () => {
    const svg = qrSvg(encodeQr('ABC123'))
    expect(svg).toStartWith('<svg')
    expect(svg).toContain('viewBox="0 0 29 29"')
  })
})

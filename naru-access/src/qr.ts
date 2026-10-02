/**
 * QR code encoder (ISO/IEC 18004, byte mode, versions 1–10), so e-invites need no third-party library.
 * Version 10 at level M holds 213 bytes, far more than an invite code or link needs.
 * test/qr.test.ts decodes every output with an independent decoder (jsQR).
 */

export type QrLevel = 'L' | 'M' | 'Q' | 'H'

export interface QrCode {
  version: number
  size: number
  /** modules[y][x], true = dark. */
  modules: boolean[][]
}

const LEVEL_INDEX: Record<QrLevel, number> = { L: 0, M: 1, Q: 2, H: 3 }
const FORMAT_BITS: Record<QrLevel, number> = { L: 1, M: 0, Q: 3, H: 2 }
const MAX_VERSION = 10

// Indexed [level][version]; index 0 is unused. From the QR specification, table 9.
const ECC_PER_BLOCK = [
  [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18],
  [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26],
  [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24],
  [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28],
]
const ECC_BLOCKS = [
  [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4],
  [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5],
  [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8],
  [-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8],
]

/** Modules available for data and error correction (everything except function patterns). */
function rawDataModules(ver: number): number {
  let n = (16 * ver + 128) * ver + 64
  if (ver >= 2) {
    const align = Math.floor(ver / 7) + 2
    n -= (25 * align - 10) * align - 55
    if (ver >= 7) n -= 36
  }
  return n
}

function dataCodewords(ver: number, level: QrLevel): number {
  const l = LEVEL_INDEX[level]
  return Math.floor(rawDataModules(ver) / 8) - ECC_PER_BLOCK[l]![ver]! * ECC_BLOCKS[l]![ver]!
}

// ---------------------------------------------------------------- Reed–Solomon over GF(2^8), polynomial 0x11D

function gfMul(x: number, y: number): number {
  let z = 0
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d)
    z ^= ((y >>> i) & 1) * x
  }
  return z
}

function rsDivisor(degree: number): number[] {
  const result = new Array<number>(degree).fill(0)
  result[degree - 1] = 1
  let root = 1
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < result.length; j++) {
      result[j] = gfMul(result[j]!, root)
      if (j + 1 < result.length) result[j]! ^= result[j + 1]!
    }
    root = gfMul(root, 0x02)
  }
  return result
}

function rsRemainder(data: number[], divisor: number[]): number[] {
  const result = new Array<number>(divisor.length).fill(0)
  for (const b of data) {
    const factor = b ^ result.shift()!
    result.push(0)
    divisor.forEach((coef, i) => (result[i]! ^= gfMul(coef, factor)))
  }
  return result
}

// ---------------------------------------------------------------- encoding

function encodeData(bytes: Uint8Array, ver: number, level: QrLevel): number[] {
  const bits: number[] = []
  const push = (value: number, len: number) => {
    for (let i = len - 1; i >= 0; i--) bits.push((value >>> i) & 1)
  }
  push(0b0100, 4) // byte mode
  push(bytes.length, ver <= 9 ? 8 : 16)
  for (const b of bytes) push(b, 8)
  const capacity = dataCodewords(ver, level) * 8
  push(0, Math.min(4, capacity - bits.length)) // terminator
  push(0, (8 - (bits.length % 8)) % 8)
  const codewords: number[] = []
  for (let i = 0; i < bits.length; i += 8) codewords.push(parseInt(bits.slice(i, i + 8).join(''), 2))
  for (let pad = 0xec; codewords.length < capacity / 8; pad ^= 0xec ^ 0x11) codewords.push(pad)
  return codewords
}

function addEccAndInterleave(data: number[], ver: number, level: QrLevel): number[] {
  const l = LEVEL_INDEX[level]
  const numBlocks = ECC_BLOCKS[l]![ver]!
  const eccLen = ECC_PER_BLOCK[l]![ver]!
  const raw = Math.floor(rawDataModules(ver) / 8)
  const numShort = numBlocks - (raw % numBlocks)
  const shortLen = Math.floor(raw / numBlocks)
  const divisor = rsDivisor(eccLen)
  const blocks: number[][] = []
  for (let i = 0, k = 0; i < numBlocks; i++) {
    const dat = data.slice(k, k + shortLen - eccLen + (i < numShort ? 0 : 1))
    k += dat.length
    const ecc = rsRemainder(dat, divisor)
    if (i < numShort) dat.push(0) // placeholder so every block has the same length
    blocks.push(dat.concat(ecc))
  }
  const result: number[] = []
  for (let i = 0; i < blocks[0]!.length; i++) {
    blocks.forEach((block, j) => {
      if (i !== shortLen - eccLen || j >= numShort) result.push(block[i]!)
    })
  }
  return result
}

class Matrix {
  readonly size: number
  readonly modules: boolean[][]
  readonly isFunction: boolean[][]

  constructor(readonly version: number) {
    this.size = version * 4 + 17
    this.modules = Array.from({ length: this.size }, () => new Array<boolean>(this.size).fill(false))
    this.isFunction = Array.from({ length: this.size }, () => new Array<boolean>(this.size).fill(false))
  }

  private setFunction(x: number, y: number, dark: boolean) {
    this.modules[y]![x] = dark
    this.isFunction[y]![x] = true
  }

  drawFunctionPatterns() {
    const s = this.size
    for (let i = 0; i < s; i++) {
      this.setFunction(6, i, i % 2 === 0)
      this.setFunction(i, 6, i % 2 === 0)
    }
    for (const [x, y] of [[3, 3], [s - 4, 3], [3, s - 4]] as const) {
      for (let dy = -4; dy <= 4; dy++) {
        for (let dx = -4; dx <= 4; dx++) {
          const d = Math.max(Math.abs(dx), Math.abs(dy))
          if (x + dx >= 0 && x + dx < s && y + dy >= 0 && y + dy < s) this.setFunction(x + dx, y + dy, d !== 2 && d !== 4)
        }
      }
    }
    const align = this.alignmentPositions()
    const last = align.length - 1
    for (let i = 0; i <= last; i++) {
      for (let j = 0; j <= last; j++) {
        if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) continue // finder corners
        for (let dy = -2; dy <= 2; dy++) {
          for (let dx = -2; dx <= 2; dx++) this.setFunction(align[i]! + dx, align[j]! + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1)
        }
      }
    }
    this.drawFormatBits('M', 0) // reserves the area; overwritten once the mask is chosen
    this.drawVersion()
  }

  private alignmentPositions(): number[] {
    if (this.version === 1) return []
    const count = Math.floor(this.version / 7) + 2
    const step = Math.floor((this.version * 8 + count * 3 + 5) / (count * 4 - 4)) * 2
    const result = [6]
    for (let pos = this.size - 7; result.length < count; pos -= step) result.splice(1, 0, pos)
    return result
  }

  drawFormatBits(level: QrLevel, mask: number) {
    const data = (FORMAT_BITS[level] << 3) | mask
    let rem = data
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537)
    const bits = ((data << 10) | rem) ^ 0x5412
    const bit = (i: number) => ((bits >>> i) & 1) === 1
    const s = this.size
    for (let i = 0; i <= 5; i++) this.setFunction(8, i, bit(i))
    this.setFunction(8, 7, bit(6))
    this.setFunction(8, 8, bit(7))
    this.setFunction(7, 8, bit(8))
    for (let i = 9; i < 15; i++) this.setFunction(14 - i, 8, bit(i))
    for (let i = 0; i < 8; i++) this.setFunction(s - 1 - i, 8, bit(i))
    for (let i = 8; i < 15; i++) this.setFunction(8, s - 15 + i, bit(i))
    this.setFunction(8, s - 8, true) // the always-dark module
  }

  private drawVersion() {
    if (this.version < 7) return
    let rem = this.version
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25)
    const bits = (this.version << 12) | rem
    for (let i = 0; i < 18; i++) {
      const dark = ((bits >>> i) & 1) === 1
      const a = this.size - 11 + (i % 3)
      const b = Math.floor(i / 3)
      this.setFunction(a, b, dark)
      this.setFunction(b, a, dark)
    }
  }

  drawCodewords(data: number[]) {
    let i = 0
    for (let right = this.size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5 // skip the vertical timing pattern
      for (let vert = 0; vert < this.size; vert++) {
        for (let j = 0; j < 2; j++) {
          const x = right - j
          const upward = ((right + 1) & 2) === 0
          const y = upward ? this.size - 1 - vert : vert
          if (!this.isFunction[y]![x] && i < data.length * 8) {
            this.modules[y]![x] = ((data[i >>> 3]! >>> (7 - (i & 7))) & 1) === 1
            i++
          }
        }
      }
    }
  }

  /** XOR-ing the same mask twice undoes it. */
  applyMask(mask: number) {
    for (let y = 0; y < this.size; y++) {
      for (let x = 0; x < this.size; x++) {
        if (this.isFunction[y]![x]) continue
        let invert: boolean
        switch (mask) {
          case 0: invert = (x + y) % 2 === 0; break
          case 1: invert = y % 2 === 0; break
          case 2: invert = x % 3 === 0; break
          case 3: invert = (x + y) % 3 === 0; break
          case 4: invert = (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0; break
          case 5: invert = ((x * y) % 2) + ((x * y) % 3) === 0; break
          case 6: invert = (((x * y) % 2) + ((x * y) % 3)) % 2 === 0; break
          default: invert = (((x + y) % 2) + ((x * y) % 3)) % 2 === 0
        }
        if (invert) this.modules[y]![x] = !this.modules[y]![x]
      }
    }
  }

  /** Spec penalty score: lower means easier for cameras to read. */
  penalty(): number {
    const s = this.size
    const m = this.modules
    let score = 0
    const finderLike = [
      [true, false, true, true, true, false, true, false, false, false, false],
      [false, false, false, false, true, false, true, true, true, false, true],
    ]
    for (const horizontal of [true, false]) {
      for (let a = 0; a < s; a++) {
        const at = (b: number) => (horizontal ? m[a]![b]! : m[b]![a]!)
        let run = 1
        for (let b = 1; b < s; b++) {
          if (at(b) === at(b - 1)) run++
          else {
            if (run >= 5) score += 3 + run - 5
            run = 1
          }
        }
        if (run >= 5) score += 3 + run - 5
        for (let b = 0; b + 11 <= s; b++) {
          for (const pattern of finderLike) if (pattern.every((v, k) => at(b + k) === v)) score += 40
        }
      }
    }
    for (let y = 0; y + 1 < s; y++) {
      for (let x = 0; x + 1 < s; x++) {
        const c = m[y]![x]
        if (c === m[y]![x + 1] && c === m[y + 1]![x] && c === m[y + 1]![x + 1]) score += 3
      }
    }
    const dark = m.reduce((n, row) => n + row.filter(Boolean).length, 0)
    const total = s * s
    score += (Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1) * 10
    return score
  }
}

export function encodeQr(text: string, level: QrLevel = 'M'): QrCode {
  const bytes = new TextEncoder().encode(text)
  let version = 1
  while (version <= MAX_VERSION && 4 + (version <= 9 ? 8 : 16) + bytes.length * 8 > dataCodewords(version, level) * 8) version++
  if (version > MAX_VERSION) throw new Error(`Text too long for a QR code (${bytes.length} bytes)`)
  const matrix = new Matrix(version)
  matrix.drawFunctionPatterns()
  matrix.drawCodewords(addEccAndInterleave(encodeData(bytes, version, level), version, level))
  let best = 0
  let bestScore = Infinity
  for (let mask = 0; mask < 8; mask++) {
    matrix.applyMask(mask)
    matrix.drawFormatBits(level, mask)
    const score = matrix.penalty()
    if (score < bestScore) {
      best = mask
      bestScore = score
    }
    matrix.applyMask(mask)
  }
  matrix.applyMask(best)
  matrix.drawFormatBits(level, best)
  return { version, size: matrix.size, modules: matrix.modules }
}

/** Compact form for the browser: one string of 0/1 per row. */
export function qrRows(qr: QrCode): string[] {
  return qr.modules.map(row => row.map(d => (d ? '1' : '0')).join(''))
}

/** Scalable SVG with the standard 4-module quiet zone. */
export function qrSvg(qr: QrCode, border = 4): string {
  const parts: string[] = []
  qr.modules.forEach((row, y) => row.forEach((dark, x) => dark && parts.push(`M${x + border},${y + border}h1v1h-1z`)))
  const dim = qr.size + border * 2
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${dim} ${dim}" shape-rendering="crispEdges"><rect width="100%" height="100%" fill="#fff"/><path d="${parts.join('')}" fill="#000"/></svg>`
}

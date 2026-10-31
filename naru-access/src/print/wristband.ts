/**
 * QR wristband printing.
 *  - "zebra": builds ZPL (the language Zebra printers speak) and sends it straight to the printer
 *    over the network on port 9100. No driver or print dialog; the band comes out in about a second.
 *  - "browser": the staff tablet prints through its own print dialog, so any wristband printer
 *    with a driver works. The server only supplies the band details and QR patterns.
 */
import type { BandType } from '../core/rules.ts'
import type { Settings } from '../core/settings.ts'

export interface WristbandInfo {
  barcode: string
  type: BandType
  /** "Table 12", or the party's name. */
  groupLabel: string
  /** Local date, e.g. "Sat 3 Oct 2026". */
  dateLabel: string
}

export const TYPE_LABEL: Record<BandType, string> = { adult: 'ADULT', kid: 'KID', under2: 'UNDER 2' }

/** ZPL treats ^ and ~ as commands; strip them and anything outside printable text from labels. */
function zplText(s: string, max = 40): string {
  return s.replace(/[\^~\\]/g, ' ').replace(/[\u0000-\u001f]/g, '').slice(0, max)
}

/**
 * One ZPL label per band. The band feeds lengthways, so text is rotated to run along it,
 * with a QR code before and after the text so one is always facing up on the wrist.
 */
export function wristbandZpl(bands: WristbandInfo[], venueName: string, w: Settings['wristbands']): string {
  const dpmm = w.printerDpi / 25.4
  const width = Math.round(w.widthMm * dpmm)
  const length = Math.round(w.lengthMm * dpmm)
  // QR module size so the code is about 60% of the band's width (v1 is 21 modules wide).
  const mag = Math.max(2, Math.min(10, Math.floor((width * 0.6) / 21)))
  const qr = 21 * mag
  const qrX = Math.max(0, Math.round((width - qr) / 2))
  // Content sits in the middle third of the band, where it shows when the band is closed.
  const start = Math.round(length * 0.3)
  const line = (frac: number) => Math.round(width * frac)
  const h = (frac: number) => Math.max(14, Math.round(width * frac))
  return bands
    .map(b => {
      const textStart = start + qr + Math.round(6 * dpmm)
      return [
        '^XA',
        '^CI28', // UTF-8 text
        `^PW${width}`,
        `^LL${length}`,
        '^LH0,0',
        `^FO${qrX},${start}^BQN,2,${mag}^FDMA,${zplText(b.barcode, 64)}^FS`,
        // Four lines across the band's width, each running along its length.
        `^FO${line(0.74)},${textStart}^A0R,${h(0.17)},${h(0.15)}^FD${zplText(venueName, 24)}^FS`,
        `^FO${line(0.46)},${textStart}^A0R,${h(0.25)},${h(0.22)}^FD${TYPE_LABEL[b.type]}^FS`,
        `^FO${line(0.25)},${textStart}^A0R,${h(0.16)},${h(0.14)}^FD${zplText(b.barcode, 24)}^FS`,
        `^FO${line(0.05)},${textStart}^A0R,${h(0.14)},${h(0.12)}^FD${zplText(b.dateLabel, 16)} - ${zplText(b.groupLabel, 22)}^FS`,
        `^FO${qrX},${textStart + Math.round(78 * dpmm)}^BQN,2,${mag}^FDMA,${zplText(b.barcode, 64)}^FS`,
        '^XZ',
      ].join('\n')
    })
    .join('\n')
}

/** Sends ZPL to a network printer (raw TCP, port 9100 on Zebra printers). */
export async function sendToPrinter(address: string, port: number, zpl: string, timeoutMs = 5000): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let settled = false
    const done = (err?: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      err ? reject(err) : resolve()
    }
    const timer = setTimeout(() => done(new Error(`The wristband printer at ${address} did not answer. Check it is switched on and connected to the network.`)), timeoutMs)
    Bun.connect({
      hostname: address,
      port,
      socket: {
        open(socket) {
          socket.write(zpl)
          socket.flush()
          socket.end()
        },
        close() {
          done()
        },
        error(_socket, err) {
          done(new Error(`Could not print: ${err.message}`))
        },
        connectError(_socket, err) {
          done(new Error(`The wristband printer at ${address} could not be reached (${err.message}). Check it is switched on and connected to the network.`))
        },
        data() {},
      },
    }).catch(err => done(new Error(`The wristband printer at ${address} could not be reached (${(err as Error).message}).`)))
  })
}

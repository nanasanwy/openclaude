#!/usr/bin/env bun
/**
 * Lane controller: one runs beside each gate (e.g. on a Raspberry Pi).
 *  - reads band barcodes from the lane reader
 *  - asks the server for a decision
 *  - pulses the gate relay when the server says open (including staff overrides)
 *  - holds the gate open on fire alarm, a held-open lane, or when it loses the server
 *
 *   bun run src/lane/controller.ts --lane in --server http://192.168.1.10:8080 --key <lane key> \
 *     --reader /dev/ttyACM0 --relay-on "..." --relay-off "..."
 */
import { createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'
import { parseArgs } from 'node:util'
import { CommandRelay, LogRelay, type Relay } from './relay.ts'

export type LaneStatus = 'connecting' | 'online' | 'failsafe'

export interface LaneControllerOptions {
  lane: 'in' | 'out'
  server: string
  laneKey: string
  relay: Relay
  pulseMs?: number
  /** Seconds without the server before the gate is held open. */
  failOpenSeconds?: number
  log?: (msg: string) => void
}

export class LaneController {
  status: LaneStatus = 'connecting'
  private ws: WebSocket | null = null
  private serverHeld = false
  private failsafeTimer: ReturnType<typeof setTimeout> | null = null
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private stopped = false
  private relayHeld: boolean | null = null

  constructor(private opts: LaneControllerOptions) {}

  private log(msg: string) {
    ;(this.opts.log ?? console.log)(`[lane ${this.opts.lane}] ${msg}`)
  }

  start(): void {
    this.connect()
    this.armFailsafe()
  }

  stop(): void {
    this.stopped = true
    if (this.failsafeTimer) clearTimeout(this.failsafeTimer)
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.ws?.close()
  }

  private async setHold(open: boolean) {
    if (this.relayHeld === open) return
    this.relayHeld = open
    await this.opts.relay.hold(open)
  }

  private armFailsafe() {
    if (this.failsafeTimer) clearTimeout(this.failsafeTimer)
    this.failsafeTimer = setTimeout(() => {
      if (this.status === 'online' || this.stopped) return
      this.status = 'failsafe'
      this.log('server unreachable: holding gate OPEN (fail-safe)')
      void this.setHold(true)
    }, (this.opts.failOpenSeconds ?? 5) * 1000)
  }

  private connect() {
    if (this.stopped) return
    const url = `${this.opts.server.replace(/^http/, 'ws')}/ws?lane=${this.opts.lane}`
    const ws = new WebSocket(url)
    this.ws = ws
    ws.onopen = () => {
      this.status = 'online'
      if (this.failsafeTimer) clearTimeout(this.failsafeTimer)
      this.log('connected to server')
    }
    ws.onmessage = ev => this.onMessage(String(ev.data))
    ws.onclose = () => {
      if (this.stopped) return
      if (this.status === 'online') {
        this.log('lost server connection')
        this.status = 'connecting'
        this.armFailsafe()
      }
      this.reconnectTimer = setTimeout(() => this.connect(), 1000)
    }
    ws.onerror = () => ws.close()
  }

  private onMessage(raw: string) {
    let msg: { type: string; lane?: string; decision?: { open: boolean }; lanes?: { lane: string; held: boolean }[] }
    try {
      msg = JSON.parse(raw)
    } catch {
      return
    }
    if (msg.type === 'lane' && msg.lanes) {
      this.serverHeld = msg.lanes.find(l => l.lane === this.opts.lane)?.held ?? false
      void this.setHold(this.serverHeld)
    } else if (msg.type === 'gate' && msg.lane === this.opts.lane && msg.decision?.open && !this.serverHeld && !this.relayHeld) {
      void this.opts.relay.pulse(this.opts.pulseMs ?? 500)
    }
  }

  /** Sends a scanned barcode to the server. The relay pulse arrives back over the websocket. */
  async scan(barcode: string): Promise<{ open: boolean; message: string } | null> {
    const code = barcode.trim()
    if (!code) return null
    try {
      const res = await fetch(`${this.opts.server}/api/lanes/${this.opts.lane}/scan`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-lane-key': this.opts.laneKey },
        body: JSON.stringify({ barcode: code }),
        signal: AbortSignal.timeout(2000),
      })
      const body = (await res.json()) as { open: boolean; message: string }
      this.log(`${code}: ${body.message}`)
      return body
    } catch (err) {
      this.log(`${code}: server did not answer (${(err as Error).message})`)
      return null
    }
  }

  /** Reports the fire panel input (sensed on a GPIO pin) to the server, for the dashboard. */
  async reportFire(active: boolean): Promise<void> {
    if (active) await this.setHold(true)
    try {
      await fetch(`${this.opts.server}/api/system/fire`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-lane-key': this.opts.laneKey },
        body: JSON.stringify({ active, source: `lane ${this.opts.lane} fire input` }),
      })
    } catch {
      // The gates are opened by the hard-wired fire input regardless.
    }
  }
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: {
      lane: { type: 'string' },
      server: { type: 'string', default: 'http://localhost:8080' },
      key: { type: 'string', default: process.env.NARU_LANE_KEY },
      reader: { type: 'string', default: 'stdin' },
      'relay-on': { type: 'string' },
      'relay-off': { type: 'string' },
      'pulse-ms': { type: 'string', default: '500' },
      'fail-open-seconds': { type: 'string', default: '5' },
      'fire-sense': { type: 'string' },
    },
  })
  if (values.lane !== 'in' && values.lane !== 'out') throw new Error('--lane must be "in" or "out"')
  if (!values.key) throw new Error('--key (or NARU_LANE_KEY) is required; it is in data/lane-key.txt on the server')
  const relay = values['relay-on'] && values['relay-off'] ? new CommandRelay(values['relay-on'], values['relay-off']) : new LogRelay()
  const controller = new LaneController({
    lane: values.lane,
    server: values.server!,
    laneKey: values.key,
    relay,
    pulseMs: Number(values['pulse-ms']),
    failOpenSeconds: Number(values['fail-open-seconds']),
  })
  controller.start()

  // Most barcode readers can run as a USB serial port (one barcode per line) or a keyboard.
  const input = values.reader === 'stdin' ? process.stdin : createReadStream(values.reader!)
  createInterface({ input }).on('line', line => void controller.scan(line))

  if (values['fire-sense']) {
    // A command that prints 1 while the fire panel signal is active, e.g. "gpioget GPIOCHIP0 27".
    let last: boolean | null = null
    setInterval(async () => {
      const out = await new Response(Bun.spawn(['sh', '-c', values['fire-sense']!]).stdout).text()
      const active = out.trim() === '1'
      if (active !== last) {
        last = active
        await controller.reportFire(active)
      }
    }, 1000)
  }
  console.log(`Lane ${values.lane} controller started. Reading barcodes from ${values.reader}.`)
}

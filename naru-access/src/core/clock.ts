/** Every time-dependent rule reads the time through a Clock so tests and the simulator can control it. */
export interface Clock {
  now(): number
}

export const systemClock: Clock = { now: () => Date.now() }

/**
 * A controllable clock. When `running` is true it ticks in real time from the
 * chosen start (used by the simulator); when false it stays frozen (used by tests).
 */
export class SimClock implements Clock {
  private base: number
  private realStart = Date.now()

  constructor(start: number, private running = false) {
    this.base = start
  }

  now(): number {
    return this.running ? this.base + (Date.now() - this.realStart) : this.base
  }

  set(ms: number): void {
    this.base = ms
    this.realStart = Date.now()
  }

  advance(ms: number): void {
    this.set(this.now() + ms)
  }
}

/**
 * The gate is opened by closing a dry contact on the gate's "open" input.
 * A Relay drives that contact: a short pulse lets one person through; hold keeps it open.
 */
export interface Relay {
  pulse(ms: number): Promise<void>
  hold(open: boolean): Promise<void>
}

/** Prints what a real relay would do. Used on the bench and in tests. */
export class LogRelay implements Relay {
  readonly events: string[] = []
  constructor(private quiet = false) {}
  async pulse(ms: number) {
    this.record(`pulse ${ms}ms`)
  }
  async hold(open: boolean) {
    this.record(open ? 'hold open' : 'release')
  }
  private record(e: string) {
    this.events.push(e)
    if (!this.quiet) console.log(`[relay] ${e}`)
  }
}

/**
 * Drives the relay through shell commands, so it works with any relay board:
 * a Raspberry Pi GPIO pin (`gpioset`), a USB relay (`usbrelay`), or a network relay (`curl`).
 * Example for a Pi relay HAT on GPIO 17:
 *   --relay-on  "gpioset -t0 GPIOCHIP0 17=1"   (exact syntax depends on the libgpiod version)
 *   --relay-off "gpioset -t0 GPIOCHIP0 17=0"
 */
export class CommandRelay implements Relay {
  private held = false
  constructor(
    private onCmd: string,
    private offCmd: string,
  ) {}

  private async run(cmd: string) {
    const proc = Bun.spawn(['sh', '-c', cmd], { stdout: 'ignore', stderr: 'inherit' })
    if ((await proc.exited) !== 0) console.error(`[relay] command failed: ${cmd}`)
  }

  async pulse(ms: number) {
    if (this.held) return
    await this.run(this.onCmd)
    await Bun.sleep(ms)
    if (!this.held) await this.run(this.offCmd)
  }

  async hold(open: boolean) {
    this.held = open
    await this.run(open ? this.onCmd : this.offCmd)
  }
}

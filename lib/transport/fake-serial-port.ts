// SPDX-License-Identifier: GPL-3.0-or-later
import { fromHex, hexDump } from '../codec/checksum.js'
import type { SerialOpenOptions, SerialPortLike, TransportKind } from './transport.js'

/**
 * A scripted stand-in for a `SerialPort`.
 *
 * Node 24 has WHATWG streams globally, so this drives the whole real transport
 * and driver stack in plain unit tests: no browser, no jsdom, no radio. It is
 * also what replays a recorded hardware trace, which is how protocol regressions
 * get caught in CI on a machine with nothing plugged into it.
 */

export type Responder = (written: Uint8Array, port: FakeSerialPort) => Uint8Array | null | undefined

export interface FakeSerialPortOptions {
  /** Bytes queued for the host to read before anything is written. */
  greeting?: Uint8Array
  /** Called for each host write; return bytes to feed back. */
  respond?: Responder
  /** Simulated delay before a response is delivered, in ms. */
  latencyMs?: number
  info?: { usbVendorId?: number; usbProductId?: number }
  /**
   * What the driver above should believe it is talking over.
   *
   * Lets a test exercise the Bluetooth constants - the UV-5R Mini's 0x80 upload
   * block and its 0xFF padding - through the real transport and the real driver
   * without a GATT stack in the way. What differs over BLE is what the driver
   * decides, not how the bytes travel, so this is the honest seam to fake.
   */
  kind?: TransportKind
}

export class FakeSerialPort implements SerialPortLike {
  readable: ReadableStream<Uint8Array> | null = null
  writable: WritableStream<Uint8Array> | null = null

  /** Everything the host has written, in order. */
  readonly written: Uint8Array[] = []
  openOptions: SerialOpenOptions | null = null
  signalHistory: { dataTerminalReady?: boolean; requestToSend?: boolean; break?: boolean }[] = []
  closed = false

  #controller: ReadableStreamDefaultController<Uint8Array> | null = null
  #opts: FakeSerialPortOptions
  #openCount = 0

  constructor(opts: FakeSerialPortOptions = {}) {
    this.#opts = opts
  }

  get openCount(): number {
    return this.#openCount
  }

  get kind(): TransportKind | undefined {
    return this.#opts.kind
  }

  /** Concatenation of everything written, for assertions. */
  writtenBytes(): Uint8Array {
    const total = this.written.reduce((n, c) => n + c.length, 0)
    const out = new Uint8Array(total)
    let off = 0
    for (const c of this.written) {
      out.set(c, off)
      off += c.length
    }
    return out
  }

  writtenHex(): string {
    return hexDump(this.writtenBytes())
  }

  async open(options: SerialOpenOptions): Promise<void> {
    if (this.readable) throw new Error('FakeSerialPort: already open')
    this.openOptions = options
    this.closed = false
    this.#openCount++

    this.readable = new ReadableStream<Uint8Array>({
      start: (c) => {
        this.#controller = c
        if (this.#opts.greeting) c.enqueue(this.#opts.greeting)
      },
      cancel: () => {
        this.#controller = null
      },
    })

    this.writable = new WritableStream<Uint8Array>({
      write: async (chunk) => {
        this.written.push(Uint8Array.from(chunk))
        const reply = this.#opts.respond?.(Uint8Array.from(chunk), this)
        if (reply && reply.length) {
          if (this.#opts.latencyMs) await new Promise((r) => setTimeout(r, this.#opts.latencyMs))
          this.push(reply)
        }
      },
    })
  }

  /** Feed bytes to the host as if the device sent them. */
  push(data: Uint8Array): void {
    this.#controller?.enqueue(Uint8Array.from(data))
  }

  pushHex(hex: string): void {
    this.push(fromHex(hex))
  }

  /** Simulate the cable being pulled: the read stream errors. */
  fault(reason = 'device disconnected'): void {
    this.#controller?.error(new Error(reason))
    this.#controller = null
  }

  /** Simulate a clean end of stream. */
  endStream(): void {
    try {
      this.#controller?.close()
    } catch {
      /* already closed */
    }
    this.#controller = null
  }

  async setSignals(signals: { dataTerminalReady?: boolean; requestToSend?: boolean; break?: boolean }): Promise<void> {
    this.signalHistory.push({ ...signals })
  }

  getInfo(): { usbVendorId?: number; usbProductId?: number } {
    return this.#opts.info ?? {}
  }

  async close(): Promise<void> {
    this.closed = true
    this.endStream()
    this.readable = null
    this.writable = null
  }
}

/**
 * Build a responder from an ordered exchange script.
 *
 * Each step matches the next host write and returns the reply. A mismatch
 * throws with both sides in hex, which is far more useful than a test that
 * merely times out.
 */
export interface Exchange {
  /** Expected bytes written by the host. Omit to accept anything. */
  expect?: Uint8Array
  /** Bytes to reply with. */
  reply?: Uint8Array
  label?: string
}

export function scriptedResponder(script: Exchange[]): Responder {
  let i = 0
  return (written) => {
    const step = script[i]
    if (!step) throw new Error(`FakeSerialPort: unexpected write (script exhausted): ${hexDump(written)}`)
    i++
    if (step.expect) {
      const same = step.expect.length === written.length && step.expect.every((b, j) => b === written[j])
      if (!same) {
        throw new Error(
          `FakeSerialPort: script step ${i} (${step.label ?? 'unnamed'}) mismatch\n` +
            `  expected: ${hexDump(step.expect)}\n` +
            `  received: ${hexDump(written)}`,
        )
      }
    }
    return step.reply ?? null
  }
}

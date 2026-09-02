// SPDX-License-Identifier: GPL-3.0-or-later
import { fromHex, hexDump } from '../codec/checksum.js'
import type { NativeSerialLink, NativeSerialOpenParams } from './native-serial-port.js'

/**
 * A scripted stand-in for the Android USB-serial plugin.
 *
 * The counterpart of `FakeSerialPort` and `FakeGattLink`, and there for the
 * same reason: it drives the real `NativeSerialPort`, the real
 * `SerialTransport` and the real drivers in plain Node, so the phone's cable
 * path can be proved without a phone, a plugin, or a radio.
 *
 * What it deliberately reproduces is the part that is easy to get wrong. The
 * plugin decodes each event into a buffer it is free to reuse, so every chunk
 * this fake delivers is a view onto one scratch buffer that the next delivery
 * overwrites. A port that keeps the view rather than copying out of it finds
 * its earlier bytes rewritten while they sit unread in the queue - and
 * allocating a fresh array per event here would make that bug invisible in
 * every test.
 *
 * What it cannot reproduce is everything specific to the plugin itself: the
 * USB permission dialog, the device filter, and how Android reports a cable
 * pulled mid-transfer. That glue lives in `app/` and still needs a phone.
 */

export type NativeResponder = (
  written: Uint8Array,
  link: FakeNativeSerialLink,
) => Uint8Array | Uint8Array[] | null | undefined

export interface FakeNativeSerialLinkOptions {
  /**
   * Called for each host write; return bytes to deliver back. An array is
   * delivered as separate events, which is how a long reply arrives from a
   * real bridge that reads the device in pieces.
   */
  respond?: NativeResponder
  /** Simulated delay before a response is delivered, in ms. */
  latencyMs?: number
  info?: { usbVendorId?: number; usbProductId?: number }
  label?: string
  /** Bytes delivered the moment the device opens, before anything is written. */
  greeting?: Uint8Array
}

export class FakeNativeSerialLink implements NativeSerialLink {
  readonly info: { usbVendorId?: number; usbProductId?: number }
  readonly label: string | undefined

  /** What the plugin was told at the last open. */
  openParams: NativeSerialOpenParams | null = null
  /** Everything the host has written, one entry per `write` call. */
  readonly written: Uint8Array[] = []
  signalHistory: { dataTerminalReady?: boolean; requestToSend?: boolean }[] = []
  openCount = 0
  closeCount = 0

  #opts: FakeNativeSerialLinkOptions
  #opened = false
  #dataListeners = new Set<(bytes: Uint8Array) => void>()
  #lostListeners = new Set<(reason: string) => void>()
  /**
   * One buffer behind every delivery, reused on purpose. See the note at the
   * top of this file.
   */
  #scratch = new Uint8Array(0)

  constructor(opts: FakeNativeSerialLinkOptions = {}) {
    this.#opts = opts
    this.info = opts.info ?? {}
    this.label = opts.label
  }

  get opened(): boolean {
    return this.#opened
  }

  get dataListenerCount(): number {
    return this.#dataListeners.size
  }

  get lostListenerCount(): number {
    return this.#lostListeners.size
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

  async open(params: NativeSerialOpenParams): Promise<void> {
    if (this.#opened) throw new Error('FakeNativeSerialLink: already open')
    this.openParams = params
    this.openCount++
    this.#opened = true
    // Delivered from inside open, which is the ordering trap: a port that
    // subscribes only after open resolves never sees this.
    if (this.#opts.greeting) this.push(this.#opts.greeting)
  }

  async write(data: Uint8Array): Promise<void> {
    if (!this.#opened) throw new Error('FakeNativeSerialLink: write on a closed device')
    this.written.push(Uint8Array.from(data))
    const reply = this.#opts.respond?.(Uint8Array.from(data), this)
    if (!reply) return
    const pieces = Array.isArray(reply) ? reply : [reply]
    if (this.#opts.latencyMs) await new Promise((r) => setTimeout(r, this.#opts.latencyMs))
    for (const piece of pieces) this.push(piece)
  }

  async setSignals(s: { dataTerminalReady?: boolean; requestToSend?: boolean }): Promise<void> {
    if (!this.#opened) throw new Error('FakeNativeSerialLink: setSignals on a closed device')
    this.signalHistory.push({ ...s })
  }

  async close(): Promise<void> {
    this.closeCount++
    this.#opened = false
  }

  onData(cb: (bytes: Uint8Array) => void): () => void {
    this.#dataListeners.add(cb)
    return () => {
      this.#dataListeners.delete(cb)
    }
  }

  onLost(cb: (reason: string) => void): () => void {
    this.#lostListeners.add(cb)
    return () => {
      this.#lostListeners.delete(cb)
    }
  }

  /**
   * Deliver bytes to the host as if the device sent them.
   *
   * Silently does nothing when the device is not open, because a closed
   * device delivers nothing - and a port that forgot to open should look like
   * a radio that never answers, which is what a real user would see.
   */
  push(data: Uint8Array): void {
    if (!this.#opened || data.length === 0) return
    if (this.#scratch.length < data.length) this.#scratch = new Uint8Array(data.length)
    this.#scratch.set(data, 0)
    const view = this.#scratch.subarray(0, data.length)
    for (const listener of [...this.#dataListeners]) listener(view)
  }

  pushHex(hex: string): void {
    this.push(fromHex(hex))
  }

  /** Simulate the cable being pulled: the device is gone and says why. */
  lose(reason = 'device detached'): void {
    this.#opened = false
    for (const listener of [...this.#lostListeners]) listener(reason)
  }
}

// SPDX-License-Identifier: GPL-3.0-or-later
import { DeviceDisconnectedError, TransportError } from './errors.js'
import { delay, type SerialOpenOptions, type SerialPortLike, type TransportKind } from './transport.js'

/**
 * A `SerialPortLike` over the Android app's USB-serial plugin.
 *
 * A phone has no `navigator.serial`. What it has is a native plugin that owns
 * the USB device, runs the CH340 / PL2303 / CP210x / FTDI driver in Java, and
 * hands bytes across the bridge one event at a time. This file is the same
 * seam the dev bridge and the GATT port already use: `SerialTransport` gets a
 * `readable` and a `writable`, and nothing above it - framing, protocol,
 * driver, screen - can tell a phone from a laptop.
 *
 * `NativeSerialLink` is what the composable in `app/` builds from the plugin.
 * It is deliberately a small, typed, byte-only surface: the plugin bridge
 * carries base64 and the composable decodes it, so no base64 ever reaches this
 * file and `lib/` never learns Capacitor's API - ESLint refuses the import.
 *
 * Two things the seam has to absorb so that nothing else does:
 *
 * 1. **Each incoming chunk is copied.** The bridge decodes into a buffer it is
 *    free to reuse for the next event, and `ByteQueue` keeps the reference it
 *    is handed. Keeping the view would let the next event rewrite bytes still
 *    sitting unread in the queue - corruption that reads as a faulty radio.
 *
 * 2. **A write is one call, never chunked here.** `SerialOpenOptions.writeChunk`
 *    is `SerialTransport`'s job, and the UV-82 family's identify sends seven
 *    one-byte magic writes that must arrive as seven calls: a port that batched
 *    or split them would send a different handshake from the one CHIRP sends.
 *
 * ## What has and has not been exercised
 *
 * Everything in this file is covered by `test/lib/transport/native-serial-port.spec.ts`
 * against a fake link, and `native-serial-drivers.spec.ts` shows the UV-K5 and
 * UV-5R Mini drivers producing byte-identical traces through this port and
 * through `FakeSerialPort`. Nothing in it has been run against a radio, or
 * against the real plugin on a phone.
 */

/** What the plugin is told when the device is opened. */
export interface NativeSerialOpenParams {
  baudRate: number
  dataBits: 7 | 8
  stopBits: 1 | 2
  parity: 'none' | 'even' | 'odd'
  dtr: boolean
  rts: boolean
}

/**
 * The structural subset of the native plugin this port needs.
 *
 * Declared here rather than imported from the plugin's types for the same
 * reason `SerialPortLike` is declared rather than imported from the DOM lib:
 * `lib/` compiles with no host types at all and its tests run in plain Node.
 */
export interface NativeSerialLink {
  readonly info: { usbVendorId?: number; usbProductId?: number }
  /** Something to show a person: the adapter's product name, usually. */
  readonly label?: string | undefined
  open(params: NativeSerialOpenParams): Promise<void>
  write(data: Uint8Array): Promise<void>
  setSignals(s: { dataTerminalReady?: boolean; requestToSend?: boolean }): Promise<void>
  close(): Promise<void>
  /** Bytes from the radio. Returns the unsubscribe. */
  onData(cb: (bytes: Uint8Array) => void): () => void
  /** The device went away underneath us. Returns the unsubscribe. */
  onLost(cb: (reason: string) => void): () => void
}

export class NativeSerialError extends TransportError {
  override readonly name = 'NativeSerialError'
}

export class NativeSerialPort implements SerialPortLike {
  /**
   * Both `'serial'`, and fused: the radio is on a wired UART and so is the
   * host, as far as the protocol is concerned. The UV-5R Mini's upload block
   * size keys on `radioLink`, and through this port it must be the cable one.
   */
  readonly kind: TransportKind = 'serial'
  readonly radioLink: TransportKind = 'serial'

  readable: ReadableStream<Uint8Array> | null = null
  writable: WritableStream<Uint8Array> | null = null

  #link: NativeSerialLink
  #controller: ReadableStreamDefaultController<Uint8Array> | null = null
  #unsubscribeData: (() => void) | null = null
  #unsubscribeLost: (() => void) | null = null
  #open = false

  constructor(link: NativeSerialLink) {
    this.#link = link
  }

  get label(): string {
    return this.#link.label ?? 'a USB serial cable'
  }

  getInfo(): { usbVendorId?: number; usbProductId?: number } {
    return this.#link.info
  }

  /**
   * Open the device, then expose the two streams.
   *
   * The line parameters are filled in from `SerialOpenOptions` with the same
   * defaults `BridgeSerialPort` uses, and the two modem signals default to
   * false. That default is deliberate: every driver deasserts both, because
   * the two-pin Kenwood cables and several UV-K5 cables reset the radio when
   * either line is asserted, so the safe answer when a driver says nothing is
   * the one every driver would have given.
   *
   * The data and loss subscriptions are taken before the device is opened,
   * not after: a plugin may deliver a byte the moment the port comes up, and
   * a subscription taken afterwards would have lost it silently.
   */
  async open(options: SerialOpenOptions): Promise<void> {
    if (this.#open) throw new NativeSerialError('This serial port is already open')

    this.readable = new ReadableStream<Uint8Array>({
      start: (c) => {
        this.#controller = c
      },
      cancel: () => {
        this.#controller = null
      },
    })

    this.writable = new WritableStream<Uint8Array>({
      write: (chunk) => this.#send(chunk),
    })

    this.#unsubscribeData = this.#link.onData((bytes) => this.#receive(bytes))
    this.#unsubscribeLost = this.#link.onLost((reason) => this.#fail(new DeviceDisconnectedError(reason)))

    try {
      await this.#link.open({
        baudRate: options.baudRate,
        dataBits: options.dataBits ?? 8,
        stopBits: options.stopBits ?? 1,
        parity: options.parity ?? 'none',
        dtr: options.signals?.dataTerminalReady ?? false,
        rts: options.signals?.requestToSend ?? false,
      })
    } catch (e) {
      // Undo the subscriptions rather than leaving a half-open port behind:
      // the caller is entitled to try again on the same device.
      this.#unsubscribe()
      this.readable = null
      this.writable = null
      this.#controller = null
      throw new NativeSerialError(
        `The USB serial device did not open: ${e instanceof Error ? e.message : String(e)}`,
        { cause: e },
      )
    }

    this.#open = true
    if (options.openSettleMs) await delay(options.openSettleMs)
  }

  async #send(chunk: Uint8Array): Promise<void> {
    if (!this.#open) throw new NativeSerialError('The serial port is not open')
    // One call per chunk, and the chunk is copied first. `SerialTransport`
    // hands over a `subarray` when it chunks a write, and a bridge that
    // encodes `bytes.buffer` rather than the view would send the whole
    // backing array. `slice` gives it a buffer that is exactly the bytes.
    await this.#link.write(chunk.slice())
  }

  #receive(bytes: Uint8Array): void {
    if (bytes.length === 0) return
    // Copied, never kept. See the note at the top of this file: the bridge
    // owns that memory and may reuse it for the next event.
    this.#controller?.enqueue(bytes.slice())
  }

  /**
   * Break the read stream, which is how `SerialTransport` learns of a loss.
   *
   * The subscriptions come off here too. The device is gone, so nothing more
   * can arrive on them, and a second loss event or a straggling data event
   * must not reach a controller that has already been errored.
   */
  #fail(error: Error): void {
    this.#unsubscribe()
    const controller = this.#controller
    this.#controller = null
    controller?.error(error)
  }

  #unsubscribe(): void {
    this.#unsubscribeData?.()
    this.#unsubscribeData = null
    this.#unsubscribeLost?.()
    this.#unsubscribeLost = null
  }

  /**
   * Forward DTR and RTS. `break` is ignored: no cable this project drives
   * needs it, and the plugin has no such call to forward it to.
   */
  async setSignals(signals: { dataTerminalReady?: boolean; requestToSend?: boolean; break?: boolean }): Promise<void> {
    if (!this.#open) throw new NativeSerialError('The serial port is not open')
    await this.#link.setSignals({
      ...(signals.dataTerminalReady === undefined ? {} : { dataTerminalReady: signals.dataTerminalReady }),
      ...(signals.requestToSend === undefined ? {} : { requestToSend: signals.requestToSend }),
    })
  }

  /**
   * Tear down.
   *
   * The subscriptions come off before the device is closed, or our own close
   * would arrive as a loss and report a cable pulled by a user who asked for
   * it to end. Everything after that is best-effort: a device that has
   * already been unplugged fails its close, and there is nothing useful to do
   * about that.
   */
  async close(): Promise<void> {
    if (!this.#open && !this.#unsubscribeData) return
    this.#open = false
    this.#unsubscribe()

    try {
      this.#controller?.close()
    } catch {
      /* already errored or closed */
    }
    this.#controller = null

    try {
      await this.#link.close()
    } catch {
      /* the device is going away regardless */
    }

    this.readable = null
    this.writable = null
  }
}

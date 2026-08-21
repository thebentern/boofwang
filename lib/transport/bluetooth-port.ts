// SPDX-License-Identifier: GPL-3.0-or-later
import { DeviceDisconnectedError, TransportError } from './errors.js'
import { delay, type SerialOpenOptions, type SerialPortLike, type TransportKind } from './transport.js'

/**
 * A `SerialPortLike` whose bytes travel over GATT instead of a cable.
 *
 * The whole point is that nothing above this file can tell. `SerialTransport`
 * gets a `readable` and a `writable`, the `ByteQueue` reassembles frames from
 * whatever sized pieces arrive, and every driver, decoder and screen is
 * unchanged - which is the same seam that already lets the dev bridge hand the
 * driver stack a WebSocket.
 *
 * Three things about BLE that this file has to absorb so that nothing else has
 * to know them:
 *
 * 1. **A GATT write is not a stream write.** It is capped at the negotiated ATT
 *    MTU minus three, which Web Bluetooth does not expose. So outgoing data is
 *    cut into `maxWriteBytes` pieces here, and a driver may hand this port a
 *    132-byte frame exactly as it would hand one to a serial port.
 *
 * 2. **Notifications are the only way in.** They arrive as `DataView`s on a
 *    buffer the stack reuses, which is why every one is copied before it is
 *    enqueued. Keeping the view would give the queue a window onto bytes that
 *    are about to be overwritten by the next notification - a corruption that
 *    would look exactly like a bad radio.
 *
 * 3. **There are no modem signals.** `setSignals` and `getInfo` are absent
 *    rather than stubbed, because `SerialPortLike` makes both optional and a
 *    stub that quietly does nothing is worse than a method that is not there:
 *    `SerialTransport` checks for them and skips them, which is the correct
 *    behaviour and is expressible only by omission.
 *
 * ## What has and has not been exercised
 *
 * Everything in this file is covered by `test/lib/transport/bluetooth-port.spec.ts`
 * against a fake GATT link. Nothing in it has been run against a radio, for the
 * reason set out at the top of `bluetooth-uuids.ts`: nobody has captured the
 * service UUID yet, so the chooser cannot be made to list one.
 */

/** The subset of `DataView` a notification payload is read through. */
export interface DataViewLike {
  readonly buffer: ArrayBufferLike
  readonly byteOffset: number
  readonly byteLength: number
}

/**
 * A `characteristicvaluechanged` event, as loosely as it can honestly be typed.
 *
 * `target` is deliberately `unknown`. The real event's is an `EventTarget`,
 * whose declared shape has nothing in common with the characteristic it
 * actually is, so any tighter type here would be a lie that the app has to cast
 * its way past anyway.
 */
export interface GattNotification {
  readonly target?: unknown
}

/**
 * The structural subset of `BluetoothRemoteGATTCharacteristic` this needs.
 *
 * Declared rather than imported from `@types/web-bluetooth` for the same reason
 * `SerialPortLike` is declared rather than imported from the DOM lib: `lib/`
 * compiles with no DOM types at all and its tests run in plain Node, and that
 * is what keeps this port testable without a browser.
 */
export interface GattCharacteristicLike {
  readonly uuid?: string
  readonly value?: DataViewLike | null
  readonly properties?: {
    readonly write?: boolean
    readonly writeWithoutResponse?: boolean
    readonly notify?: boolean
    readonly indicate?: boolean
  }
  writeValueWithResponse?(value: Uint8Array): Promise<void>
  writeValueWithoutResponse?(value: Uint8Array): Promise<void>
  /** The pre-2019 spelling. Still the only one some stacks and polyfills have. */
  writeValue?(value: Uint8Array): Promise<void>
  startNotifications(): Promise<unknown>
  stopNotifications?(): Promise<unknown>
  addEventListener(type: 'characteristicvaluechanged', listener: (ev: GattNotification) => void): void
  removeEventListener(type: 'characteristicvaluechanged', listener: (ev: GattNotification) => void): void
}

/** The structural subset of `BluetoothDevice` this needs. */
export interface GattDeviceLike {
  readonly id?: string
  readonly name?: string | null
  readonly gatt?: { readonly connected?: boolean; disconnect(): void } | undefined
  addEventListener(type: 'gattserverdisconnected', listener: () => void): void
  removeEventListener(type: 'gattserverdisconnected', listener: () => void): void
}

/**
 * A connected pair of characteristics, plus the device they belong to.
 *
 * `write` and `notify` may be the same object: the HM-10 style modules use one
 * characteristic for both directions, and nothing here assumes otherwise.
 */
export interface BluetoothLink {
  /** Written to by this program. Nordic calls it RX, from the radio's side. */
  readonly write: GattCharacteristicLike
  /** Notified on by the radio. Nordic calls it TX. */
  readonly notify: GattCharacteristicLike
  readonly device?: GattDeviceLike | undefined
  /** Something to show a person: the advertised device name, usually. */
  readonly label?: string | undefined
}

export interface BluetoothPortOptions {
  /**
   * The largest payload handed to a single GATT write.
   *
   * 20 is the payload of the default 23-byte ATT MTU, and the only size
   * guaranteed to be a single unfragmented write. Chrome usually negotiates
   * far more, but it does not tell us how much, and a write past the real MTU
   * turns into a queued long write (prepare/execute) that plenty of cheap
   * peripherals mishandle. Raise it once a radio has been measured.
   */
  maxWriteBytes?: number
  /** Pause between GATT writes, in ms, for a bridge that drops data under load. */
  writeGapMs?: number
  /**
   * Drop the GATT connection when the port closes.
   *
   * On by default: a link left up holds the radio in whatever state the last
   * command put it in, and the browser will not offer the device again while
   * the page still has it.
   */
  disconnectOnClose?: boolean
}

export class BluetoothLinkError extends TransportError {
  override readonly name = 'BluetoothLinkError'
}

const DEFAULT_MAX_WRITE_BYTES = 20

export class BluetoothPort implements SerialPortLike {
  /** The capability flag a driver reads to pick its block size. */
  readonly kind: TransportKind = 'bluetooth'

  readable: ReadableStream<Uint8Array> | null = null
  writable: WritableStream<Uint8Array> | null = null

  #link: BluetoothLink
  #options: BluetoothPortOptions
  #controller: ReadableStreamDefaultController<Uint8Array> | null = null
  #onNotify: ((ev: GattNotification) => void) | null = null
  #onGattDrop: (() => void) | null = null
  #writeValue: ((data: Uint8Array) => Promise<void>) | null = null
  #open = false

  constructor(link: BluetoothLink, options: BluetoothPortOptions = {}) {
    this.#link = link
    this.#options = options
  }

  get label(): string {
    return this.#link.label ?? this.#link.device?.name ?? 'a Bluetooth radio'
  }

  /**
   * Start listening, and expose the two streams.
   *
   * `SerialOpenOptions` is taken and almost entirely ignored, which is the
   * honest shape rather than a wart: baud rate, parity, stop bits and flow
   * control describe a UART and mean nothing over GATT, and a radio's driver
   * should not have to carry a second options bag for the same operation.
   * `openSettleMs` is observed, because the reason for it - give the far end a
   * moment before the first byte - applies to a BLE module just as much.
   */
  async open(options: SerialOpenOptions): Promise<void> {
    if (this.#open) throw new BluetoothLinkError('This Bluetooth port is already open')

    const notify = this.#link.notify
    if (notify.properties && !notify.properties.notify && !notify.properties.indicate) {
      throw new BluetoothLinkError(
        `The characteristic ${notify.uuid ?? 'chosen for input'} does not notify, so the radio has no way ` +
          'to answer. The UUIDs are probably wrong - see lib/transport/bluetooth-uuids.ts.',
      )
    }

    // Resolved once, at open, so a write cannot pick a different method
    // mid-transfer and so an unusable characteristic fails here rather than
    // half way through an image.
    this.#writeValue = this.#resolveWrite()

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

    this.#onNotify = (ev) => this.#receive(ev)
    notify.addEventListener('characteristicvaluechanged', this.#onNotify)

    try {
      await notify.startNotifications()
    } catch (e) {
      // Undo the listener rather than leaving a half-open port behind: the
      // caller is entitled to try a different profile on the same device.
      notify.removeEventListener('characteristicvaluechanged', this.#onNotify)
      this.#onNotify = null
      this.readable = null
      this.writable = null
      throw new BluetoothLinkError(
        `The radio refused to send notifications on ${notify.uuid ?? 'the chosen characteristic'}: ` +
          (e instanceof Error ? e.message : String(e)),
      )
    }

    const device = this.#link.device
    if (device) {
      this.#onGattDrop = () => this.#fail(new DeviceDisconnectedError('The radio dropped its Bluetooth connection'))
      device.addEventListener('gattserverdisconnected', this.#onGattDrop)
    }

    this.#open = true
    if (options.openSettleMs) await delay(options.openSettleMs)
  }

  /**
   * Which of the three write methods to use.
   *
   * The acknowledged write is preferred wherever the characteristic offers it.
   * It is slower - a round trip per packet - and that is the trade being made
   * deliberately: an unacknowledged write has no flow control at all, so a host
   * that outruns the peripheral's buffer loses packets silently, and a lost
   * packet in the middle of a codeplug is a desync that costs the whole
   * transfer. BLE is already the slow path; correctness is what it can least
   * afford to give up.
   */
  #resolveWrite(): (data: Uint8Array) => Promise<void> {
    const c = this.#link.write
    const props = c.properties

    if (c.writeValueWithResponse && props?.write !== false) {
      return (data) => c.writeValueWithResponse!(data)
    }
    if (c.writeValueWithoutResponse && props?.writeWithoutResponse !== false) {
      return (data) => c.writeValueWithoutResponse!(data)
    }
    if (c.writeValue) {
      return (data) => c.writeValue!(data)
    }
    throw new BluetoothLinkError(
      `The characteristic ${c.uuid ?? 'chosen for output'} cannot be written to, so there is no way to ` +
        'send the radio anything. The UUIDs are probably wrong - see lib/transport/bluetooth-uuids.ts.',
    )
  }

  async #send(chunk: Uint8Array): Promise<void> {
    const write = this.#writeValue
    if (!this.#open || !write) throw new BluetoothLinkError('The Bluetooth port is not open')

    const max = Math.max(1, this.#options.maxWriteBytes ?? DEFAULT_MAX_WRITE_BYTES)
    const gap = this.#options.writeGapMs ?? 0

    for (let off = 0; off < chunk.length; off += max) {
      // `slice` copies, which matters twice over: the caller may reuse its
      // buffer the moment `write()` resolves, and Chrome has historically
      // detached the ArrayBuffer handed to a GATT write.
      await write(chunk.slice(off, Math.min(off + max, chunk.length)))
      if (gap > 0 && off + max < chunk.length) await delay(gap)
    }
  }

  /**
   * A notification arrived.
   *
   * The payload is read from the event's target where there is one and from the
   * characteristic otherwise, because the two spellings differ across stacks
   * and both are right.
   */
  #receive(ev: GattNotification): void {
    const source = (ev.target ?? null) as { value?: DataViewLike | null } | null
    const view = source?.value ?? this.#link.notify.value
    if (!view || view.byteLength === 0) return

    // Copied, never kept as a view. See the note at the top of this file: the
    // stack owns that memory and overwrites it on the next notification, and
    // the copy is also what stops this port holding a reference to the whole
    // ring buffer for the life of a transfer.
    const bytes = new Uint8Array(view.byteLength)
    bytes.set(new Uint8Array(view.buffer, view.byteOffset, view.byteLength))

    // Enqueued regardless of `desiredSize`. There is no backpressure to apply -
    // a notification has already happened by the time we see it, and dropping
    // one would desync the stream far more expensively than a queue that grows.
    this.#controller?.enqueue(bytes)
  }

  /** Break the read stream, which is how `SerialTransport` learns of a loss. */
  #fail(error: Error): void {
    const controller = this.#controller
    this.#controller = null
    controller?.error(error)
  }

  /**
   * Tear down, and by default drop the GATT link with it.
   *
   * Called by `SerialTransport.close()` after it has cancelled the reader and
   * closed the writer, so the streams are already unlocked by the time this
   * runs. Everything here is best-effort: a radio that has walked out of range
   * fails all of it, and there is nothing useful to do about that.
   */
  async close(): Promise<void> {
    if (!this.#open && !this.#onNotify) return
    this.#open = false

    const notify = this.#link.notify
    if (this.#onNotify) {
      notify.removeEventListener('characteristicvaluechanged', this.#onNotify)
      this.#onNotify = null
    }

    const device = this.#link.device
    if (device && this.#onGattDrop) {
      // Removed before disconnecting, or our own disconnect fires the handler
      // and reports a dropped link to a user who asked for it to end.
      device.removeEventListener('gattserverdisconnected', this.#onGattDrop)
      this.#onGattDrop = null
    }

    try {
      await notify.stopNotifications?.()
    } catch {
      /* the link is going away regardless */
    }

    try {
      this.#controller?.close()
    } catch {
      /* already errored or closed */
    }
    this.#controller = null

    if (this.#options.disconnectOnClose !== false && device?.gatt?.connected !== false) {
      try {
        device?.gatt?.disconnect()
      } catch {
        /* already gone */
      }
    }

    this.readable = null
    this.writable = null
    this.#writeValue = null
  }
}

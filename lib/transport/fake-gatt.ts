// SPDX-License-Identifier: GPL-3.0-or-later
import { fromHex, hexDump } from '../codec/checksum.js'
import type {
  BluetoothLink,
  DataViewLike,
  GattCharacteristicLike,
  GattDeviceLike,
  GattNotification,
} from './bluetooth-port.js'

/**
 * A scripted stand-in for a pair of GATT characteristics.
 *
 * The counterpart of `FakeSerialPort`, and there for the same reason: it drives
 * the real `BluetoothPort`, the real `SerialTransport` and the real drivers in
 * plain Node, so the framing and buffering can be proved without a browser, a
 * Bluetooth adapter, or a radio.
 *
 * What it deliberately reproduces is the part that is easy to get wrong. A GATT
 * write is capped at the MTU and a notification arrives in whatever pieces the
 * peripheral chose, so a reply is fragmented on the way in and every write is
 * checked against a size limit on the way out. Code that only ever saw whole
 * frames would pass here and fail on the first real radio.
 *
 * What it cannot reproduce is everything specific to `navigator.bluetooth`: the
 * chooser, the permission grant, service discovery, and how a browser reports a
 * device that walked out of range mid-transfer. That glue lives in
 * `app/composables/useWebBluetooth.ts` and still needs a human and a radio.
 */

export type GattResponder = (written: Uint8Array, link: FakeGattLink) => Uint8Array | null | undefined

export interface FakeGattOptions {
  /** Called for each host write; return bytes for the radio to notify back. */
  respond?: GattResponder
  /**
   * How much of a reply one notification carries.
   *
   * Defaults to 20, the payload of the default ATT MTU, so a reply longer than
   * that arrives in pieces exactly as it would from a real peripheral.
   */
  notifyChunk?: number
  /** Reject a write larger than this, the way a peripheral with a small MTU does. */
  maxWriteBytes?: number
  /** What the characteristic claims it can do, which decides the write method. */
  properties?: GattCharacteristicLike['properties']
  /** Simulated delay before a reply is notified, in ms. */
  latencyMs?: number
  deviceName?: string
}

/** The minimum of `DataView` a notification payload needs to be readable. */
function asView(bytes: Uint8Array): DataViewLike {
  return { buffer: bytes.buffer, byteOffset: bytes.byteOffset, byteLength: bytes.byteLength }
}

/** The characteristic, with `value` writable so the fake can update it. */
type MutableCharacteristic = Omit<GattCharacteristicLike, 'value'> & { value: DataViewLike }

export class FakeGattLink implements BluetoothLink {
  /** Every payload the host wrote, one entry per GATT write. */
  readonly writes: Uint8Array[] = []
  notificationsStarted = 0
  notificationsStopped = 0

  readonly write: GattCharacteristicLike
  readonly notify: GattCharacteristicLike
  readonly device: GattDeviceLike

  #opts: FakeGattOptions
  #listeners = new Set<(ev: GattNotification) => void>()
  #dropListeners = new Set<() => void>()
  #characteristic: MutableCharacteristic
  #gatt: { connected: boolean; disconnect(): void }
  #notifying = false
  /**
   * One buffer behind every notification, reused on purpose.
   *
   * This is the trap the fake exists to spring. A real Bluetooth stack hands
   * the same memory back notification after notification, so a port that keeps
   * the `DataView` instead of copying out of it finds its earlier bytes
   * rewritten while they sit unread. Allocating a fresh array per fragment here
   * would make that bug invisible in every test.
   */
  #scratch = new Uint8Array(0)

  constructor(opts: FakeGattOptions = {}) {
    this.#opts = opts

    const characteristic: MutableCharacteristic = {
      uuid: 'fake-characteristic',
      // A real notification updates the characteristic's own `value` before it
      // fires, and on some stacks that is all the event carries. Both routes to
      // the payload are populated because both exist in the wild.
      value: asView(new Uint8Array(0)),
      properties: opts.properties ?? { write: true, writeWithoutResponse: true, notify: true },
      writeValueWithResponse: (data: Uint8Array) => this.#accept(data),
      startNotifications: async () => {
        this.notificationsStarted++
        this.#notifying = true
        return characteristic
      },
      stopNotifications: async () => {
        this.notificationsStopped++
        this.#notifying = false
        return characteristic
      },
      addEventListener: (_type, listener) => {
        this.#listeners.add(listener)
      },
      removeEventListener: (_type, listener) => {
        this.#listeners.delete(listener)
      },
    }
    this.#characteristic = characteristic

    // One object serves both directions, which is both the HM-10 shape and the
    // stricter case: anything that works here works when they are two objects.
    this.write = characteristic
    this.notify = characteristic

    this.#gatt = {
      connected: true,
      disconnect: () => {
        this.#gatt.connected = false
      },
    }

    this.device = {
      id: 'fake-device',
      name: opts.deviceName ?? 'FAKE RADIO',
      gatt: this.#gatt,
      addEventListener: (_type, listener) => {
        this.#dropListeners.add(listener)
      },
      removeEventListener: (_type, listener) => {
        this.#dropListeners.delete(listener)
      },
    }
  }

  get connected(): boolean {
    return this.#gatt.connected
  }

  get listenerCount(): number {
    return this.#listeners.size
  }

  get notifying(): boolean {
    return this.#notifying
  }

  /** Concatenation of everything written, for assertions. */
  writtenBytes(): Uint8Array {
    const total = this.writes.reduce((n, c) => n + c.length, 0)
    const out = new Uint8Array(total)
    let off = 0
    for (const c of this.writes) {
      out.set(c, off)
      off += c.length
    }
    return out
  }

  writtenHex(): string {
    return hexDump(this.writtenBytes())
  }

  async #accept(data: Uint8Array): Promise<void> {
    const max = this.#opts.maxWriteBytes
    if (max !== undefined && data.length > max) {
      throw new Error(`FakeGattLink: write of ${data.length} bytes exceeds the ${max}-byte MTU payload`)
    }
    this.writes.push(Uint8Array.from(data))
    const reply = this.#opts.respond?.(Uint8Array.from(data), this)
    if (reply && reply.length) {
      if (this.#opts.latencyMs) await new Promise((r) => setTimeout(r, this.#opts.latencyMs))
      this.push(reply)
    }
  }

  /**
   * Notify bytes to the host, fragmented the way a peripheral would.
   *
   * Silently does nothing when notifications have not been started, because
   * that is what a real characteristic does - and a port that forgot to call
   * `startNotifications` should look like a radio that never answers, which is
   * exactly what a real user would see.
   */
  push(data: Uint8Array): void {
    if (!this.#notifying) return
    const size = Math.max(1, this.#opts.notifyChunk ?? 20)
    if (this.#scratch.length < size) this.#scratch = new Uint8Array(size)

    for (let off = 0; off < data.length; off += size) {
      const end = Math.min(off + size, data.length)
      this.#scratch.set(data.subarray(off, end), 0)
      this.#characteristic.value = {
        buffer: this.#scratch.buffer,
        byteOffset: this.#scratch.byteOffset,
        byteLength: end - off,
      }
      for (const listener of [...this.#listeners]) listener({ target: this.notify })
    }
  }

  pushHex(hex: string): void {
    this.push(fromHex(hex))
  }

  /** Simulate the radio walking out of range. */
  drop(): void {
    this.#gatt.connected = false
    for (const listener of [...this.#dropListeners]) listener()
  }
}

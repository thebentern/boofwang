// SPDX-License-Identifier: GPL-3.0-or-later
import { normaliseUuid } from './bluetooth-uuids.js'
import type { BleCharacteristicProperties, BleClientLike, BleServiceInfo } from './native-gatt.js'

/**
 * A scripted stand-in for the native BLE plugin's `BleClient`.
 *
 * The counterpart of `FakeGattLink`, one layer lower: where that fake stands
 * in for a pair of characteristics, this one stands in for the whole plugin,
 * so `connectNativeGattLink` can be driven end to end - enumeration, profile
 * selection, the real `BluetoothPort`, the real `SerialTransport` - in plain
 * Node, without a phone, an adapter or a radio.
 *
 * What it deliberately reproduces:
 *
 * - **A device is a table of services.** Profile selection is only worth
 *   testing against a device that carries the wrong service, or the right
 *   service with the wrong characteristic, and a table makes both one line.
 * - **Our own disconnect fires the disconnect callback.** The plugin reports
 *   every disconnect through the callback given to `connect`, ours included,
 *   because natively it is one connection-state event either way. A link that
 *   mistook that for the radio walking off would report a drop to a user who
 *   asked for the link to end.
 * - **Notifications share one buffer.** Same trap `FakeGattLink` springs: the
 *   `DataView` handed to a callback is over memory the stack reuses, so a
 *   port that keeps it instead of copying finds its bytes rewritten.
 * - **A write's `DataView` is kept, not copied.** The plugin serialises the
 *   view when its own queue reaches the write, not when the call is made, so
 *   the fake holds the view it was handed. A link that did not copy first
 *   would show the caller's later edits in `writes`.
 *
 * What it cannot reproduce is the platform itself: permissions, the scan, how
 * iOS behaves when a connect races a disconnect, and what a real MTU
 * negotiation grants. Those still need a phone and a radio.
 */

export interface FakeBleCharacteristic {
  readonly properties: BleCharacteristicProperties
  /** Called for each write to this characteristic; return bytes to notify back. */
  respond?(bytes: Uint8Array): Uint8Array | Uint8Array[] | undefined
}

/** `{ [serviceUuid]: { [characteristicUuid]: characteristic } }`, UUIDs in any spelling. */
export type FakeBleServiceTable = Readonly<Record<string, Readonly<Record<string, FakeBleCharacteristic>>>>

export interface FakeBleClientOptions {
  services: FakeBleServiceTable
  /**
   * Which platform's surface to present.
   *
   * Android has `requestMtu`, `getMtu` and `requestConnectionPriority`; iOS
   * has none of them, and the link has to cope with their absence rather than
   * with a stub that quietly answers.
   */
  platform?: 'android' | 'ios'
  /** What `getMtu` answers, on Android. Defaults to 23, the ATT minimum. */
  mtu?: number
  /**
   * How much of a reply one notification carries.
   *
   * Defaults to 20, the payload of the default ATT MTU, so a reply longer
   * than that arrives in pieces exactly as it would from a real peripheral.
   */
  notifyChunk?: number
}

export interface FakeBleWrite {
  readonly service: string
  readonly characteristic: string
  /** A view over the `DataView` handed in - see the header on why it is not copied. */
  readonly bytes: Uint8Array
  /** True for `write`, false for `writeWithoutResponse`. */
  readonly acknowledged: boolean
}

/**
 * A table may spell a UUID short and the link will always ask long, because
 * the real plugin accepts either. Anything that is not a UUID is kept as
 * typed, so a test can still describe a device that enumerates nonsense.
 */
function canonical(uuid: string): string {
  try {
    return normaliseUuid(uuid)
  } catch {
    return uuid.toLowerCase()
  }
}

function key(service: string, characteristic: string): string {
  return `${canonical(service)}/${canonical(characteristic)}`
}

export class FakeBleClient implements BleClientLike {
  /** Every write, one entry per plugin call. */
  readonly writes: FakeBleWrite[] = []
  readonly mtuRequests: number[] = []
  readonly priorityRequests: number[] = []
  connected = false
  connectCount = 0
  disconnectCount = 0

  requestMtu?: (deviceId: string, mtu: number) => Promise<void>
  getMtu?: (deviceId: string) => Promise<number>
  requestConnectionPriority?: (deviceId: string, priority: number) => Promise<void>

  #opts: FakeBleClientOptions
  #onDisconnect: ((deviceId: string) => void) | undefined
  #deviceId: string | undefined
  #callbacks = new Map<string, (value: DataView) => void>()
  /**
   * One buffer behind every notification, reused on purpose. See the header.
   */
  #scratch = new Uint8Array(0)

  constructor(opts: FakeBleClientOptions) {
    this.#opts = opts
    if ((opts.platform ?? 'android') === 'android') {
      this.requestMtu = async (_deviceId, mtu) => {
        this.mtuRequests.push(mtu)
      }
      this.getMtu = async () => opts.mtu ?? 23
      this.requestConnectionPriority = async (_deviceId, priority) => {
        this.priorityRequests.push(priority)
      }
    }
  }

  /** The buffer every notification is delivered through, for a test to scribble on. */
  get scratch(): Uint8Array {
    return this.#scratch
  }

  get notifying(): string[] {
    return [...this.#callbacks.keys()]
  }

  async connect(deviceId: string, onDisconnect?: (deviceId: string) => void): Promise<void> {
    this.connectCount++
    this.connected = true
    this.#deviceId = deviceId
    this.#onDisconnect = onDisconnect
  }

  async disconnect(deviceId: string): Promise<void> {
    this.disconnectCount++
    if (!this.connected) return
    this.connected = false
    this.#callbacks.clear()
    this.#onDisconnect?.(deviceId)
  }

  async getServices(): Promise<BleServiceInfo[]> {
    this.#requireConnected('getServices')
    return Object.entries(this.#opts.services).map(([uuid, chars]) => ({
      uuid,
      characteristics: Object.entries(chars).map(([cuuid, c]) => ({ uuid: cuuid, properties: c.properties })),
    }))
  }

  async startNotifications(
    _deviceId: string,
    service: string,
    characteristic: string,
    callback: (value: DataView) => void,
  ): Promise<void> {
    this.#requireConnected('startNotifications')
    const c = this.#characteristic(service, characteristic)
    if (!c.properties.notify && !c.properties.indicate) {
      throw new Error(`FakeBleClient: ${characteristic} does not notify`)
    }
    this.#callbacks.set(key(service, characteristic), callback)
  }

  async stopNotifications(_deviceId: string, service: string, characteristic: string): Promise<void> {
    this.#callbacks.delete(key(service, characteristic))
  }

  async write(_deviceId: string, service: string, characteristic: string, value: DataView): Promise<void> {
    this.#requireConnected('write')
    const c = this.#characteristic(service, characteristic)
    if (!c.properties.write) throw new Error(`FakeBleClient: ${characteristic} does not take an acknowledged write`)
    this.#accept(service, characteristic, c, value, true)
  }

  async writeWithoutResponse(
    _deviceId: string,
    service: string,
    characteristic: string,
    value: DataView,
  ): Promise<void> {
    this.#requireConnected('writeWithoutResponse')
    const c = this.#characteristic(service, characteristic)
    if (!c.properties.writeWithoutResponse) {
      throw new Error(`FakeBleClient: ${characteristic} does not take an unacknowledged write`)
    }
    this.#accept(service, characteristic, c, value, false)
  }

  /**
   * Notify bytes to the host, fragmented the way a peripheral would.
   *
   * Silently does nothing when nobody has subscribed, because that is what a
   * real peripheral does - and a link that forgot to start notifications
   * should look like a radio that never answers.
   */
  notify(service: string, characteristic: string, data: Uint8Array): void {
    const callback = this.#callbacks.get(key(service, characteristic))
    if (!callback) return
    const size = Math.max(1, this.#opts.notifyChunk ?? 20)
    if (this.#scratch.length < size) this.#scratch = new Uint8Array(size)

    for (let off = 0; off < data.length; off += size) {
      const end = Math.min(off + size, data.length)
      this.#scratch.set(data.subarray(off, end), 0)
      callback(new DataView(this.#scratch.buffer, this.#scratch.byteOffset, end - off))
    }
  }

  /** Simulate the radio walking out of range. */
  drop(): void {
    if (!this.connected) return
    this.connected = false
    this.#callbacks.clear()
    this.#onDisconnect?.(this.#deviceId ?? '')
  }

  #accept(
    service: string,
    characteristic: string,
    c: FakeBleCharacteristic,
    value: DataView,
    acknowledged: boolean,
  ): void {
    const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
    this.writes.push({ service, characteristic, bytes, acknowledged })
    const reply = c.respond?.(Uint8Array.from(bytes))
    if (!reply) return
    for (const chunk of Array.isArray(reply) ? reply : [reply]) {
      if (chunk.length) this.notify(service, characteristic, chunk)
    }
  }

  #characteristic(service: string, characteristic: string): FakeBleCharacteristic {
    const wanted = key(service, characteristic)
    for (const [suuid, chars] of Object.entries(this.#opts.services)) {
      for (const [cuuid, c] of Object.entries(chars)) {
        if (key(suuid, cuuid) === wanted) return c
      }
    }
    throw new Error(`FakeBleClient: no characteristic ${characteristic} in service ${service}`)
  }

  #requireConnected(op: string): void {
    if (!this.connected) throw new Error(`FakeBleClient: not connected (while attempting: ${op})`)
  }
}

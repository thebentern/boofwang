// SPDX-License-Identifier: GPL-3.0-or-later
import type {
  BluetoothLink,
  DataViewLike,
  GattCharacteristicLike,
  GattDeviceLike,
  GattNotification,
} from './bluetooth-port.js'
import { normaliseUuid, type BluetoothProfile } from './bluetooth-uuids.js'
import { TransportError } from './errors.js'

/**
 * A `BluetoothLink` over a native BLE plugin instead of `navigator.bluetooth`.
 *
 * The mobile shell reaches a radio through `@capacitor-community/bluetooth-le`,
 * whose `BleClient` is keyed by device id and speaks in service and
 * characteristic UUID strings rather than in characteristic objects. This file
 * folds that API into the two-characteristic shape `BluetoothPort` already
 * consumes, so the port, the transport and every driver above them are
 * untouched - the same seam that lets the dev bridge hand them a WebSocket.
 *
 * What differs from the browser path, and why each difference is absorbed
 * here rather than in the port:
 *
 * 1. **Disconnect is a promise.** Web Bluetooth's `gatt.disconnect()` is
 *    synchronous, so `BluetoothPort.close()` calls it and moves on. The
 *    plugin's is asynchronous, and on iOS a `connect` issued while the previous
 *    `disconnect` is still in flight is refused or, worse, silently reuses the
 *    dying session. `NativeGattLink.closed` exists so a reconnect can wait for
 *    the disconnect to finish before starting.
 *
 * 2. **The enumeration is readable.** Web Bluetooth hands over only the
 *    services named up front, so a profile that fails there fails blind. The
 *    plugin lists everything the device carries, and a profile miss here says
 *    what the device actually has - which is the fact somebody adding a radio
 *    needs.
 *
 * 3. **The MTU can be asked for, and read back.** Android lets a central
 *    request a larger ATT MTU and report what was granted; iOS negotiates on
 *    its own and reports nothing. `writeBytesForMtu` turns the answer, when
 *    there is one, into the port's `maxWriteBytes`, and stays at the port's
 *    own default otherwise.
 *
 * Nothing here has been run against a radio. It is covered by
 * `test/lib/transport/native-gatt.spec.ts` against `FakeBleClient`.
 */

/** What the plugin reports a characteristic can do. */
export interface BleCharacteristicProperties {
  readonly read?: boolean
  readonly write?: boolean
  readonly writeWithoutResponse?: boolean
  readonly notify?: boolean
  readonly indicate?: boolean
}

export interface BleCharacteristicInfo {
  readonly uuid: string
  readonly properties: BleCharacteristicProperties
}

export interface BleServiceInfo {
  readonly uuid: string
  readonly characteristics: readonly BleCharacteristicInfo[]
}

/**
 * The structural subset of the plugin's `BleClient` this needs.
 *
 * Declared rather than imported for the same reason `GattCharacteristicLike`
 * is declared rather than taken from `@types/web-bluetooth`: `lib/` compiles
 * with no DOM types and no Capacitor, its tests run in plain Node, and the
 * mobile shell's plugin is host code that `lib/` must never depend on. The
 * three MTU and priority methods are optional because they exist on Android
 * and not on iOS, and a link has to work on both.
 */
export interface BleClientLike {
  connect(deviceId: string, onDisconnect?: (deviceId: string) => void): Promise<void>
  disconnect(deviceId: string): Promise<void>
  getServices(deviceId: string): Promise<BleServiceInfo[]>
  startNotifications(
    deviceId: string,
    service: string,
    characteristic: string,
    callback: (value: DataView) => void,
  ): Promise<void>
  stopNotifications(deviceId: string, service: string, characteristic: string): Promise<void>
  write(deviceId: string, service: string, characteristic: string, value: DataView): Promise<void>
  writeWithoutResponse(deviceId: string, service: string, characteristic: string, value: DataView): Promise<void>
  requestMtu?(deviceId: string, mtu: number): Promise<void>
  getMtu?(deviceId: string): Promise<number>
  requestConnectionPriority?(deviceId: string, priority: number): Promise<void>
}

export interface NativeGattLink extends BluetoothLink {
  readonly device: GattDeviceLike
  /** The candidate that matched the device's enumeration. */
  readonly profile: BluetoothProfile
  /**
   * Settled once the plugin's disconnect has completed, or the device dropped.
   *
   * `BluetoothPort.close()` calls `device.gatt.disconnect()` synchronously and
   * does not await it, because Web Bluetooth's is synchronous and there is
   * nothing to await. The plugin's returns a promise, and a write started
   * straight after a read would otherwise race the previous disconnect on
   * iOS. Anyone reconnecting to the same device awaits this first.
   */
  readonly closed: Promise<void>
}

export class NativeGattError extends TransportError {
  override readonly name = 'NativeGattError'
}

export interface NativeGattOptions {
  /**
   * The ATT MTU to ask for, where the platform allows asking.
   *
   * 247 is what Android grants almost universally and what the port's largest
   * single write (244 bytes) is sized for. Left unset, nothing is requested
   * and the port keeps its 20-byte default.
   */
  requestMtu?: number
}

/**
 * The largest payload one GATT write may carry at a given ATT MTU.
 *
 * Three bytes of every ATT packet are the opcode and handle. 20 is the payload
 * of the default 23-byte MTU, the default the port already uses, and the only
 * size guaranteed to go out as a single unfragmented write - so a reported
 * MTU that is smaller than the default, or nonsense, floors there rather than
 * shrinking a write below what every peripheral accepts. 244 is the largest
 * single ATT write at the 247 MTU Android negotiates; past it a write becomes
 * a queued long write that plenty of cheap peripherals mishandle, however
 * large the MTU claims to be.
 */
export function writeBytesForMtu(mtu: number | undefined): number | undefined {
  if (mtu === undefined) return undefined
  const payload = Math.min(mtu - 3, 244)
  return payload < 20 ? 20 : payload
}

/** HIGH, in the plugin's `ConnectionPriority` numbering. */
const CONNECTION_PRIORITY_HIGH = 1

function safeUuid(value: string): string | undefined {
  try {
    return normaliseUuid(value)
  } catch {
    // A device may enumerate a UUID in a form nobody anticipated. It cannot
    // match a profile either way, and one bad entry must not hide the rest.
    return undefined
  }
}

/**
 * Connect to a device, find the first candidate profile it carries, and wrap
 * the pair of characteristics as a `BluetoothLink`.
 *
 * Candidates are tried in order because that is what the browser path does
 * and what the profile lists were written for: `BL1_DONGLE_PROFILES` leads
 * with the shape a real dongle enumerated as. Matching is by service only,
 * on the normalised form of both sides, since a plugin may hand back a
 * 16-bit alias where a profile holds the 128-bit expansion.
 */
export async function connectNativeGattLink(
  client: BleClientLike,
  device: { deviceId: string; name?: string | null },
  candidates: readonly BluetoothProfile[],
  opts: NativeGattOptions = {},
): Promise<{ link: NativeGattLink; maxWriteBytes: number | undefined }> {
  const id = device.deviceId

  const dropListeners = new Set<() => void>()
  let connected = false
  let resolveClosed: () => void = () => {}
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve
  })

  // The plugin reports every disconnect through this callback, ours included.
  // That is fine for the same reason it is fine in the browser: the port
  // removes its `gattserverdisconnected` listener before it disconnects, so
  // a disconnect we asked for reaches nobody.
  await client.connect(id, () => {
    connected = false
    resolveClosed()
    for (const listener of [...dropListeners]) listener()
  })
  connected = true

  const dropConnection = async (): Promise<void> => {
    connected = false
    try {
      await client.disconnect(id)
    } catch {
      /* the link is going away regardless */
    }
    resolveClosed()
  }

  let services: BleServiceInfo[]
  try {
    services = await client.getServices(id)
  } catch (e) {
    await dropConnection()
    throw new NativeGattError(
      `The device ${device.name ?? id} connected but its services could not be listed: ` +
        (e instanceof Error ? e.message : String(e)),
    )
  }

  const byUuid = new Map<string, BleServiceInfo>()
  for (const s of services) {
    const uuid = safeUuid(s.uuid)
    if (uuid !== undefined && !byUuid.has(uuid)) byUuid.set(uuid, s)
  }

  let profile: BluetoothProfile | undefined
  let service: BleServiceInfo | undefined
  for (const candidate of candidates) {
    const found = byUuid.get(normaliseUuid(candidate.service))
    if (found) {
      profile = candidate
      service = found
      break
    }
  }

  if (!profile || !service) {
    await dropConnection()
    // The browser path cannot say this: Web Bluetooth only hands over the
    // services named in `optionalServices`, so a miss there is a miss into
    // the dark. Here the device's whole enumeration is available, and it is
    // exactly what somebody chasing a new radio needs to see.
    const tried = candidates.map((c) => `${c.label} (${c.service})`).join(', ')
    const carried = [...byUuid.keys()].join(', ') || '(no services at all)'
    throw new NativeGattError(
      `The device ${device.name ?? id} carries none of the services tried. ` +
        `Tried: ${tried || '(no candidates)'}. The device has: ${carried}.`,
    )
  }

  const serviceUuid = normaliseUuid(profile.service)
  const writeUuid = normaliseUuid(profile.write)
  const notifyUuid = normaliseUuid(profile.notify)

  const characteristics = new Map<string, BleCharacteristicInfo>()
  for (const c of service.characteristics) {
    const uuid = safeUuid(c.uuid)
    if (uuid !== undefined && !characteristics.has(uuid)) characteristics.set(uuid, c)
  }

  const missing = [writeUuid, notifyUuid].filter((u) => !characteristics.has(u))
  if (missing.length > 0) {
    await dropConnection()
    // Same reasoning as the service miss above: the profile named a
    // characteristic the service does not hold, and the honest error lists
    // what it does hold rather than letting the first write fail with the
    // plugin's own wording, which names neither.
    throw new NativeGattError(
      `The service ${serviceUuid} on ${device.name ?? id} does not carry ` +
        `${[...new Set(missing)].join(' or ')}, which the ${profile.label} profile expects. ` +
        `It carries: ${[...characteristics.keys()].join(', ') || '(nothing)'}.`,
    )
  }

  // Both writes copy before handing over. The port already slices what it
  // sends, but this object is also reachable directly, and the plugin reads
  // the `DataView` when its own queue gets to the write rather than when the
  // call is made - so a caller that reuses its buffer would otherwise send
  // whatever the buffer held by then.
  const asDataView = (data: Uint8Array): DataView => new DataView(data.slice().buffer)
  const writeMethods = (uuid: string): Pick<GattCharacteristicLike, 'writeValueWithResponse' | 'writeValueWithoutResponse'> => ({
    writeValueWithResponse: (data) => client.write(id, serviceUuid, uuid, asDataView(data)),
    writeValueWithoutResponse: (data) => client.writeWithoutResponse(id, serviceUuid, uuid, asDataView(data)),
  })
  const propertiesOf = (uuid: string): NonNullable<GattCharacteristicLike['properties']> => {
    const p = characteristics.get(uuid)!.properties
    return {
      ...(p.write === undefined ? {} : { write: p.write }),
      ...(p.writeWithoutResponse === undefined ? {} : { writeWithoutResponse: p.writeWithoutResponse }),
      ...(p.notify === undefined ? {} : { notify: p.notify }),
      ...(p.indicate === undefined ? {} : { indicate: p.indicate }),
    }
  }

  const notifyListeners = new Set<(ev: GattNotification) => void>()
  let latest: DataViewLike | null = null

  const notify: GattCharacteristicLike = {
    uuid: notifyUuid,
    get value() {
      return latest
    },
    properties: propertiesOf(notifyUuid),
    // The write methods are attached here only when one characteristic
    // carries both directions - the HM-10 shape the UV-5R Mini has - so that
    // `write` and `notify` are one object, as they are in the browser.
    ...(writeUuid === notifyUuid ? writeMethods(notifyUuid) : {}),
    startNotifications: () =>
      client.startNotifications(id, serviceUuid, notifyUuid, (view) => {
        latest = view
        for (const listener of [...notifyListeners]) listener({ target: notify })
      }),
    stopNotifications: () => client.stopNotifications(id, serviceUuid, notifyUuid),
    addEventListener: (_type, listener) => {
      notifyListeners.add(listener)
    },
    removeEventListener: (_type, listener) => {
      notifyListeners.delete(listener)
    },
  }

  const write: GattCharacteristicLike =
    writeUuid === notifyUuid
      ? notify
      : {
          uuid: writeUuid,
          properties: propertiesOf(writeUuid),
          ...writeMethods(writeUuid),
          // Required by the shape, never called on this side by the port.
          // Subscribing to a write-only handle would only draw a plugin error.
          startNotifications: async () => undefined,
          addEventListener: () => {},
          removeEventListener: () => {},
        }

  const gatt = {
    get connected() {
      return connected
    },
    disconnect: () => {
      // Deliberately not awaited: `BluetoothPort.close()` cannot await it.
      // The promise is what `closed` settles on.
      void dropConnection()
    },
  }

  const gattDevice: GattDeviceLike = {
    id,
    ...(device.name === undefined || device.name === null ? {} : { name: device.name }),
    gatt,
    addEventListener: (_type, listener) => {
      dropListeners.add(listener)
    },
    removeEventListener: (_type, listener) => {
      dropListeners.delete(listener)
    },
  }

  let maxWriteBytes: number | undefined
  if (opts.requestMtu !== undefined && client.requestMtu) {
    // Best effort throughout. A refused request leaves the default MTU in
    // force, and the port's 20-byte default is correct for that; a request
    // that succeeded but cannot be read back is treated the same way, since
    // guessing upward is how a write turns into a long write.
    try {
      await client.requestMtu(id, opts.requestMtu)
    } catch {
      /* the platform or the peripheral declined; 20 bytes still works */
    }
    if (client.getMtu) {
      try {
        maxWriteBytes = writeBytesForMtu(await client.getMtu(id))
      } catch {
        /* not reported; stay at the default */
      }
    }
  }

  if (client.requestConnectionPriority) {
    // HIGH shortens the connection interval. Every acknowledged write is a
    // round trip, so a transfer of a few thousand 20-byte writes is paced by
    // that interval more than by anything else.
    try {
      await client.requestConnectionPriority(id, CONNECTION_PRIORITY_HIGH)
    } catch {
      /* a preference, not a requirement */
    }
  }

  const link: NativeGattLink = {
    write,
    notify,
    device: gattDevice,
    label: device.name ?? undefined,
    profile,
    closed,
  }

  return { link, maxWriteBytes }
}

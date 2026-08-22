// SPDX-License-Identifier: GPL-3.0-or-later
import { BluetoothPort, type GattCharacteristicLike, type GattDeviceLike } from '#core/transport/bluetooth-port.js'
import {
  bluetoothProfile,
  parseBluetoothProfile,
  resetBluetoothProfile,
  setBluetoothProfile,
  type BluetoothProfile,
} from '#core/transport/bluetooth-uuids.js'
import type { PortChoice } from '~/composables/useWebSerial'

/**
 * The only place in boofwang that touches `navigator.bluetooth`.
 *
 * The counterpart of `useWebSerial`, and the same division of labour: this file
 * owns the chooser, the permission grant and service discovery, and hands the
 * rest of the app a `SerialPortLike`. Everything below that seam - the
 * transport, the framing, every driver and every screen - cannot tell a GATT
 * link from a cable, which is what made this a small change rather than a
 * parallel stack.
 *
 * A radio has answered over this link and a whole codeplug has come back down
 * it. The service and characteristic were captured from a UV-5R Mini in
 * wireless CPS mode and confirmed by sending it its own identify magic; the
 * full 33,344-byte read followed on 2026-08-21, at about 928 B/s, and matches
 * the cable read on all 999 channel records. Writing over Bluetooth is still
 * deliberately not offered - read first, prove the round trip, then write.
 */

export function bluetoothAvailable(): boolean {
  return typeof navigator !== 'undefined' && 'bluetooth' in navigator
}

/**
 * A UUID set supplied in the URL, for the person holding a radio.
 *
 * `?ble=<service>,<write>,<notify>` overrides the built-in profile for the rest
 * of the session; `?ble=scan` keeps the profile but drops the chooser's filter;
 * `?ble=off` clears both.
 *
 * This works in a production build, unlike the dev serial bridge, and
 * deliberately so: the only way anyone finds the real UUIDs is with a radio in
 * front of them, and asking them to check out a repository and run a dev server
 * first is asking them not to bother.
 *
 * Remembered in `sessionStorage` because client-side navigation drops the query
 * string - the same trap `bridgeUrl` documents, and it fails just as quietly.
 */
const BLE_KEY = 'boofwang:ble'

export function bluetoothOverride(): string | null {
  if (typeof window === 'undefined') return null

  const params = new URLSearchParams(window.location.search)
  if (params.has('ble')) {
    const value = params.get('ble') ?? ''
    if (value === 'off' || value === '') {
      sessionStorage.removeItem(BLE_KEY)
      return null
    }
    sessionStorage.setItem(BLE_KEY, value)
    return value
  }
  return sessionStorage.getItem(BLE_KEY)
}

/**
 * The profile this session will use, and whether the chooser should filter.
 *
 * An unparseable override is reported rather than silently ignored: someone who
 * pasted a UUID wrongly is one character away from success and deserves to be
 * told which character.
 */
export function resolveBluetoothProfile(): { profile: BluetoothProfile; scan: boolean } {
  const override = bluetoothOverride()
  if (!override) {
    resetBluetoothProfile()
    return { profile: bluetoothProfile(), scan: false }
  }
  if (override === 'scan') return { profile: bluetoothProfile(), scan: true }

  const profile = parseBluetoothProfile(override)
  setBluetoothProfile(profile)
  return { profile, scan: false }
}

export function describeBluetoothDevice(name: string | null | undefined): string {
  return name && name.length > 0 ? `${name} over Bluetooth` : 'a Bluetooth radio'
}

/**
 * Prompt for a radio, connect to it, and wrap it as a port.
 *
 * Must be called from a user gesture: `requestDevice` needs transient
 * activation and throws otherwise, exactly like `requestPort`. The chooser it
 * opens belongs to the browser - we cannot style it, read it, or tell whether
 * anything was in it.
 *
 * The chooser lists only what its filters match, and those filters are matched
 * against the device's **advertisement**. The UV-5R Mini advertises neither its
 * service nor a name, so no filter reaches it and `profile.filterable` is false
 * - which makes `acceptAllDevices` the route rather than the fallback. The cost
 * is a chooser holding every Bluetooth device in range, which is why the card
 * tells the user what the radio calls itself.
 */
export async function requestBluetoothRadio(opts: { everyDevice?: boolean } = {}): Promise<PortChoice | null> {
  if (!bluetoothAvailable()) throw new Error('This browser does not support Web Bluetooth.')

  const { profile, scan } = resolveBluetoothProfile()

  /*
   * `optionalServices` is what the two branches share and the reason neither
   * can be dropped: Web Bluetooth will not hand over a service that was not
   * named up front, whether or not it was filtered on.
   */
  const everyDevice = scan || opts.everyDevice || !profile.filterable

  let device: BluetoothDevice
  try {
    device = await navigator.bluetooth.requestDevice(
      everyDevice
        ? { acceptAllDevices: true, optionalServices: [profile.service] }
        : { filters: [{ services: [profile.service] }], optionalServices: [profile.service] },
    )
  } catch (e) {
    // The user dismissing the chooser is not an error worth surfacing, which is
    // the same call `requestPort` makes for the same DOMException.
    if (e instanceof DOMException && e.name === 'NotFoundError') return null
    throw e
  }

  const server = await device.gatt?.connect()
  if (!server) throw new Error(`${device.name ?? 'That device'} would not accept a GATT connection.`)

  let service: BluetoothRemoteGATTService
  try {
    service = await server.getPrimaryService(profile.service)
  } catch {
    device.gatt?.disconnect()
    /*
     * The device connected and does not have the service we expected.
     *
     * Web Bluetooth will not enumerate services that were not named up front,
     * so the app genuinely cannot list what the radio does have - that has to
     * come from a Bluetooth scanner such as nRF Connect. Saying so is more use
     * than a generic failure, because it names the next step precisely.
     */
    throw new Error(
      `${device.name ?? 'That device'} does not offer the ${profile.label} service ` +
        `(${profile.service}). That UUID was read off a UV-5R Mini in wireless CPS mode, so this is most ` +
        'likely a different device from the chooser rather than a wrong number. If it is the radio, read ' +
        'its real service and characteristic with a Bluetooth scanner such as nRF Connect, then reload ' +
        'with ?ble=service,write,notify to try them.',
    )
  }

  const write = await service.getCharacteristic(profile.write)
  // One characteristic may carry both directions - the HM-10 modules do - and
  // asking for the same UUID twice is not guaranteed to give the same object.
  const notify = profile.notify === profile.write ? write : await service.getCharacteristic(profile.notify)

  const port = new BluetoothPort({
    write: write as unknown as GattCharacteristicLike,
    notify: notify as unknown as GattCharacteristicLike,
    device: device as unknown as GattDeviceLike,
    label: device.name ?? 'Bluetooth radio',
  })

  return { port, info: {}, label: describeBluetoothDevice(device.name) }
}

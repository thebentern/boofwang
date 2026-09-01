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
 * the cable read on all 999 channel records. The session will reconnect over
 * Bluetooth for a write, and the UV-5R Mini driver refuses it there - the
 * write gate shows why before the token is typed. Read first, prove the round
 * trip, then turn it on.
 */

export function bluetoothAvailable(): boolean {
  return typeof navigator !== 'undefined' && 'bluetooth' in navigator
}

/**
 * A UUID set supplied in the URL, for the person holding a radio.
 *
 * `?ble=<service>,<write>,<notify>` overrides the built-in profile for the rest
 * of the session; `?ble=scan` keeps the profile but drops the chooser's filter;
 * `?ble=off` clears both. A `uart:` prefix on the UUID form marks the device
 * as a BLE-to-UART dongle, so the driver treats the radio behind it as cabled.
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
 *
 * `overridden` says whether a `?ble=` UUID set is in force. The dongle path
 * needs to know: an override always wins - it exists for chasing hardware
 * this build does not know - and a caller's candidate list steps aside for it.
 */
export function resolveBluetoothProfile(): { profile: BluetoothProfile; scan: boolean; overridden: boolean } {
  const override = bluetoothOverride()
  if (!override) {
    resetBluetoothProfile()
    return { profile: bluetoothProfile(), scan: false, overridden: false }
  }
  if (override === 'scan') return { profile: bluetoothProfile(), scan: true, overridden: false }

  const profile = parseBluetoothProfile(override)
  setBluetoothProfile(profile)
  return { profile, scan: false, overridden: true }
}

export function describeBluetoothDevice(name: string | null | undefined, profile?: BluetoothProfile): string {
  // A dongle session names the dongle. The radio behind one is not a
  // Bluetooth radio, and a label claiming it is would be the app repeating
  // the conflation this profile field exists to end.
  if (profile?.radioLink === 'serial') {
    return name && name.length > 0 ? `${name}, a Bluetooth dongle` : 'a Bluetooth dongle'
  }
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
 * against the device's **advertisement** - not against anything discoverable
 * after connecting. FFE0 came from a GATT enumeration, so the name prefixes sit
 * alongside it rather than trusting it alone. `everyDevice` drops both, for a
 * radio advertising neither.
 */
/**
 * The last radio the user granted, kept so a write does not ask again.
 *
 * A `BluetoothDevice` stays granted for as long as the page holds it, and
 * `gatt.connect()` on one needs no transient activation - unlike
 * `requestDevice`. That is the whole reason this is worth keeping: reading
 * closes the port and `BluetoothPort` drops the GATT link deliberately, so by
 * the time someone has edited a channel there is no live link, and without
 * this the write would have to raise a second chooser for a radio the user
 * has already picked once.
 */
let granted: { device: BluetoothDevice; profile: BluetoothProfile } | null = null

export async function requestBluetoothRadio(
  opts: { everyDevice?: boolean; profiles?: readonly BluetoothProfile[] } = {},
): Promise<PortChoice | null> {
  if (!bluetoothAvailable()) throw new Error('This browser does not support Web Bluetooth.')

  /*
   * Which profiles to try. A `?ble=` override beats a caller's candidates -
   * it exists for chasing hardware this build does not know, and the dongle
   * button must not take that tool away. Otherwise the caller's list stands
   * (the dongle path passes its two GATT guesses), and with neither, the
   * resolved default is exactly the single-profile path this function always
   * had.
   */
  const resolved = resolveBluetoothProfile()
  const candidates = resolved.overridden ? [resolved.profile] : (opts.profiles ?? [resolved.profile])
  /*
   * Two different lists, and conflating them emptied a chooser in a shipped
   * build.
   *
   * `filters` may only name services a device ADVERTISES. `optionalServices`
   * must name every service we will later ask `getPrimaryService` for, because
   * Web Bluetooth refuses to hand over one that was not declared up front.
   * They overlap for most devices and do not for the `BF_Writer` dongle,
   * which advertises BF98 and keeps its characteristics in FF00 - so a filter
   * built from the connect-time service listed nothing at all.
   */
  const advertised = [...new Set(candidates.flatMap((c) => c.advertisedServices ?? [c.service]))]
  const services = [...new Set([...candidates.map((c) => c.service), ...advertised])]

  /*
   * Filters are OR-ed by the browser: "advertises one of these services, or
   * is named like one of these". `optionalServices` goes on both branches,
   * the "show every device" hatch included, or that hatch strands whichever
   * candidate it did not list.
   */
  const filters = [
    ...[...new Set(candidates.flatMap((c) => c.namePrefixes))].map((namePrefix) => ({ namePrefix })),
    ...advertised.map((service) => ({ services: [service] })),
  ]

  let device: BluetoothDevice
  try {
    device = await navigator.bluetooth.requestDevice(
      resolved.scan || opts.everyDevice
        ? { acceptAllDevices: true, optionalServices: services }
        : { filters, optionalServices: services },
    )
  } catch (e) {
    // The user dismissing the chooser is not an error worth surfacing, which is
    // the same call `requestPort` makes for the same DOMException.
    if (e instanceof DOMException && e.name === 'NotFoundError') return null
    throw e
  }

  // Granted only once the link has proved a service is there. Assigning it
  // first meant a non-radio picked in the chooser was "granted" for the rest
  // of the session, and every later write tried to reconnect to it. The
  // winning profile is remembered with the device: a reconnect that resolved
  // the default afresh would ask a dongle for the UV-5R Mini's service.
  const { choice, profile } = await linkTo(device, candidates)
  granted = { device, profile }
  return choice
}

/**
 * Drop the remembered grant, so the next Bluetooth write opens the chooser.
 *
 * For a reconnect that was refused - the radio is off, out of range, or was
 * never a radio. The grant is still held by the browser; this only stops
 * boofwang reaching for it first.
 */
export function forgetBluetoothGrant(): void {
  granted = null
}

/**
 * Reconnect the radio already granted this session, if there is one.
 *
 * Null rather than a throw when there is nothing to reconnect: the caller's
 * next move is to open the chooser, and a missing grant is the ordinary state
 * on a fresh page rather than a fault.
 *
 * The grant's own profile is what gets reconnected - the one the device
 * actually answered on. Resolving the default afresh here is how a dongle
 * session's write reacquire would have asked the dongle for the UV-5R Mini's
 * service. A live `?ble=` override still wins, as it does everywhere.
 */
export async function reconnectBluetoothRadio(): Promise<PortChoice | null> {
  if (!bluetoothAvailable() || !granted) return null
  const resolved = resolveBluetoothProfile()
  const candidates = resolved.overridden ? [resolved.profile] : [granted.profile]
  const { choice } = await linkTo(granted.device, candidates)
  return choice
}

/**
 * Connect a granted device and wrap it as a port.
 *
 * Shared by the chooser and the reconnect, because everything below the
 * chooser is identical: the same GATT connect, the same service lookup, the
 * same two characteristics. Splitting it the other way - a reconnect that
 * re-ran the chooser - is what would put a second dialogue in front of a
 * write.
 *
 * Candidates are tried in order and the first whose service the device
 * carries wins. A device carries one variant, so the losers cost a failed
 * `getPrimaryService` each on the same connection - the connection is only
 * dropped once every candidate has failed. This is what lets the dongle path
 * offer its two GATT guesses without knowing which one a given unit is.
 */
async function linkTo(
  device: BluetoothDevice,
  candidates: readonly BluetoothProfile[],
): Promise<{ choice: PortChoice; profile: BluetoothProfile }> {
  const server = await device.gatt?.connect()
  if (!server) throw new Error(`${device.name ?? 'That device'} would not accept a GATT connection.`)

  let service: BluetoothRemoteGATTService | null = null
  let profile: BluetoothProfile | null = null
  for (const candidate of candidates) {
    try {
      service = await server.getPrimaryService(candidate.service)
      profile = candidate
      break
    } catch {
      // Not this variant. The next candidate gets the same live connection.
    }
  }

  if (!service || !profile) {
    device.gatt?.disconnect()
    /*
     * The device connected and has none of the services we know to ask for.
     *
     * Web Bluetooth will not enumerate services that were not named up front,
     * so the app genuinely cannot list what the device does have - that has
     * to come from a Bluetooth scanner such as nRF Connect. Saying so is more
     * use than a generic failure, because it names the next step precisely.
     */
    const tried = candidates.map((c) => `${c.label} (${c.service})`).join(', ')
    throw new Error(
      `${device.name ?? 'That device'} does not offer ${candidates.length === 1 ? 'the service' : 'any of the services'} ` +
        `this build knows to try: ${tried}. It may be a different device from the chooser. If it is yours, ` +
        'read its real service and characteristic with a Bluetooth scanner such as nRF Connect, then ' +
        'reload with ?ble=service,write,notify to try them - prefix the list with uart: if the device is ' +
        'a Bluetooth-to-serial dongle.',
    )
  }

  const write = await service.getCharacteristic(profile.write)
  // One characteristic may carry both directions - the HM-10 modules do - and
  // asking for the same UUID twice is not guaranteed to give the same object.
  const notify = profile.notify === profile.write ? write : await service.getCharacteristic(profile.notify)

  const port = new BluetoothPort(
    {
      write: write as unknown as GattCharacteristicLike,
      notify: notify as unknown as GattCharacteristicLike,
      device: device as unknown as GattDeviceLike,
      label: device.name ?? 'Bluetooth radio',
    },
    // What the radio behind this link believes it is on. 'serial' marks a
    // BLE-to-UART dongle, and the block-size decision downstream reads it.
    { radioLink: profile.radioLink ?? 'bluetooth' },
  )

  return {
    choice: { port, info: {}, label: describeBluetoothDevice(device.name, profile) },
    profile,
  }
}

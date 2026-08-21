// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * ===========================================================================
 * THE UUIDS BELOW HAVE NEVER BEEN SEEN ON A RADIO. THIS IS WHERE THEY GO.
 * ===========================================================================
 *
 * `navigator.bluetooth.requestDevice()` needs a service UUID to filter on, and
 * the chooser will not show a radio whose advertised service is not in that
 * filter. So the one fact this whole feature turns on is a 128-bit number that
 * cannot be derived, guessed, or worked out from the protocol: it has to be
 * read off a radio that is actually advertising.
 *
 * `NORDIC_UART` is what these radios are *believed* to use. The reasoning is
 * circumstantial and worth stating plainly, because someone will otherwise
 * assume it was verified:
 *
 *   - The BLE modules in this class of hardware overwhelmingly expose Nordic's
 *     UART Service, because it is what the vendor SDKs ship and what a
 *     serial-cable replacement needs.
 *   - CHIRP reaches these radios over BLE through the operating system's own
 *     serial-port bridge (`/tmp/ttyBLE…` on macOS), which is exactly what that
 *     bridge is built to expose, and which is why CHIRP never had to name a
 *     UUID and cannot tell us one.
 *
 * That is a reasonable default and nothing more. Two of the three numbers could
 * be right and the third wrong, and the symptom would be a chooser that never
 * lists the radio, or a link that connects and then never answers.
 *
 * ## Filling in the real ones
 *
 * Put a phone next to the radio with nRF Connect (or `bluetoothctl`, or
 * Chrome's own `chrome://bluetooth-internals`), pair, and read the service and
 * characteristic list. Then either edit `NORDIC_UART` below - one place, one
 * edit, and every caller follows - or add a new entry to `KNOWN_PROFILES` and
 * make it the default, which keeps the Nordic assumption on record for the next
 * radio.
 *
 * Nothing needs recompiling to *try* a set: the connect screen accepts
 * `?ble=<service>,<write>,<notify>` and hands it to `parseBluetoothProfile`,
 * so a person holding a radio can find the right numbers in one sitting.
 *
 * Set `verified` to true only when a real radio has answered a handshake over
 * the profile. The UI reads that flag to decide whether it is allowed to
 * describe Bluetooth as working.
 */

export interface BluetoothProfile {
  readonly id: string
  readonly label: string
  /**
   * The advertised service, which is both the chooser's filter and the service
   * the characteristics are looked up in.
   */
  readonly service: string
  /**
   * The characteristic this program writes to.
   *
   * In Nordic's naming this is "RX", because the names are written from the
   * peripheral's point of view: the radio receives on it. Naming it `write`
   * here rather than carrying `rx`/`tx` through the code removes the one
   * ambiguity that makes every Nordic UART implementation get wired backwards
   * at least once.
   */
  readonly write: string
  /** The characteristic the radio notifies on - Nordic's "TX". */
  readonly notify: string
  /** True only once a radio has answered a handshake over this profile. */
  readonly verified: boolean
}

/**
 * The Bluetooth SIG base UUID, into which a 16-bit alias expands.
 *
 * Vendors quote short UUIDs (`FFE0`) as often as long ones, and a device
 * filter built from the short form silently matches nothing, so both spellings
 * are accepted and normalised to this.
 */
const BASE_UUID = '0000xxxx-0000-1000-8000-00805f9b34fb'

const FULL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const SHORT_UUID = /^(?:0x)?([0-9a-f]{4}|[0-9a-f]{8})$/

export class BluetoothUuidError extends Error {
  override readonly name = 'BluetoothUuidError'
}

/**
 * Accept either spelling of a UUID and return the canonical long, lower-case one.
 *
 * Web Bluetooth is strict about this and unhelpful about saying so - a
 * mixed-case or short UUID in a filter throws a `TypeError` that names neither
 * the value nor the field.
 */
export function normaliseUuid(value: string): string {
  const trimmed = value.trim().toLowerCase()
  if (FULL_UUID.test(trimmed)) return trimmed

  const short = SHORT_UUID.exec(trimmed)
  if (short) {
    const digits = short[1]!.padStart(8, '0')
    return BASE_UUID.replace('0000xxxx', digits)
  }

  throw new BluetoothUuidError(
    `${JSON.stringify(value)} is not a Bluetooth UUID. Give the full ` +
      '`0000xxxx-0000-1000-8000-00805f9b34fb` form, or a 16-bit alias like `ffe0`.',
  )
}

/**
 * Nordic's UART Service, and the assumption this feature rests on.
 *
 * `verified: false` is the load-bearing part of this record. Everything that
 * would tell a user Bluetooth works reads it first.
 */
export const NORDIC_UART: BluetoothProfile = {
  id: 'nordic-uart',
  label: 'Nordic UART Service',
  service: '6e400001-b5a3-f393-e0a9-e50e24dcca9e',
  write: '6e400002-b5a3-f393-e0a9-e50e24dcca9e',
  notify: '6e400003-b5a3-f393-e0a9-e50e24dcca9e',
  verified: false,
}

/**
 * The profiles worth trying, in order.
 *
 * A list rather than a single constant because the second most common serial
 * bridge in cheap Chinese BLE modules is the HM-10 style `FFE0`, which uses one
 * characteristic for both directions. If Nordic turns out to be wrong for these
 * radios, that is the next thing to try, and having the shape here means trying
 * it is a data change.
 */
export const KNOWN_PROFILES: readonly BluetoothProfile[] = [
  NORDIC_UART,
  {
    id: 'hm10',
    label: 'HM-10 style transparent serial',
    service: normaliseUuid('ffe0'),
    // One characteristic carries both directions on these modules, which the
    // port supports because it never assumes the two are distinct objects.
    write: normaliseUuid('ffe1'),
    notify: normaliseUuid('ffe1'),
    verified: false,
  },
]

/**
 * Build a profile from `service,write,notify`.
 *
 * The point of this is the person with a radio in front of them and a UUID list
 * on a phone screen. They should be able to try a set immediately rather than
 * build the site, and if it works, the numbers they pasted are the numbers that
 * go into `NORDIC_UART` above.
 */
export function parseBluetoothProfile(spec: string): BluetoothProfile {
  const parts = spec
    .split(',')
    .map((p) => p.trim())
    .filter((p) => p.length > 0)

  if (parts.length !== 2 && parts.length !== 3) {
    throw new BluetoothUuidError(
      'A Bluetooth profile is `service,write,notify` - or `service,characteristic` when one ' +
        `characteristic carries both directions. Got ${JSON.stringify(spec)}.`,
    )
  }

  const service = normaliseUuid(parts[0]!)
  const write = normaliseUuid(parts[1]!)
  // A two-part spec is the HM-10 shape: one characteristic, both directions.
  const notify = normaliseUuid(parts[2] ?? parts[1]!)

  return { id: 'custom', label: 'Custom profile', service, write, notify, verified: false }
}

/**
 * The profile in force.
 *
 * Module-level and swappable, in the manner of `setSleepImplementation` in
 * `transport.ts`: it is a single global fact about the hardware, and threading
 * it through every caller would only spread the guess around.
 */
let active: BluetoothProfile = NORDIC_UART

export function bluetoothProfile(): BluetoothProfile {
  return active
}

export function setBluetoothProfile(profile: BluetoothProfile): void {
  active = profile
}

/** Undo an override; used by tests and by `?ble=off`. */
export function resetBluetoothProfile(): void {
  active = NORDIC_UART
}

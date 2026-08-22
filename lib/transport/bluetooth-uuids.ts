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
  /**
   * Names this radio has been seen advertising, as chooser filter prefixes.
   *
   * A service filter is not always enough: `requestDevice` matches a service
   * only when the device puts it in its **advertisement**, and FFE0 was found
   * by a GATT enumeration, which happens after connecting and says nothing
   * about what is broadcast. Filters are OR-ed, so naming both asks the chooser
   * for "advertises the service, or is called this".
   *
   * `namePrefix` is an exact, case-sensitive prefix with no case-insensitive
   * form, so the casings are enumerated rather than assumed, and each stops
   * before the separator: a name rendered `walkie-talkie` on screen may hold a
   * hyphen that is not U+002D, and a filter carrying the wrong one matches
   * nothing while reading correctly here.
   */
  readonly namePrefixes: readonly string[]
  /**
   * What the chooser labels this radio, for when the filters come off.
   *
   * `?ble=scan` and the "show every device" button both drop them, and then the
   * list is every Bluetooth device in range. This is what tells somebody which
   * row is theirs.
   */
  readonly advertisedName?: string
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
  // No radio has ever been seen advertising this, let alone under a name.
  namePrefixes: [],
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
/**
 * What a real Baofeng UV-5R Mini answers on, established by asking it.
 *
 * A GATT enumeration of a radio in wireless CPS mode lists three vendor
 * services - AE30, AE3A and an HM-10 style FFE0 - and no Nordic UART, so the
 * convention this file originally assumed was simply wrong for this radio.
 *
 * Which of them carried the protocol was then settled the only way it can be:
 * by sending the radio its own identify magic on each writable characteristic
 * and watching for the acknowledgement. FFE0 answered `06`. It is an HM-10
 * style transparent serial link, so one characteristic carries both directions,
 * which the port supports because it never assumes the two are distinct.
 *
 * AE30 is the trap, and the reason guessing would have been expensive: writing
 * to `ae01` returns the sixteen bytes just written, unchanged. It is a loopback,
 * not a protocol channel. A driver pointed at it would see its own frames come
 * back and report the echo this project has already spent hours misdiagnosing
 * on two separate cables.
 */
export const UV5RM_BLE: BluetoothProfile = {
  id: 'uv5rm-ffe0',
  label: 'Baofeng wireless CPS (HM-10 transparent serial)',
  service: normaliseUuid('ffe0'),
  // One characteristic both ways. Writing and notifying on the same handle is
  // normal for these modules and is what the radio actually answered on.
  write: normaliseUuid('ffe1'),
  notify: normaliseUuid('ffe1'),
  /*
   * `walkie-talkie` is what Chrome labels the radio in an unfiltered chooser,
   * and these are prefixes of it rather than the whole string.
   *
   * Whether a filter can reach this radio at all is genuinely unknown. Three
   * attempts said it could not - one service filter and two name filters, each
   * producing an empty chooser - and all three were invalid, because
   * `resetBluetoothProfile()` was swapping this profile for Nordic UART on
   * every load that carried no `?ble=` override. The filters that came back
   * empty were Nordic's. None of the numbers in this record had been sent.
   */
  namePrefixes: ['walkie', 'Walkie', 'WALKIE'],
  advertisedName: 'walkie-talkie',
  verified: true,
}

/**
 * The echo characteristic, kept so it can be recognised rather than rediscovered.
 *
 * Never a default and never tried automatically. It is here so that anyone
 * enumerating this radio and finding AE30 first has something to read.
 */
export const UV5RM_AE30_ECHO: BluetoothProfile = {
  id: 'uv5rm-ae30-echo',
  label: 'Baofeng AE30 — echoes what is written to it',
  service: normaliseUuid('ae30'),
  write: normaliseUuid('ae01'),
  notify: normaliseUuid('ae02'),
  namePrefixes: [],
  verified: false,
}

export const KNOWN_PROFILES: readonly BluetoothProfile[] = [
  UV5RM_BLE,
  UV5RM_AE30_ECHO,
  // Kept because it is the convention most of these modules follow, even
  // though the one radio anybody has tested does not use it.
  NORDIC_UART,
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

  /*
   * No name filter on a hand-entered profile. Somebody pasting UUIDs is
   * chasing a radio this build does not know, and a name prefix from a
   * different one would filter theirs straight back out.
   */
  return { id: 'custom', label: 'Custom profile', service, write, notify, namePrefixes: [], verified: false }
}

/**
 * The profile in force.
 *
 * Module-level and swappable, in the manner of `setSleepImplementation` in
 * `transport.ts`: it is a single global fact about the hardware, and threading
 * it through every caller would only spread the guess around.
 */
/*
 * The default is the profile a radio has actually answered on.
 *
 * Filtering the chooser on a service the radio does not advertise lists nothing
 * at all, which is indistinguishable from the radio being switched off.
 */
/**
 * One name for the default, because the reset below drifted away from it.
 *
 * `resetBluetoothProfile` used to assign `NORDIC_UART` literally. That was
 * right when it was written and Nordic was the default; two commits later the
 * initialiser was a captured profile and the reset was never touched. And
 * `resolveBluetoothProfile()` calls the reset on **every load carrying no
 * `?ble=` override** - which is every ordinary one - so the shipped app spent
 * every session filtering its chooser on a service nobody has seen advertised,
 * listing nothing, with a radio a foot away. That is the exact failure the
 * header of this file warns about, caused by the file itself.
 *
 * Naming the default once is what stops it happening again, and a test asserts
 * the reset lands back on it.
 */
export const DEFAULT_PROFILE: BluetoothProfile = UV5RM_BLE

let active: BluetoothProfile = DEFAULT_PROFILE

export function bluetoothProfile(): BluetoothProfile {
  return active
}

export function setBluetoothProfile(profile: BluetoothProfile): void {
  active = profile
}

/** Undo an override; used by tests and by `?ble=off`. */
export function resetBluetoothProfile(): void {
  active = DEFAULT_PROFILE
}

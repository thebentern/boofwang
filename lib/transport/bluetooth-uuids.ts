// SPDX-License-Identifier: GPL-3.0-or-later
import type { TransportKind } from './transport.js'

/**
 * ===========================================================================
 * EVERY UUID HERE IS A GUESS UNTIL ITS `verified` FLAG SAYS OTHERWISE.
 * ===========================================================================
 *
 * One profile has been proven - `UV5RM_BLE`, by a real radio answering its
 * own identify magic - and that is the exception that shows the rule: the
 * rest of this file is assumption, held to the discipline below until a
 * device answers.
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
  /**
   * What the radio behind this profile believes it is connected by.
   *
   * Absent means `'bluetooth'`: the BLE module is inside the radio, which is
   * every profile until the dongles. A BLE-to-UART dongle profile says
   * `'serial'`, because the peripheral is the dongle and the radio behind it
   * is on its own wired UART - the fact that decides the UV-5R Mini's upload
   * block size, among whatever else a driver ever varies by link.
   */
  readonly radioLink?: TransportKind
  /** True only once a device has answered a handshake over this profile. */
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
   * `walkie-talkie` is what Chrome labels these radios in a chooser, and these
   * are prefixes of it rather than the whole string.
   *
   * Two different UV-5R Minis both advertised it, which is what makes it worth
   * filtering on: it is the model's name, not one unit's, so the filter holds
   * for somebody else's radio too.
   *
   * These filters work. With the profile substitution fixed, a chooser carrying
   * them listed the radio and nothing else - the first time any request had
   * actually been built from this record rather than from Nordic UART.
   *
   * Which half matched is not known and cannot be told from a chooser: the
   * browser ORs the filters and does not say which one hit. So the service
   * stays alongside the names rather than being assumed redundant.
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

/*
 * The TIDRADIO BL-1 family: BL-1, TDBL-1, BL-2, and the TD-PTT fob with its
 * Kenwood cable attached. Not radios - BLE-to-UART bridges that clip onto a
 * radio's two-pin programming port. The BLE peripheral is the dongle; the
 * radio behind it is an ordinary cabled radio that does not know anything
 * changed, which is what `radioLink: 'serial'` records.
 *
 * A real one has now been enumerated - a TD-PTT fob, name
 * `TIDRADIO PTTf816cb-A`, on 2026-08-31 - and it is neither of the shapes
 * this file first guessed. It advertises vendor service FF00 and exposes two
 * write/notify pairs inside it (FF02/FF01 and FF22/FF21) plus an AE00 service
 * echoing the UV-5R Mini's AE-family layout. So the primary candidate is what
 * that unit showed; the HM-10 FFE0 shape is kept behind it because cheap
 * dongles in this family vary and a different unit may carry it.
 *
 * Still `verified: false`, and the reason is now measured rather than
 * cautious. Two radios were held behind it and sent their own identify magic:
 * a UV-K5 (38,400 baud) and a UV-82 (9,600 - the family these are sold for).
 * Neither answered. What FF22 does instead is the finding:
 *
 *   4 bytes in -> 4 bytes back    16 in -> 16 back    1 in -> 1 back
 *
 * Exactly one byte out per byte written, every time, on FF21. No radio
 * protocol in this codebase does that: a UV-82 answers a seven-byte magic
 * with a single 0x06, and a UV-K5 answers a sixteen-byte hello with a framed
 * reply of about twenty-six. So FF22/FF21 is a per-byte status channel, not
 * a data path - recorded below as `TIDRADIO_FF22_PER_BYTE` for the same
 * reason `UV5RM_AE30_ECHO` is recorded, and pointed at by nothing.
 *
 * The bytes it returns do vary with the radio attached (all `00` behind the
 * UV-82, varied and deterministic behind the UV-K5), so the dongle is
 * sampling something. What it is not doing is carrying a radio's reply.
 * FF02/FF01 - the other pair, and the one shaped like a transparent serial
 * link - stayed silent to everything, and FF02 reads back empty.
 *
 * A second device, a `BF_Writer_CD4` purpose-built programming writer, was
 * enumerated the next day and agrees on the shape that matters: an FF00
 * service carrying FF02 (write) and FF01 (notify), which is why this profile
 * aims there. It also carries an AE01/AE02 pair that echoes verbatim - the
 * AE30 loopback above, on different hardware - and an AE10 register that
 * takes a one-byte write, reads back what it is given, factory value 5, and
 * takes the whole dongle off the air when written 0. Sweeping that register
 * is not a way to find a baud rate; it is a way to need a power cycle.
 *
 * On the writer FF02 does draw a reply on FF01, but not a radio's: a
 * variable count of single bytes, `f8` `f0` `fc` `e0` `c0`, runs of ones
 * then zeros, which is a UART sampling a line at the wrong rate or an idle
 * one. Neither device has carried a radio's words. Until an HCI snoop of the
 * vendor app doing a real read says which characteristic carries a payload
 * and what configures it first, this profile aims at the plausible pair and
 * promises nothing.
 *
 * The name prefixes are now half-confirmed: `TID` matched the real device.
 * The pre-hyphen short forms stay because a hyphen rendered on screen may not
 * be U+002D (the `walkie-talkie` lesson above), and over-matching lists extra
 * chooser rows where under-matching lists nothing.
 */
const BL1_NAME_PREFIXES: readonly string[] = ['BL-1', 'BL', 'TDBL', 'TD-PTT', 'TD', 'TID', 'TIDRADIO']

export const TIDRADIO_BL1_FF00: BluetoothProfile = {
  id: 'tidradio-bl1-ff00',
  label: 'TIDRADIO dongle (FF00 vendor serial)',
  service: normaliseUuid('ff00'),
  /*
   * FF02/FF01, not the pair that answers.
   *
   * FF22 replies to everything one byte per byte, which is a status channel
   * and would feed a driver a stream shaped like data - the AE30 mistake in
   * a new costume. FF02/FF01 is the pair shaped like a transparent serial
   * link, and it has never returned a byte. Silence is the honest failure
   * here: a driver aimed at it times out saying the radio did not answer,
   * which is true, instead of misreporting a protocol error against bytes
   * the radio never sent.
   */
  write: normaliseUuid('ff02'),
  notify: normaliseUuid('ff01'),
  namePrefixes: BL1_NAME_PREFIXES,
  radioLink: 'serial',
  verified: false,
}

/**
 * The characteristic that answers a byte for every byte, kept so it is
 * recognised rather than rediscovered.
 *
 * Never a default and never tried automatically, exactly like the UV-5R
 * Mini's AE30 echo above. It is here so that anyone probing a TIDRADIO
 * dongle, finding the only pair that talks back, and concluding they have
 * found the data path has something to read first. Four bytes in, four
 * bytes out; sixteen in, sixteen out. That is not a radio.
 */
export const TIDRADIO_FF22_PER_BYTE: BluetoothProfile = {
  id: 'tidradio-ff22-per-byte',
  label: 'TIDRADIO FF22 — answers one byte per byte, not a data path',
  service: normaliseUuid('ff00'),
  write: normaliseUuid('ff22'),
  notify: normaliseUuid('ff21'),
  namePrefixes: [],
  radioLink: 'serial',
  verified: false,
}

export const TIDRADIO_BL1_FFE0: BluetoothProfile = {
  id: 'tidradio-bl1-ffe0',
  label: 'TIDRADIO dongle (HM-10 transparent serial)',
  service: normaliseUuid('ffe0'),
  write: normaliseUuid('ffe1'),
  notify: normaliseUuid('ffe1'),
  namePrefixes: BL1_NAME_PREFIXES,
  radioLink: 'serial',
  verified: false,
}

/**
 * The candidates a dongle connect tries, in order.
 *
 * The enumerated FF00 shape first, because a real unit showed it; the FFE0
 * HM-10 shape behind it for a unit that carries that instead. A device
 * carries one, and the loser costs one failed `getPrimaryService` on the
 * same connection. Note the FFE0 variant is service-identical to
 * `UV5RM_BLE`: an FFE0 dongle and a UV-5R Mini's own module cannot be told
 * apart by UUID alone, only by which candidate list the session was opened
 * with. docs/protocols/ble-dongle.md records why that ambiguity is currently
 * harmless.
 */
export const BL1_DONGLE_PROFILES: readonly BluetoothProfile[] = [TIDRADIO_BL1_FF00, TIDRADIO_BL1_FFE0]

export const KNOWN_PROFILES: readonly BluetoothProfile[] = [
  UV5RM_BLE,
  UV5RM_AE30_ECHO,
  // Kept because it is the convention most of these modules follow, even
  // though the one radio anybody has tested does not use it.
  NORDIC_UART,
  TIDRADIO_BL1_FF00,
  TIDRADIO_BL1_FFE0,
  TIDRADIO_FF22_PER_BYTE,
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
  /*
   * A `uart:` prefix marks the device as a BLE-to-UART dongle: the radio
   * behind it is on its own wired UART, so the profile carries
   * `radioLink: 'serial'`. The person this exists for is chasing a real BL-1
   * with a UV-5R Mini clipped to it - without the prefix the driver would
   * pick the 0x80 wireless upload blocks the radio, on a cable as far as it
   * knows, never agreed to.
   */
  const uart = spec.trim().toLowerCase().startsWith('uart:')
  const body = uart ? spec.trim().slice('uart:'.length) : spec

  const parts = body
    .split(',')
    .map((p) => p.trim())
    .filter((p) => p.length > 0)

  if (parts.length !== 2 && parts.length !== 3) {
    throw new BluetoothUuidError(
      'A Bluetooth profile is `service,write,notify` - or `service,characteristic` when one ' +
        'characteristic carries both directions, with a `uart:` prefix when the device is a ' +
        `BLE-to-UART dongle. Got ${JSON.stringify(spec)}.`,
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
  return {
    id: 'custom',
    label: 'Custom profile',
    service,
    write,
    notify,
    namePrefixes: [],
    ...(uart ? { radioLink: 'serial' as const } : {}),
    verified: false,
  }
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

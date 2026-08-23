// SPDX-License-Identifier: GPL-3.0-or-later
import type { Transport, SerialOpenOptions } from '../transport/transport.js'
import type { Codeplug, RadioId } from '../model/index.js'
import type { RadioImage } from './image.js'
import type { RadioSchema } from './schema.js'

export interface Progress {
  readonly phase: 'handshake' | 'scan' | 'read' | 'encode' | 'write' | 'verify'
  readonly done: number
  readonly total: number
  readonly label?: string
}

/** Default per-operation serial timeout. */
export const DEFAULT_DRIVER_TIMEOUT_MS = 4000

export interface Logger {
  debug(msg: string): void
  info(msg: string): void
  warn(msg: string): void
}

export const NULL_LOGGER: Logger = { debug: () => {}, info: () => {}, warn: () => {} }

/** Proof that a full backup of *this* radio exists. */
export interface BackupRef {
  readonly id: string
  /** Hash of the identify result, so a backup of a different radio does not count. */
  readonly identHash: string
  readonly createdAt: string
  /**
   * Fingerprint of the physical unit this backup came from, when the driver can
   * produce one.
   *
   * `identHash` covers model, firmware and build date - all properties of the
   * firmware. Two radios of the same model on the same firmware hash
   * identically, so on its own it cannot tell whether the backup on file came
   * from the radio on the cable. Without this, a user with two identical radios
   * could write one while the only backup in existence belonged to the other,
   * and a restore after a bad write would push the wrong radio's codeplug.
   */
  readonly unitHash?: string | null
}

export interface DriverCtx {
  /**
   * Per-operation serial timeout in milliseconds.
   *
   * The default suits a healthy direct cable. It is adjustable because the
   * things between the app and the radio vary a lot: a BLE-to-serial bridge, a
   * congested USB hub, or simply a busy machine can all stretch a reply well
   * past what a direct connection needs, and a spurious timeout mid-transfer is
   * worse than a slow one - it desyncs the link and aborts the read.
   */
  readTimeoutMs?: number | undefined
  /**
   * Human-readable USB adapter description ("Prolific PL2303 (067b:2303)").
   *
   * Quoted back when the adapter misbehaves. Naming the chip turns "something
   * is wrong" into something the user can act on, because a specific family of
   * counterfeit chips causes a disproportionate share of these failures.
   */
  adapter?: string | undefined
  /**
   * What the radio held before this edit.
   *
   * Supplied so a write can send only the blocks that actually differ. Fewer
   * bytes in flight is fewer bytes at risk if the cable is pulled mid-write,
   * and it makes the operation visibly proportional to the change rather than
   * rewriting the whole radio to move one channel.
   */
  baseImage?: RadioImage | undefined
  /**
   * The identification from the current session, when one has already happened.
   *
   * Supplied so a driver does not repeat a handshake that cannot be repeated.
   * The DM-32UV's is stateful: a second `PSEARCH` on an already-handshaken port
   * gets no reply at all, so re-identifying inside `writeImage` broke every
   * write while looking exactly like a radio that was not ready.
   */
  ident?: IdentifyResult | undefined
  progress?(p: Progress): void
  signal?: AbortSignal
  log?: Logger
  /** Reads happen for real; writes are recorded and dropped. */
  dryRun?: boolean
  backup?: BackupRef
  /** Feature keys the user has explicitly unlocked. */
  unlocked?: ReadonlySet<string>
}

export interface IdentifyResult {
  readonly radioId: RadioId
  /** UV-K5 firmware string, DM-32UV model string. */
  readonly variant: string
  readonly layout: string
  readonly raw: Uint8Array
  readonly caps: { readonly read: boolean; readonly write: boolean; readonly reason?: string }
  /** Stable hash of this identification, for matching a backup to a radio. */
  readonly identHash: string
  /** Driver-specific facts discovered during identification. */
  readonly meta?: Readonly<Record<string, unknown>>
}

export interface WriteOperation {
  readonly addr: number
  readonly length: number
  readonly label: string
  readonly skipped?: 'unchanged'
}

export interface WriteReport {
  readonly blocksWritten: number
  readonly bytesWritten: number
  readonly verified: boolean
  readonly dryRun: boolean
  readonly operations: readonly WriteOperation[]
}

export type DiagnosticSeverity = 'info' | 'warning' | 'error'

export interface Diagnostic {
  readonly severity: DiagnosticSeverity
  readonly ruleId: string
  readonly message: string
  /** Which channel slot this concerns, when it concerns one. */
  readonly channel?: number
  readonly field?: string
}

export interface RadioDriver {
  readonly id: RadioId
  readonly schema: RadioSchema

  /**
   * The RF profile that actually applies to this document.
   *
   * `schema.rf` describes the radio as the schema declares it, which is not the
   * whole truth when one radio has more than one firmware: an egzumer UV-K5
   * receives on frequencies stock does not, offers single sideband where stock
   * has only FM and AM, and has twenty-four tuning steps against stock's six.
   * The driver already had to know this to validate a channel; without a way to
   * ask, the editor did not, so a channel this build decodes perfectly well
   * could not be edited or even renamed.
   *
   * Optional. A radio with one layout has nothing to vary and the caller falls
   * back to `schema.rf`.
   */
  rfFor?(doc: Codeplug): RadioSchema['rf']
  readonly serial: SerialOpenOptions
  /**
   * What to do when a transfer is aborted partway.
   *
   * The hazard is leaving the radio in programming mode. The UV-K5 has a reset
   * command that can be fired on the way out; the other two have no exit
   * command at all, so the UI has to tell the user to power-cycle.
   */
  readonly abortPolicy: 'reset-command' | 'power-cycle'

  /**
   * The unit this radio is written in, in bytes.
   *
   * Used to tell the user how much will be sent before they agree to it. The
   * unit differs by an order of magnitude between radios - 128 bytes on the
   * UV-K5, a 4 KiB page on the DM-32UV - and a count of "blocks" means nothing
   * without it. Changing one byte of a DM-32UV key slot really does send 4096
   * bytes, and the confirmation should say so.
   */
  readonly writeBlockBytes: number

  /**
   * A fingerprint of the physical unit an image came from, or null.
   *
   * Derived from factory-set per-unit data - calibration, on radios that expose
   * it - rather than anything about the firmware. Drivers that have nothing
   * unit-specific to hash return null, and callers must treat that as "cannot
   * tell", never as "matches".
   */
  unitFingerprint(image: RadioImage): Promise<string | null>

  /** Confidence that a USB device is this radio's cable, from its VID/PID. */
  match(info: { usbVendorId?: number; usbProductId?: number }): 'likely' | 'possible' | 'no'

  identify(t: Transport, ctx?: DriverCtx): Promise<IdentifyResult>
  readImage(t: Transport, ident: IdentifyResult, ctx?: DriverCtx): Promise<RadioImage>
  writeImage(t: Transport, image: RadioImage, ctx?: DriverCtx): Promise<WriteReport>

  decode(image: RadioImage): Codeplug

  /**
   * Serialise `doc` onto a copy of `base`.
   *
   * There is deliberately no `encode(doc)`. Taking the original image is what
   * guarantees that bytes this codebase has never decoded survive a
   * read/edit/write cycle: they are carried through from the base rather than
   * fabricated. It matters most on the DM-32UV, where roughly 31 of 71 memory
   * pages remain undocumented, but it is the same rule everywhere.
   */
  encode(doc: Codeplug, base: RadioImage): RadioImage

  validate(doc: Codeplug): Diagnostic[]

  /**
   * The byte ranges, relative to a region's start, that this driver claims to
   * understand and is therefore willing to overwrite.
   *
   * Used three ways: the diff annotator treats a change outside these ranges as
   * a blocking error rather than a warning (it means the encoder has a bug),
   * the DM-32UV writer merges only these ranges onto the live page, and the
   * coverage report is derived from them.
   */
  /**
   * The bytes of a region this driver claims to understand.
   *
   * `image` is optional and most drivers ignore it. It exists for the DM-32UV,
   * whose DMR address book is a raw region with no logical id: which page of it
   * a region is - and so whether its first four bytes are a record count or the
   * start of a name - can only be told by where it sits relative to the others.
   */
  ownedRanges(regionStart: number, image?: RadioImage): readonly (readonly [number, number])[]

  /**
   * Whether this image has somewhere to put channel `slot`.
   *
   * Optional, and about the unit rather than the model. A radio whose channel
   * bank is one flat array has nothing to answer and omits it; the DM-32UV
   * allocates its bank a 4 KiB block at a time as the user programs into it, so
   * a unit with blocks 0x12-0x14 and 0x18 has memory for channels 1-254 and
   * 510-594 and none at all for the 255 numbers in between. `encode` already
   * refuses a channel it has no page for, by name. This is the same fact asked
   * in advance, so an operation that chooses slot numbers - renumbering the
   * bank - can choose ones that exist rather than build a codeplug that is only
   * refused at the point of writing it.
   */
  storesSlot?(image: RadioImage, slot: number): boolean
}

export class DriverError extends Error {
  override readonly name: string = 'DriverError'
}

export class UnsupportedFirmwareError extends DriverError {
  override readonly name = 'UnsupportedFirmwareError'
  constructor(readonly firmware: string) {
    super(
      `Unrecognised firmware ${JSON.stringify(firmware)}. ` +
        'The radio can be read and backed up, but writing is disabled because the memory layout is unknown.',
    )
  }
}

export class RadioInProgrammingModeError extends DriverError {
  override readonly name = 'RadioInProgrammingModeError'
  constructor() {
    super('The radio is in programming (bootloader) mode. Power it off and on again in normal mode.')
  }
}

/**
 * The line is returning our own transmitted bytes.
 *
 * Worth its own error because the symptom is so misleading. An echoed command
 * is a structurally perfect frame - correct header, correct footer, valid
 * checksum - so every layer below this happily accepts it, and the radio
 * appears to be answering with nonsense rather than not answering at all. On
 * the UV-K5 the echoed hello even decodes to an empty firmware string, which
 * once surfaced as "unrecognised firmware" and sent people looking for a
 * firmware problem that does not exist.
 *
 * Observed cause, from a real session: a counterfeit Prolific PL2303 adapter
 * (bcdDevice 0x0300) that macOS could not configure at all - `tcsetattr`
 * rejected even a no-op change - and which returned everything written to it.
 * Testing the same cable at the wire level showed no short between transmit and
 * receive, so the echo came from the adapter rather than the cabling. Cheap
 * counterfeit USB-serial chips are common in this hobby and are the first thing
 * to suspect; the CH340-based cables are what the UV-K5 community settled on.
 */
export class LoopbackDetectedError extends DriverError {
  override readonly name = 'LoopbackDetectedError'
  constructor(what: string, adapter?: string) {
    super(
      `The USB-serial adapter is returning boofwang's own data instead of the radio replying (${what}). ` +
        'The radio is not responding.' +
        (adapter ? ` The adapter reports itself as ${adapter}.` : '') +
        ' Check the radio is switched on and the plug is fully seated; if it still fails, suspect the adapter. ' +
        'Counterfeit USB-serial chips are common and often behave exactly like this - a CH340-based cable is the ' +
        'usual remedy.',
    )
  }
}

export class NoRadioResponseError extends DriverError {
  override readonly name = 'NoRadioResponseError'
  constructor(what: string) {
    super(
      `The radio did not respond (${what}). Check that it is switched on, that the programming cable is fully ` +
        'seated, and that no other program is using the port.',
    )
  }
}

export class ImageRadioMismatchError extends DriverError {
  override readonly name = 'ImageRadioMismatchError'
  constructor(connected: string, image: string) {
    super(
      `This codeplug was read from ${JSON.stringify(image)} but the connected radio reports ` +
        `${JSON.stringify(connected)}. Writing it could corrupt the radio.`,
    )
  }
}

export class BackupRequiredError extends DriverError {
  override readonly name = 'BackupRequiredError'
  constructor(radioId: string) {
    super(`Refusing to write to the ${radioId}: no verified backup of this radio exists for this session.`)
  }
}

/**
 * A write the driver will not perform, for a reason it states.
 *
 * Takes the whole sentence. It used to take a subject and append "is not
 * supported. This area of memory is not understood well enough to modify
 * safely." to everything - which was true of the one call that existed when it
 * was written and false of most of the eight that exist now: a refusal over
 * Bluetooth, a firmware this build will not write, a radio whose write path is
 * not verified. Every one of those came out as "Writing <reason>. is not
 * supported. This area of memory..." - ungrammatical, and ending in a sentence
 * about memory that had nothing to do with the reason.
 */
export class WriteBlockedError extends DriverError {
  override readonly name = 'WriteBlockedError'
}

/**
 * A block read back from the radio does not match what was sent.
 *
 * Always fatal. Continuing past this would mean writing further blocks on the
 * assumption that earlier ones landed, and the honest response is to stop with
 * the radio still in programming mode so a restore can follow immediately.
 */
export class WriteVerifyError extends DriverError {
  override readonly name = 'WriteVerifyError'
  constructor(
    readonly addr: number,
    expected: string,
    received: string,
    /** How many blocks had already been verified before this one. */
    readonly blocksCommitted: number,
    /**
     * Whether the whole image had already been sent before verification began.
     *
     * Two of the drivers write every block and then verify in a second pass, so
     * telling their users "nothing after it was sent" would describe a failure
     * they did not have - and on a radio that erases a flash page before
     * programming, it would understate what is actually on the radio.
     */
    readonly verifiedAfterSending = false,
  ) {
    super(
      `The radio did not store what was sent at 0x${addr.toString(16).padStart(4, '0')}. ` +
        (verifiedAfterSending
          ? `The whole image had already been sent when this was found, and ${blocksCommitted} block(s) ` +
            'verified before it.'
          : `Writing stopped there: ${blocksCommitted} block(s) were written and verified before it, and ` +
            'nothing after it was sent.') +
        ' The radio now holds a partly-updated codeplug, so restore your backup before using it.\n' +
        `  sent:      ${expected}\n  read back: ${received}`,
    )
  }
}

/**
 * The radio's contents are not what the caller believed before the write.
 *
 * Raised when a fresh read disagrees with the image the edit was based on -
 * because the radio was edited from its keypad since it was read, because a
 * saved file from another session was opened, or because this is a different
 * radio. Deciding which blocks to leave alone from a stale base is how a radio
 * ends up holding a mixture of two codeplugs while the write reports success.
 */
export class RadioChangedError extends DriverError {
  override readonly name = 'RadioChangedError'
  constructor(readonly firstDifference: number) {
    super(
      'The radio no longer holds what it did when this codeplug was read ' +
        `(the first difference is at 0x${firstDifference.toString(16).padStart(4, '0')}). ` +
        'It may have been edited from its keypad, or this may be a different radio. ' +
        'Read it again before writing, so nothing is lost.',
    )
  }
}

export class TxInhibitUnsupportedError extends DriverError {
  override readonly name = 'TxInhibitUnsupportedError'
  constructor(radioId: string, channel: number) {
    super(
      `Channel ${channel} is marked receive-only, but the ${radioId} cannot enforce that per channel. ` +
        'Programming it would produce a channel that can transmit.',
    )
  }
}

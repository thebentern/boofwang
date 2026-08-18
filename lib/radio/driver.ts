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
  readonly serial: SerialOpenOptions
  /**
   * What to do when a transfer is aborted partway.
   *
   * The hazard is leaving the radio in programming mode. The UV-K5 has a reset
   * command that can be fired on the way out; the other two have no exit
   * command at all, so the UI has to tell the user to power-cycle.
   */
  readonly abortPolicy: 'reset-command' | 'power-cycle'

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
  ownedRanges(regionStart: number): readonly (readonly [number, number])[]
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
 * previously surfaced as "unrecognised firmware" and sent people looking for a
 * firmware problem that does not exist.
 *
 * The usual causes are physical: the two-pin plug not pushed fully home, the
 * radio switched off, or a counterfeit USB-serial chip.
 */
export class LoopbackDetectedError extends DriverError {
  override readonly name = 'LoopbackDetectedError'
  constructor(what: string) {
    super(
      `The programming cable is echoing boofwang's own data back instead of the radio replying (${what}). ` +
        'The radio is not responding. Check that it is switched on, that the plug is pushed all the way in — ' +
        'the two-pin connector often needs a firm push — and that the cable is seated in the right sockets.',
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

export class WriteBlockedError extends DriverError {
  override readonly name = 'WriteBlockedError'
  constructor(what: string) {
    super(`Writing ${what} is not supported. This area of memory is not understood well enough to modify safely.`)
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

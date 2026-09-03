// SPDX-License-Identifier: GPL-3.0-or-later
import type { Diagnostic, IdentifyResult } from './driver.js'
import type { RadioSchema } from './schema.js'
import type { TransportKind } from '../transport/transport.js'

/**
 * Everything that must be true before bytes go to a radio, decided in one pure
 * function so the UI and the driver cannot disagree about it.
 *
 * The driver enforces the important ones again on its own, which is deliberate
 * duplication: this exists to *explain* the situation to a person, and
 * `writeImage` exists to be unbypassable. If they ever disagree, the driver
 * wins and the user sees an error instead of a nicely worded dialog.
 */

export type BlockerCode =
  | 'no-backup'
  | 'backup-other-radio'
  | 'not-connected'
  | 'nothing-to-write'
  | 'edits-not-writable'
  | 'write-unsupported'
  | 'firmware-unknown'
  | 'image-radio-mismatch'
  | 'encode-failed'
  | 'unowned-bytes-changed'
  | 'validation-errors'
  | 'transport-write-unverified'

export interface Blocker {
  code: BlockerCode
  message: string
  /** What the user can do about it, when there is something. */
  remedy?: string
}

export interface Warning {
  code: string
  message: string
}

export interface GateInput {
  schema: RadioSchema
  /**
   * The connected radio, or null when nothing is connected yet.
   *
   * Null is an ordinary state, not an error: reading disconnects when it
   * finishes, and the write flow reconnects when it runs. So the checks that
   * need a radio are simply skipped here - `writeImage` performs all of them
   * against the radio actually on the cable, and it is the enforcement that
   * matters. This function exists to explain the situation to a person.
   */
  ident: IdentifyResult | null
  /**
   * Variant recorded on the image being written, compared against the radio's.
   *
   * Reported as a warning, never a blocker. Whether two firmware strings share
   * a memory layout is the driver's question - the UV-K5 has whole families of
   * builds that are interchangeable, and one that is not - so `writeImage`
   * makes the binding decision. Repeating a cruder version of that test here
   * would refuse writes that are perfectly safe.
   */
  imageVariant: string | null
  imageRadioId: string | null
  backup: { identHash: string } | null
  diagnostics: readonly Diagnostic[]
  encodeError: string | null
  changedBytes: number
  unownedRanges: readonly (readonly [number, number])[]
  /**
   * Whether the document has been edited since it was read or opened.
   *
   * Distinguishes "you have changed nothing" from "you have changed something
   * this radio cannot write". Both encode to zero changed bytes, and telling
   * someone who just renamed a channel that nothing has changed is worse than
   * saying nothing at all.
   */
  documentDirty: boolean
  /**
   * What the session is connected by, or will reconnect by.
   *
   * The device store keeps the last carrier through a disconnect precisely so
   * the write can reuse it; this is that value. Null when the caller does not
   * know, in which case no transport check is made - the driver still refuses.
   */
  transport?: TransportKind | null
}

export interface GateResult {
  allowed: boolean
  blockers: Blocker[]
  warnings: Warning[]
}

export function evaluateWriteGate(input: GateInput): GateResult {
  const blockers: Blocker[] = []
  const warnings: Warning[] = []

  if (!input.schema.capabilities.write) {
    blockers.push({
      code: 'write-unsupported',
      message: `Writing to the ${input.schema.model} is not enabled in this build.`,
    })
  }

  /*
   * The carrier. `writeTransports` is the schema's statement of which carriers
   * this radio's write path has survived. It exists because the two halves
   * disagreed once: the UV-5R Mini's driver refused Bluetooth for itself while
   * the gate said "allowed", so the user typed the token and the write threw.
   * Reading the one fact both halves read is what stops that recurring.
   *
   * The Mini has since taken a wireless write and no longer restricts itself.
   * What still lands here is the four radios reachable only behind a clip-on
   * BLE-to-UART dongle: their `transports` is ['serial'], the session's carrier
   * is 'bluetooth', and no radio behind a dongle has survived a write.
   */
  const writeOver = input.schema.capabilities.writeTransports ?? input.schema.capabilities.transports
  if (input.transport && !writeOver.includes(input.transport)) {
    const other = writeOver.length === 1 ? writeOver[0] : writeOver.join(' or ')
    blockers.push({
      code: 'transport-write-unverified',
      message:
        `Writing to the ${input.schema.model} over ${input.transport === 'bluetooth' ? 'Bluetooth' : input.transport} ` +
        'has not been verified on a radio, so this build will not do it.',
      remedy: `Connect over ${other === 'serial' ? 'the cable' : other} to write.`,
    })
  }

  if (input.ident && !input.ident.caps.write) {
    blockers.push({
      code: 'firmware-unknown',
      message: input.ident.caps.reason ?? `Firmware ${input.ident.variant} is not one this build can write.`,
      remedy: 'The radio can still be read and backed up.',
    })
  }

  if (input.imageRadioId !== null && input.imageRadioId !== input.schema.id) {
    blockers.push({
      code: 'image-radio-mismatch',
      message: `This codeplug came from a ${input.imageRadioId}, not a ${input.schema.model}.`,
    })
  }

  if (input.ident && input.imageVariant !== null && input.imageVariant !== input.ident.variant) {
    warnings.push({
      code: 'variant-differs',
      message:
        `This codeplug was read from firmware ${input.imageVariant}; the radio is running ` +
        `${input.ident.variant}. The driver will refuse if the two layouts are incompatible.`,
    })
  }

  // A backup of *this* radio. Not a checkbox: without one there is no way back
  // from a bad write, and the driver refuses too.
  if (!input.backup) {
    blockers.push({
      code: 'no-backup',
      message: 'There is no backup of this radio.',
      remedy: 'Read the radio first. The backup is saved automatically.',
    })
  } else if (input.ident && input.backup.identHash !== input.ident.identHash) {
    blockers.push({
      code: 'backup-other-radio',
      message: 'The backup on file was taken from a different radio or firmware.',
      remedy: 'Read this radio before writing to it.',
    })
  }

  if (input.encodeError) {
    blockers.push({
      code: 'encode-failed',
      message: input.encodeError,
    })
  }

  // A change outside the ranges the driver claims to understand means the
  // encoder wrote somewhere it should not have. That is a bug in boofwang, and
  // the only safe response is to refuse.
  if (input.unownedRanges.length > 0) {
    const where = input.unownedRanges
      .slice(0, 3)
      .map(([s, e]) => `0x${s.toString(16)}..0x${e.toString(16)}`)
      .join(', ')
    blockers.push({
      code: 'unowned-bytes-changed',
      message:
        `This edit would change ${input.unownedRanges.length} region(s) of memory that boofwang does not ` +
        `claim to understand (${where}). That is a defect in boofwang, not in your codeplug.`,
      remedy: 'Please report this, with the protocol log if you have one.',
    })
  }

  const errors = input.diagnostics.filter((d) => d.severity === 'error')
  if (errors.length > 0) {
    blockers.push({
      code: 'validation-errors',
      message: `${errors.length} channel${errors.length === 1 ? '' : 's'} would be programmed incorrectly.`,
      remedy: 'Fix the errors listed below, or remove those channels.',
    })
  }

  if (input.changedBytes === 0) {
    const scope = input.schema.capabilities.writeScope
    if (input.documentDirty && scope) {
      blockers.push({
        code: 'edits-not-writable',
        message:
          `Your edits cannot be sent to the ${input.schema.model}: this build writes only its ${scope}, ` +
          'and nothing you have changed falls inside that.',
        remedy: `Edit the ${scope} instead, or export the codeplug to a file to keep the changes.`,
      })
    } else if (input.documentDirty) {
      blockers.push({
        code: 'edits-not-writable',
        message: `Your edits encode to no change on the ${input.schema.model}, so there is nothing to send.`,
        remedy: 'This may mean the change is not one this build knows how to store. Please report it.',
      })
    } else {
      blockers.push({
        code: 'nothing-to-write',
        message: 'Nothing has changed, so there is nothing to write.',
      })
    }
  }

  for (const d of input.diagnostics) {
    if (d.severity === 'warning') warnings.push({ code: d.ruleId, message: d.message })
  }

  return { allowed: blockers.length === 0, blockers, warnings }
}

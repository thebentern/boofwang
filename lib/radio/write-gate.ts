// SPDX-License-Identifier: GPL-3.0-or-later
import type { Diagnostic, IdentifyResult } from './driver.js'
import type { RadioSchema } from './schema.js'

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
  | 'write-unsupported'
  | 'firmware-unknown'
  | 'image-radio-mismatch'
  | 'encode-failed'
  | 'unowned-bytes-changed'
  | 'validation-errors'

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
  /** Variant recorded on the image being written. */
  imageVariant: string | null
  imageRadioId: string | null
  backup: { identHash: string } | null
  diagnostics: readonly Diagnostic[]
  encodeError: string | null
  changedBytes: number
  unownedRanges: readonly (readonly [number, number])[]
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
    blockers.push({
      code: 'nothing-to-write',
      message: 'Nothing has changed, so there is nothing to write.',
    })
  }

  for (const d of input.diagnostics) {
    if (d.severity === 'warning') warnings.push({ code: d.ruleId, message: d.message })
  }

  return { allowed: blockers.length === 0, blockers, warnings }
}

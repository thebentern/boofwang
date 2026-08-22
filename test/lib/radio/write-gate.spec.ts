// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest'
import { evaluateWriteGate, type GateInput } from '#core/radio/write-gate.js'
import { UVK5_SCHEMA } from '#core/radios/uvk5/schema.js'
import type { IdentifyResult } from '#core/radio/driver.js'

const ident: IdentifyResult = {
  radioId: 'uvk5',
  variant: '2.01.32',
  layout: 'stock',
  raw: new Uint8Array(0),
  caps: { read: true, write: true },
  identHash: 'abc123',
}

const WRITABLE_SCHEMA = { ...UVK5_SCHEMA, capabilities: { ...UVK5_SCHEMA.capabilities, write: true } }

const ok = (over: Partial<GateInput> = {}): GateInput => ({
  schema: WRITABLE_SCHEMA,
  ident,
  imageVariant: '2.01.32',
  imageRadioId: 'uvk5',
  backup: { identHash: 'abc123' },
  diagnostics: [],
  encodeError: null,
  changedBytes: 128,
  unownedRanges: [],
  documentDirty: true,
  ...over,
})

const codes = (i: GateInput) => evaluateWriteGate(i).blockers.map((b) => b.code)

describe('evaluateWriteGate', () => {
  it('allows a well-formed write', () => {
    const r = evaluateWriteGate(ok())
    expect(r.allowed).toBe(true)
    expect(r.blockers).toEqual([])
  })

  it('refuses without a backup, and says how to get one', () => {
    const r = evaluateWriteGate(ok({ backup: null }))
    expect(r.allowed).toBe(false)
    expect(r.blockers.find((b) => b.code === 'no-backup')?.remedy).toMatch(/Read the radio/)
  })

  it('refuses a backup taken from a different radio', () => {
    // The hash covers radio and firmware, so a backup from another UV-K5 is not
    // a way back from a bad write to this one.
    expect(codes(ok({ backup: { identHash: 'someone-elses' } }))).toContain('backup-other-radio')
  })

  it('refuses when the driver does not support writing', () => {
    expect(codes(ok({ schema: UVK5_SCHEMA }))).toContain('write-unsupported')
  })

  it('refuses unknown firmware even when everything else is fine', () => {
    expect(
      codes(ok({ ident: { ...ident, caps: { read: true, write: false, reason: 'Unrecognised firmware' } } })),
    ).toContain('firmware-unknown')
  })

  it('refuses a codeplug from a different model', () => {
    expect(codes(ok({ imageRadioId: 'dm32uv' }))).toContain('image-radio-mismatch')
  })

  it('refuses when encoding failed', () => {
    expect(codes(ok({ encodeError: 'Channel 3: split not supported' }))).toContain('encode-failed')
  })

  it('treats a change outside the driver’s own ranges as a defect in boofwang', () => {
    // Not a warning. A stray write means the encoder is wrong, and the user's
    // codeplug is not the thing at fault.
    const r = evaluateWriteGate(ok({ unownedRanges: [[0x0e70, 0x0e80]] }))
    expect(r.allowed).toBe(false)
    const b = r.blockers.find((x) => x.code === 'unowned-bytes-changed')!
    expect(b.message).toMatch(/defect in boofwang/)
    expect(b.message).toMatch(/0xe70/)
  })

  it('refuses on validation errors but not on warnings', () => {
    expect(codes(ok({ diagnostics: [{ severity: 'error', ruleId: 'x', message: 'bad', channel: 3 }] }))).toContain(
      'validation-errors',
    )

    const warned = evaluateWriteGate(
      ok({ diagnostics: [{ severity: 'warning', ruleId: 'y', message: 'iffy', channel: 4 }] }),
    )
    expect(warned.allowed).toBe(true)
    expect(warned.warnings).toHaveLength(1)
  })

  it('refuses a no-op write', () => {
    // Explicitly not dirty: an unedited document is the "nothing has changed"
    // case. A dirty one that encodes to nothing is a different message.
    expect(codes(ok({ changedBytes: 0, documentDirty: false }))).toContain('nothing-to-write')
  })

  it('does not treat "not connected yet" as a problem', () => {
    // Reading disconnects when it finishes, and the write flow reconnects when
    // it runs. The driver re-identifies against the radio on the cable, which
    // is where the check that matters lives.
    const r = evaluateWriteGate(ok({ ident: null }))
    expect(r.allowed).toBe(true)
  })

  it('reports every blocker at once rather than one at a time', () => {
    const r = evaluateWriteGate(ok({ backup: null, changedBytes: 0, encodeError: 'nope' }))
    expect(r.blockers.length).toBeGreaterThanOrEqual(3)
  })
})

describe('a codeplug from different firmware', () => {
  it('warns, and does not block', () => {
    // Whether two firmware strings share a layout is the driver's call - some
    // UV-K5 builds are interchangeable and some are not. Blocking here would
    // refuse writes that are perfectly safe, so the gate only says so.
    const r = evaluateWriteGate(ok({ imageVariant: '2.01.31' }))
    expect(r.allowed).toBe(true)
    expect(r.warnings.map((w) => w.code)).toContain('variant-differs')
    expect(r.warnings.find((w) => w.code === 'variant-differs')!.message).toContain('2.01.31')
  })

  it('says nothing when the firmware matches', () => {
    expect(evaluateWriteGate(ok()).warnings.map((w) => w.code)).not.toContain('variant-differs')
  })

  it('says nothing when no radio is connected to compare against', () => {
    const r = evaluateWriteGate(ok({ ident: null, imageVariant: '9.99.99' }))
    expect(r.warnings.map((w) => w.code)).not.toContain('variant-differs')
  })
})

describe('edits that this radio cannot write', () => {
  // A DM-32UV writes only its key slots today. Renaming a channel there updates
  // the table and enables the write button, then encodes to nothing - and the
  // gate used to explain that as "nothing has changed", which is false and
  // sends the user looking for a bug in their own edit.
  const SCOPED = {
    ...WRITABLE_SCHEMA,
    model: 'DM-32UV',
    capabilities: { ...UVK5_SCHEMA.capabilities, write: true, writeScope: 'encryption key slots' },
  }

  it('says what can be written, rather than claiming nothing changed', () => {
    const r = evaluateWriteGate(ok({ schema: SCOPED, changedBytes: 0, documentDirty: true }))
    expect(r.allowed).toBe(false)
    expect(codes(ok({ schema: SCOPED, changedBytes: 0, documentDirty: true }))).toContain('edits-not-writable')
    const b = r.blockers.find((x) => x.code === 'edits-not-writable')!
    expect(b.message).toContain('encryption key slots')
    expect(b.message).not.toMatch(/Nothing has changed/)
    expect(b.remedy).toContain('encryption key slots')
  })

  it('still says "nothing has changed" when nothing has', () => {
    const r = evaluateWriteGate(ok({ schema: SCOPED, changedBytes: 0, documentDirty: false }))
    expect(codes(ok({ schema: SCOPED, changedBytes: 0, documentDirty: false }))).toContain('nothing-to-write')
    expect(r.blockers.find((b) => b.code === 'nothing-to-write')!.message).toMatch(/Nothing has changed/)
  })

  it('asks for a report when a dirty document encodes to nothing on a whole-codeplug radio', () => {
    // No writeScope means the radio should have been able to store the edit,
    // so encoding it to nothing is a defect rather than a limitation.
    const r = evaluateWriteGate(ok({ changedBytes: 0, documentDirty: true }))
    const b = r.blockers.find((x) => x.code === 'edits-not-writable')!
    expect(b.remedy).toMatch(/report/i)
  })

  it('does not fire when there are bytes to send', () => {
    expect(codes(ok({ schema: SCOPED, changedBytes: 9, documentDirty: true }))).not.toContain('edits-not-writable')
  })
})

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

const WRITABLE_SCHEMA = { ...UVK5_SCHEMA, capabilities: { read: true, write: true } }

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
    expect(codes(ok({ changedBytes: 0 }))).toContain('nothing-to-write')
  })

  it('refuses when nothing is connected', () => {
    expect(codes(ok({ ident: null }))).toContain('not-connected')
  })

  it('reports every blocker at once rather than one at a time', () => {
    const r = evaluateWriteGate(ok({ backup: null, ident: null, changedBytes: 0 }))
    expect(r.blockers.length).toBeGreaterThanOrEqual(3)
  })
})

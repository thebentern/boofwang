// SPDX-License-Identifier: GPL-3.0-or-later
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { SCHEMAS } from '#core/radio/registry.js'

/**
 * A panel the interface renders must correspond to something the radio has.
 *
 * This is a class of bug rather than one instance. The DMR page gates each of
 * its sections on a schema feature, except that the messages panel once fell
 * back to "is a codeplug open" - so a UV-K5, which has no message memory at
 * all, was shown an Add button. Clicking it dirtied the codeplug and produced
 * an edit the encoder silently dropped; paired with any writable edit the write
 * went through and reported "Written and verified" while the message vanished.
 *
 * A source check, deliberately: there is no Vue harness in this suite, and the
 * defect is one computed property reaching for the wrong thing.
 */
const PAGE = readFileSync(fileURLToPath(new URL('../../app/pages/dmr.vue', import.meta.url)), 'utf8')

describe('every DMR panel is gated on a schema feature', () => {
  const gates = [...PAGE.matchAll(/const (has[A-Z]\w*) = computed\(\(\) => ([^\n]*)\)/g)].map((m) => ({
    name: m[1]!,
    body: m[2]!,
  }))

  it('finds the gates it is meant to check', () => {
    expect(gates.length, 'the page no longer declares has* computeds').toBeGreaterThan(4)
  })

  it('never falls back to "a codeplug is open"', () => {
    // `isOpen` is true for every radio, so it gates nothing.
    const loose = gates.filter((g) => /codeplug\.isOpen/.test(g.body))
    expect(loose.map((g) => g.name), 'these panels would render for every radio').toEqual([])
  })

  it('gates on the schema or on decoded data, never on nothing', () => {
    // Two legitimate shapes: a schema feature, or the presence of something
    // actually decoded from this radio. `codeplug.doc?.x` counts as the second
    // - it is false when the field is absent - while `codeplug.isOpen` does
    // not, because it is true for every radio.
    const onSchema = /features\.value/
    const onData = /codeplug\.\w+\.length|codeplug\.\w+ !== null|codeplug\.doc\?\.\w+/
    const bad = gates.filter((g) => !onSchema.test(g.body) && !onData.test(g.body))
    expect(bad.map((g) => `${g.name}: ${g.body}`)).toEqual([])
  })
})

describe('every radio declares whether it stores text messages', () => {
  it('is false for the analog radios and a real limit for the DM-32UV', () => {
    for (const [id, schema] of Object.entries(SCHEMAS)) {
      if (!schema) continue
      expect(schema.features, `${id} does not declare messages`).toHaveProperty('messages')
    }
    expect(SCHEMAS.uvk5!.features.messages).toBe(false)
    expect(SCHEMAS.uv82!.features.messages).toBe(false)
    expect(SCHEMAS.uv5rmini!.features.messages).toBe(false)

    const dm32 = SCHEMAS.dm32uv!.features.messages
    expect(dm32).not.toBe(false)
    expect(dm32 && dm32.max).toBeGreaterThan(0)
    expect(dm32 && dm32.maxChars).toBeGreaterThan(0)
  })
})

describe('the connect screen chip', () => {
  const LIST = readFileSync(
    fileURLToPath(new URL('../../app/components/connect/DriverList.vue', import.meta.url)),
    'utf8',
  )

  it('says one of three things and never quotes the scope', () => {
    // It grew to thirteen clauses, pushed the radio's name off the row, and
    // opened with "Read" on a driver that writes. The scope still exists; the
    // restore screen and the write gate are where it belongs.
    const status = LIST.slice(LIST.indexOf('function statusOf'))
    const labels = [...status.matchAll(/label: '([^']+)'/g)].map((m) => m[1]!)
    expect(new Set(labels)).toEqual(new Set(['Not supported yet', 'Read and write', 'Read only']))
    expect(status).not.toContain('writeScope')
    expect(status).not.toContain('writeExcept')
  })

  it('leaves the precise scope to the screens that ask the question', () => {
    const restore = readFileSync(fileURLToPath(new URL('../../app/pages/restore.vue', import.meta.url)), 'utf8')
    const gate = readFileSync(fileURLToPath(new URL('../../lib/radio/write-gate.ts', import.meta.url)), 'utf8')
    expect(restore, 'the restore screen stopped reading writeScope').toContain('writeScope')
    expect(gate, 'the write gate stopped reading writeScope').toContain('writeScope')
  })
})

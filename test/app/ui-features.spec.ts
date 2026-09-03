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

describe('the settings form asks which layout it is rendering for', () => {
  /**
   * Same class of bug one page over. A radio can store its settings more than
   * one way - the UV-K5 arranges them differently under egzumer firmware than
   * under stock, and several addresses mean different things in the two - so a
   * group declares which layouts it belongs to. A page that reads
   * `schema.settings` directly ignores that and renders every group for every
   * image, which puts controls for egzumer's backlight range in front of
   * someone whose radio keeps something else in that byte.
   */
  const PAGE = readFileSync(fileURLToPath(new URL('../../app/pages/settings.vue', import.meta.url)), 'utf8')

  it('filters the groups by the open image\'s layout', () => {
    expect(PAGE).toMatch(/settingsForLayout\(\s*codeplug\.schema,\s*codeplug\.image\?\.layout\s*\)/)
  })

  it('never reaches for the unfiltered list', () => {
    expect(PAGE).not.toMatch(/codeplug\.schema\??\.settings/)
  })

  it('has groups that actually declare a layout, so the filter is not vacuous', () => {
    const declared = Object.values(SCHEMAS).flatMap((s) => (s ? s.settings.filter((g) => g.layouts) : []))
    expect(declared.length).toBeGreaterThan(0)
  })
})

describe('the connect screen chip', () => {
  const LIST = readFileSync(
    fileURLToPath(new URL('../../app/components/connect/DriverList.vue', import.meta.url)),
    'utf8',
  )

  it('states the capability once, above the list, not once per row', () => {
    /*
     * This used to pin a per-row chip to one of three labels. The labels were
     * right and the placement was not: every driver is built with
     * `enableWrite: true`, so all five chips read "Read and write" and the
     * column meant to carry a warning became five identical ticks - which is
     * the failure the file's own header records about the matrix before it.
     *
     * So the claim moved above the list, where being true of every row is the
     * reason to say it rather than the reason it goes unread.
     */
    expect(LIST, 'the per-row capability chip is back').not.toContain('function statusOf')
    expect(LIST).toMatch(/All five can be read and written/)
  })

  it('still never quotes the write scope on this screen', () => {
    // The original point, and it outlives the chip: the scope grew to thirteen
    // clauses and pushed the radio's own name off the row.
    const ROW = readFileSync(
      fileURLToPath(new URL('../../app/components/connect/DriverRow.vue', import.meta.url)),
      'utf8',
    )
    for (const [name, src] of [['DriverList', LIST], ['DriverRow', ROW]] as const) {
      expect(src, `${name} quotes writeScope`).not.toContain('writeScope')
      expect(src, `${name} quotes writeExcept`).not.toContain('writeExcept')
    }
  })

  it('leaves the precise scope to the screens that ask the question', () => {
    const restore = readFileSync(fileURLToPath(new URL('../../app/pages/restore.vue', import.meta.url)), 'utf8')
    const gate = readFileSync(fileURLToPath(new URL('../../lib/radio/write-gate.ts', import.meta.url)), 'utf8')
    expect(restore, 'the restore screen stopped reading writeScope').toContain('writeScope')
    expect(gate, 'the write gate stopped reading writeScope').toContain('writeScope')
  })
})

/**
 * Every list the store publishes has to be republished when it is edited.
 *
 * `republish()` rebuilds the frozen arrays the components render from. A list
 * that is published on open but missing from `republish` looks correct until
 * someone edits it, and then the edit reaches the document, the encoder and the
 * radio while the interface goes on showing the old value - the edit appears to
 * have been ignored, so it gets made twice.
 *
 * That was true of `roamZones` for as long as nothing could edit them.
 */
describe('the codeplug store republishes everything it publishes', () => {
  const STORE = readFileSync(fileURLToPath(new URL('../../app/stores/codeplug.ts', import.meta.url)), 'utf8')

  const published = [...STORE.matchAll(/^ {2}const (\w+) = shallowRef</gm)].map((m) => m[1]!)
  const body = STORE.slice(STORE.indexOf('function republish()'))
  const republished = new Set(
    [...body.slice(0, body.indexOf('\n  }')).matchAll(/^\s*(\w+)\.value = /gm)].map((m) => m[1]!),
  )

  /** Published lists the store can actually change, found from the mutations. */
  const mutable = published.filter((name) => {
    const re = new RegExp(`cp\\.${name}(\\[[^\\]]*\\]\\s*=|\\.push|\\.splice|\\.set\\(|\\.delete\\(|\\s*=[^=])`)
    return re.test(STORE)
  })

  it('finds the lists it is meant to check', () => {
    expect(published).toContain('roamZones')
    expect(published).toContain('callList')
    expect(mutable).toContain('zones')
    expect(mutable).toContain('roamZones')
    expect(mutable).toContain('callList')
    // Read-only ones must not be swept in, or the rule means nothing.
    expect(mutable).not.toContain('emergency')
    expect(mutable).not.toContain('analog')
  })

  it('republishes every list an edit can reach', () => {
    /*
     * `channels` is the one exception, and deliberate: it is copy-on-write at a
     * single index so a row edit re-renders one row rather than four thousand,
     * and its mutators publish it themselves. Everything else goes through
     * `republish`.
     */
    const missing = mutable.filter((name) => name !== 'channels' && !republished.has(name))
    expect(missing).toEqual([])
  })

  it('keeps the channel list publishing itself, since it is exempt above', () => {
    expect(STORE).toMatch(/channels\.value = /)
  })
})

/**
 * The connect screen never decides which radio is on the cable.
 *
 * It used to. `radioId` ended in `?? 'uvk5'`, so with nothing chosen the first
 * button sent a Quansheng handshake to whatever was plugged in - and a wrong
 * handshake is indistinguishable from a broken lead, because the port opens and
 * the radio simply says nothing back. The screen blamed the cable for its own
 * guess. Worse, the user's pick was third in that expression, behind a
 * handshake result that outlives the port it came from, so after reading one
 * radio, choosing another did nothing until the page was reloaded.
 *
 * A source check, because the defect is one expression and there is no Vue
 * harness in this suite.
 */
describe('the connect screen does not guess the radio', () => {
  const PAGE = readFileSync(fileURLToPath(new URL('../../app/pages/index.vue', import.meta.url)), 'utf8')

  const radioId = /const radioId = computed<[^>]*>\(\(\) =>([^)]*)\)/.exec(PAGE)?.[1] ?? ''

  it('finds the expression it is meant to check', () => {
    expect(radioId, 'radioId is no longer a computed of that shape').not.toBe('')
  })

  it('falls back to nothing rather than to a radio', () => {
    // Any bare radio id on the end of that chain is a guess.
    for (const id of ['uvk5', 'uv82', 'uv5g', 'uv5rmini', 'dm32uv']) {
      expect(radioId, `radioId falls back to '${id}'`).not.toContain(`'${id}'`)
    }
    expect(radioId).toContain('null')
  })

  it('puts the user’s choice first in the chain', () => {
    const chosen = radioId.indexOf('chosen')
    const confirmed = radioId.indexOf('confirmed')
    expect(chosen, 'the chain no longer mentions the choice').toBeGreaterThan(-1)
    if (confirmed > -1) {
      expect(chosen, 'a handshake result outranks the user again').toBeLessThan(confirmed)
    }
  })

  it('guards every route that opens a port', () => {
    /*
     * Three ways in - the port chooser, a read, and Bluetooth - and each one
     * hands a radio id to a driver. Missing a guard puts a null on that path.
     *
     * Bounded to the function's own body. This used to slice a flat 400
     * characters from the declaration, which runs past the end of the short
     * ones into the next function, so a guard deleted from `pickPort` was still
     * "found" - in `readRadio` underneath it. The count assertion below is the
     * belt: three routes, three guards, no borrowing.
     */
    const NAMES = ['async function pickPort()', 'async function readRadio(', 'async function connectBluetooth(']
    for (const fn of NAMES) {
      const at = PAGE.indexOf(fn)
      expect(at, `${fn} is gone`).toBeGreaterThan(-1)
      // Up to the next top-level function, so nothing leaks in from below.
      const rest = PAGE.slice(at + fn.length)
      const nextFn = rest.search(/\n(?:async )?function /)
      const body = nextFn === -1 ? rest : rest.slice(0, nextFn)
      expect(body, `${fn} can run without a radio chosen`).toContain('withoutARadio()')
      // And before anything that opens a port.
      const guard = body.indexOf('withoutARadio()')
      const firstAwait = body.indexOf('await ')
      if (firstAwait > -1) {
        expect(guard, `${fn} awaits before it checks`).toBeLessThan(firstAwait)
      }
    }
    expect(
      [...PAGE.matchAll(/withoutARadio\(\)/g)].length,
      'a route lost its guard, or one was added without one',
    ).toBe(NAMES.length + 1) // the three call sites, plus the declaration
  })

  it('lets the driver list do the choosing', () => {
    const LIST = readFileSync(
      fileURLToPath(new URL('../../app/components/connect/DriverList.vue', import.meta.url)),
      'utf8',
    )
    expect(LIST, 'the list no longer emits a choice').toContain("choose: [RadioId]")
    expect(PAGE, 'the page does not listen for it').toMatch(/@choose="chosen = \$event"/)
    // And a driver with no implementation has no handshake to send, so it
    // cannot be picked.
    expect(LIST).toContain('usable')
  })
})

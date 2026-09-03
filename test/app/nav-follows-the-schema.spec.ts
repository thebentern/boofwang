// SPDX-License-Identifier: GPL-3.0-or-later
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { SCHEMAS, RADIO_IDS, isImplemented } from '#core/radio/registry.js'
import type { RadioSchema } from '#core/radio/schema.js'

/**
 * Which destinations the nav is allowed to offer.
 *
 * The list was static, so every radio got all eleven. On a UV-K5 that meant
 * Keys, Fleet and Splash were reachable and empty when you arrived: the page
 * guards itself off `schema.features` and says the radio has none, which is a
 * true sentence at the end of a trip that should not have been offered.
 *
 * Two halves, tested separately. The predicates belong to the schema and are
 * checked against the real ones below. Whether the layout asks them at all is
 * a source check, in the manner of test/app/bluetooth-offer.spec.ts: there is
 * no Vue harness in this suite and the gate is one computed property.
 */
const LAYOUT = readFileSync(fileURLToPath(new URL('../../app/layouts/default.vue', import.meta.url)), 'utf8')

const nav = /const nav = computed\(\(\) => \{([\s\S]*?)\n\}\)/.exec(LAYOUT)?.[1] ?? ''

describe('the nav gate, as the layout writes it', () => {
  it('finds a computed nav rather than a static array', () => {
    // The defect was literally that this was `const nav = [...]`.
    expect(nav, 'the nav is no longer a computed').not.toBe('')
    expect(LAYOUT).not.toMatch(/const nav = \[/)
  })

  it('asks the schema, never the radio id', () => {
    // A radio the interface knows by name is a gap in the schema. This is the
    // assertion that keeps the layout from growing a second copy of 'dm32uv'.
    for (const id of RADIO_IDS) expect(nav, `the nav names ${id}`).not.toContain(`'${id}'`)
    expect(nav).toMatch(/navSchema/)
  })

  it('settles on a named model, without waiting for a codeplug', () => {
    /*
     * An open codeplug is a handshake that answered; a pick is only what the
     * user says it is. Both name a schema, and a schema is all the nav needs -
     * so making somebody open a cable first would leave the gated half missing
     * at exactly the moment they were looking for it.
     */
    const src = /const navSchema = computed\(\(\) => \{([\s\S]*?)\n\}\)/.exec(LAYOUT)?.[1] ?? ''
    expect(src, 'navSchema is no longer a computed').not.toBe('')
    expect(src).toMatch(/codeplug\.schema/)
    expect(src).toMatch(/chosenRadioId/)
  })

  it('gates the four destinations that have a feature to gate on', () => {
    expect(nav).toMatch(/'\/keys'[\s\S]*?encryption/)
    expect(nav).toMatch(/'\/fleet'[\s\S]*?radioIds/)
    expect(nav).toMatch(/'\/startup-image'[\s\S]*?bootPicture/)
    expect(nav).toMatch(/'\/settings'[\s\S]*?settings\.length/)
  })

  it('leaves the six that hold for every radio alone', () => {
    for (const to of ['/', '/channels', '/presets', '/repeaters', '/backups', '/about']) {
      expect(nav).toMatch(new RegExp(`'${to.replace('/', '\\/')}'[^\\n]*show: true`))
    }
  })

  it('names the lists page from what the radio holds', () => {
    // "Zones" on a UV-K5, which has scan lists and no zones, is the same
    // defect as an empty Keys page wearing a different label.
    expect(LAYOUT).toMatch(/listsLabel[\s\S]*?features\.zones \? 'Zones' : 'Scan lists'/)
  })
})

/**
 * The predicates themselves, against the schemas that ship.
 *
 * This is the half that fails when a radio is added and its flags are wrong,
 * which is the failure the nav gate turns into a blank page.
 */
const shown = (s: RadioSchema | null) => {
  const f = s?.features
  return {
    lists: !!f && !!(f.zones || f.talkGroups || f.scanLists || f.rxGroups || f.radioIds || f.contacts || f.messages),
    settings: (s?.settings.length ?? 0) > 0,
    keys: !!f?.encryption,
    splash: !!f?.bootPicture,
    fleet: !!f?.radioIds,
  }
}

describe('what each radio ends up offering', () => {
  it('gives the DM-32UV everything', () => {
    const r = shown(SCHEMAS.dm32uv!)
    expect(r).toEqual({ lists: true, settings: true, keys: true, splash: true, fleet: true })
  })

  it('drops Keys, Splash and Fleet on the UV-K5', () => {
    // The three that were reachable and empty. Named individually rather than
    // as a count, so a change that swaps one for another still fails.
    const r = shown(SCHEMAS.uvk5!)
    expect(r.keys).toBe(false)
    expect(r.splash).toBe(false)
    expect(r.fleet).toBe(false)
    expect(r.settings).toBe(true)
  })

  it('offers nothing gated when no codeplug is open', () => {
    // Honest rather than cautious: the schema is unknown until a radio is
    // picked, and picking one in the driver list fills it in with no cable.
    expect(shown(null)).toEqual({ lists: false, settings: false, keys: false, splash: false, fleet: false })
  })

  it('makes every implemented radio declare bootPicture', () => {
    // `false | {width,height}` rather than optional, so a new radio cannot
    // forget it and silently inherit "has a power-on picture".
    for (const id of RADIO_IDS.filter(isImplemented)) {
      const f = SCHEMAS[id]!.features
      expect(f, `${id} does not declare bootPicture`).toHaveProperty('bootPicture')
      if (f.bootPicture !== false) {
        expect(f.bootPicture.width, `${id} bootPicture width`).toBeGreaterThan(0)
        expect(f.bootPicture.height, `${id} bootPicture height`).toBeGreaterThan(0)
      }
    }
  })

  it('is the DM-32UV alone that has one, and at the size the codec expects', () => {
    const withPicture = RADIO_IDS.filter(isImplemented).filter((id) => SCHEMAS[id]!.features.bootPicture !== false)
    expect(withPicture).toEqual(['dm32uv'])
    expect(SCHEMAS.dm32uv!.features.bootPicture).toEqual({ width: 240, height: 320 })
  })
})

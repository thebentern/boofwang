// SPDX-License-Identifier: GPL-3.0-or-later
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * That a write still costs something on a phone.
 *
 * The design asked for the typed confirmation to come off the mobile write
 * screen and be replaced by one full-width button. The risk register says a
 * write is never one click from idle, and the rule wins - so what went in is a
 * drag: the hand still has to travel the width of the control and stay down
 * for the whole trip, and letting go early sends nothing.
 *
 * These assertions exist because that is a substitution somebody could later
 * "simplify" into a button without noticing what it cost. What they hold is
 * the property, not the pixels: no path from idle to sending is a single tap.
 */
const read = (p: string) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8')

const SLIDE = read('../../app/components/ConfirmSlide.vue')
const WRITE = read('../../app/pages/write.vue')
const RESTORE = read('../../app/pages/restore.vue')
const TYPED = read('../../app/components/ConfirmTyped.vue')

describe('the slide confirmation', () => {
  it('will not commit on a tap, only on travel', () => {
    // A pointerdown that never moves leaves progress at 0 and `up` resets it.
    // The threshold is what makes a flick insufficient too.
    expect(SLIDE).toMatch(/COMMIT\s*=\s*0\.9\d/)
    expect(SLIDE).toMatch(/progress\.value >= COMMIT/)
  })

  it('springs back when released short, rather than rounding up', () => {
    expect(SLIDE).toMatch(/progress\.value = 0/)
  })

  it('latches once sent, so a second drag cannot start a second write', () => {
    expect(SLIDE).toMatch(/sent\.value = true/)
    // `live` gates every handler, so latching it is what stops a re-send.
    expect(SLIDE).toMatch(/const live = computed\(\(\) => .*!sent\.value\)/)
    expect(SLIDE).toMatch(/if \(!live\.value\) return/)
  })

  it('is reachable without a pointer, and the keyboard route still travels', () => {
    /*
     * A slider only a thumb can move is a control somebody cannot reach. What
     * it must not become is a one-key bypass: Enter committing would delete
     * the friction the component exists to add, so the keys move the handle
     * and End is the one that reaches the end.
     */
    expect(SLIDE).toMatch(/role="slider"/)
    expect(SLIDE).toMatch(/aria-valuenow/)
    expect(SLIDE).toMatch(/ArrowRight/)
    expect(SLIDE).toMatch(/'End'/)
    expect(SLIDE).not.toMatch(/key === 'Enter'/)
  })

  it('takes its colour from the risk level rather than hardcoding one', () => {
    // Colour is never the only carrier, and the register must not drift per
    // component: caution and destructive read their tone from the same place.
    expect(SLIDE).toMatch(/risk === 'destructive' \? 'dg' : 'cn'/)
  })
})

describe('which confirmation each screen asks for', () => {
  it('offers the drag only where a keyboard would cover the diff', () => {
    /*
     * Keyed on viewport width, not on host: an Android tablet in landscape has
     * room for the typed field and a desktop window dragged narrow does not.
     */
    expect(WRITE).toMatch(/ConfirmSlide/)
    // The size rule moved into useFormFactor, which keys on the shorter edge in
    // a shell so a phone in landscape is still a phone. See
    // test/app/three-forms-one-breakpoint.spec.ts.
    expect(WRITE).toMatch(/useFormFactor\(\)/)
    expect(WRITE).toMatch(/v-if="narrow"/)
  })

  it('keeps the typed word on the write screen at desktop width', () => {
    expect(WRITE).toMatch(/<ConfirmTyped[\s\S]*?token="WRITE"/)
    expect(WRITE).toMatch(/v-else/)
  })

  it('keeps the typed word on restore at every width', () => {
    // A restore has no diff to keep on screen, so a keyboard covers nothing
    // worth reading, and it is the more destructive of the two actions.
    expect(RESTORE).toMatch(/token="RESTORE"/)
    expect(RESTORE).not.toMatch(/ConfirmSlide/)
  })

  it('never reduces either action to a bare RiskAction that sends', () => {
    /*
     * The failure this guards is the design's original request: one primary
     * button wired straight to `send`. Both screens must route through a
     * confirmation component.
     */
    expect(WRITE).not.toMatch(/<RiskAction[^>]*@click="send"/)
    expect(RESTORE).not.toMatch(/<RiskAction[^>]*@click="confirmRestore/)
  })

  it('leaves ConfirmTyped intact for the screens that use it', () => {
    expect(TYPED).toMatch(/matches\.value && !props\.disabled/)
  })
})

describe('the liability line', () => {
  it('appears on both actions that cannot be undone from inside the app', () => {
    for (const [name, src] of [
      ['write', WRITE],
      ['restore', RESTORE],
    ] as const) {
      expect(src, `${name} has no warranty line`).toMatch(/comes with no warranty/)
      expect(src, `${name} does not disclaim liability`).toMatch(/not liable for a radio a \w+ leaves unusable/)
    }
  })

  it('sits behind a hairline and is not dressed as the warning', () => {
    // The amber card is the warning. Nesting the legal position inside it, or
    // giving it a semantic colour, weakens both.
    expect(WRITE).toMatch(/border-top: 1px solid var\(--ln\);[\s\S]{0,120}color: var\(--fn\)/)
    expect(WRITE).not.toMatch(/comes with no warranty[\s\S]{0,200}var\(--cn\)/)
  })
})

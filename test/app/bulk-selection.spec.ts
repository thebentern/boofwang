// SPDX-License-Identifier: GPL-3.0-or-later
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * How the table's selection is wired, guarded at the source.
 *
 * A source check, matching the rest of this suite: there is no Vue harness
 * here. What it protects is a handful of one-line decisions that have no
 * runtime symptom when they regress - the click handler dropping the event
 * argument turns shift-click back into an ordinary click, and nothing throws.
 *
 * The arithmetic that could be wrong in a way worth a real test - what a patch
 * does to a channel, what allowing transmit unlocks - is in
 * `lib/radio/bulk-edit.ts` precisely so it does not have to be checked this way.
 */
const TABLE = readFileSync(
  fileURLToPath(new URL('../../app/components/ChannelTable.vue', import.meta.url)),
  'utf8',
)
const FORM = readFileSync(
  fileURLToPath(new URL('../../app/components/BulkEdit.vue', import.meta.url)),
  'utf8',
)

/**
 * One top-level function's body, and nothing after it.
 *
 * Taken to the first line that closes a block at column zero. The first version
 * of this sliced to the next comment banner instead, which ran past the end of
 * `extendTo` into `allVisibleSelected` - a function that also reads
 * `rows.value`, so the assertion below passed while the code under it was
 * rewritten to walk slot numbers.
 */
function body(source: string, declaration: string): string {
  const start = source.indexOf(declaration)
  if (start < 0) throw new Error(`${declaration} is not in the source any more`)
  const end = source.indexOf('\n}\n', start)
  return source.slice(start, end < 0 ? undefined : end)
}

describe('shift-click over a range', () => {
  it('hands the click event to the handler, or shift is invisible to it', () => {
    expect(TABLE).toMatch(/@click="toggleSelected\(r\.key, \$event\)"/)
  })

  it('extends from the row the table is showing, not from a numeric interval', () => {
    // A filtered table is the whole reason. Under "Receive-only", a numeric
    // range from the first visible row to the last would sweep in every
    // transmit-capable channel between them - none of them on screen.
    const fn = body(TABLE, 'function extendTo')
    expect(fn).toContain('const list = rows.value')
    expect(fn).not.toContain('bySlot')
  })

  it('skips the slots that hold no channel, which have no checkbox either', () => {
    expect(body(TABLE, 'function extendTo')).toMatch(/if \(!row\.channel\) continue/)
  })

  it('stops the browser extending a text selection instead', () => {
    expect(TABLE).toContain('@mousedown.shift.prevent')
  })

  it('forgets the anchor when a different codeplug is loaded, as the ticks are', () => {
    const watcher = TABLE.slice(TABLE.indexOf('() => codeplug.image'))
    expect(watcher.slice(0, 200)).toContain('anchor.value = null')
  })
})

describe('the bulk edit form', () => {
  it('is reachable from the selection bar', () => {
    expect(TABLE).toContain('bulkEditing = true')
    expect(TABLE).toMatch(/<BulkEdit[^>]*:slots="selectedProgrammed"/s)
  })

  it('is handed the selection narrowed to slots that still hold a channel', () => {
    // `selected` is never pruned - undo, redo and delete all leave ticks on
    // slots that hold nothing - so anything downstream reads `selectedProgrammed`.
    expect(TABLE).not.toMatch(/<BulkEdit[^>]*:slots="\[\.\.\.selected/s)
  })

  it('applies through one transaction, so one undo takes it back', () => {
    expect(FORM).toMatch(/codeplug\.transact\(/)
    expect(FORM).toMatch(/for \(const ch of list\) codeplug\.updateChannel\(ch\.index, bulkPatch\(ch, change\.value\)\)/)
  })

  it('builds its instruction by spreading keys in, never by assigning undefined', () => {
    // `exactOptionalPropertyTypes` is on, and the change object's whole meaning
    // rests on absent being different from null.
    const change = FORM.slice(FORM.indexOf('const change = computed'), FORM.indexOf('const exposure'))
    expect(change).not.toMatch(/:\s*undefined/)
    expect(change.match(/\.\.\.\(/g)?.length ?? 0).toBeGreaterThanOrEqual(8)
  })

  it('says what enabling transmit would unlock before the button is pressed', () => {
    expect(FORM).toContain('transmitExposure')
    expect(FORM).toMatch(/exposure\.unlocked\.length > 0/)
    expect(FORM).toContain('exposure.inReceiveOnlyBand.length')
  })

  it('starts every control on leave-alone each time it opens', () => {
    const watcher = FORM.slice(FORM.indexOf('watch(open,'), FORM.indexOf('const channels'))
    for (const control of ['power', 'bandwidth', 'modulation', 'step', 'skip', 'transmit', 'rxTone', 'txTone']) {
      expect(watcher, `${control} was not reset`).toContain(`${control}.value = KEEP`)
    }
  })
})

describe('the diagnostics panel', () => {
  it('has a tone for all three severities, including the one the new rules use', () => {
    for (const severity of ['error', 'warning', 'info']) {
      expect(TABLE).toMatch(new RegExp(`\\b${severity}: \\{ icon: 'i-lucide-`))
    }
  })

  it('no longer paints everything that is not an error as a caution', () => {
    const panel = TABLE.slice(TABLE.indexOf('v-for="(g, i) in groups"'))
    expect(panel.slice(0, 2000)).not.toContain("g.severity === 'error' ?")
  })

  it('offers no fix button for a rule that names no slot', () => {
    const panel = TABLE.slice(TABLE.indexOf('v-for="(g, i) in groups"'))
    expect(panel.slice(0, 2500).match(/v-if="g\.slots\.length"/g)?.length ?? 0).toBe(2)
  })
})

describe('the selection strip', () => {
  /*
   * The height has to be there before the first tick.
   *
   * When the bar was `v-if`-ed in, its arrival pushed the table down by most of
   * two rows - so the row under the cursor moved between the click that sets
   * the anchor and the shift-click that extends from it, and the range ended
   * short. Reserving the space is what makes a two-click range land where it
   * was aimed.
   */
  it('is rendered whether or not anything is ticked', () => {
    expect(TABLE).toContain('v-if="selectedProgrammed.length === 0"')
    expect(TABLE).not.toContain('v-if="selectedProgrammed.length > 0"')
  })

  it('measures both states from one declaration, or they drift apart', () => {
    // Five pixels is enough. The empty state was a text line and the full one a
    // 23px button, and hand-matching their padding left the strip shorter by
    // exactly that - too small to notice, big enough to move the row under the
    // cursor between the two clicks of a range.
    expect(TABLE).toMatch(/const STRIP_BOX = '[^']*min-height: 39px[^']*'/)
    const strip = TABLE.slice(TABLE.indexOf('v-if="selectedProgrammed.length === 0"'))
    expect((strip.slice(0, 1200).match(/\$\{STRIP_BOX\}/g) ?? []).length).toBe(2)
  })

  it('spends the empty state on saying that shift-click exists', () => {
    expect(TABLE).toMatch(/Shift-click a second tick/)
  })
})

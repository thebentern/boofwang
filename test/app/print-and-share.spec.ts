// SPDX-License-Identifier: GPL-3.0-or-later
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * What the printed page must and must not contain.
 *
 * There is no Vue harness in this suite and no browser to print from, so these
 * are source checks - which is the right shape for the two defects they guard
 * against, because both are a single expression going quietly wrong.
 *
 * The first is the virtualiser. The channel table mounts about forty rows and
 * that is the whole reason a 4,000-slot radio is usable; it is also, if nobody
 * intervenes, exactly what reaches the printer. A printout that silently stops
 * at slot 41 looks like a complete document.
 *
 * The second is the chrome. A nav, a status bar, a toolbar and a footer that
 * print are not merely untidy - the status bar asserts things about a live
 * serial session that are false the moment the sheet leaves the printer.
 */
const read = (path: string) => readFileSync(fileURLToPath(new URL(`../../${path}`, import.meta.url)), 'utf8')

const CSS = read('app/assets/css/main.css')
const TABLE = read('app/components/ChannelTable.vue')
const LAYOUT = read('app/layouts/default.vue')
const STATUS_BAR = read('app/components/AppStatusBar.vue')
const PRINT_MODE = read('app/composables/usePrintMode.ts')
const SESSION = read('app/composables/useRadioSession.ts')

/** The source from a landmark onwards, so a check can be about one element. */
function blockAfter(source: string, marker: string, chars = 320): string {
  const at = source.indexOf(marker)
  expect(at, `the landmark ${JSON.stringify(marker)} is no longer in the file`).toBeGreaterThan(-1)
  return source.slice(at, at + chars)
}

describe('the print stylesheet', () => {
  it('declares a print block that hides what is marked for hiding', () => {
    expect(CSS).toContain('@media print')
    const print = CSS.slice(CSS.indexOf('@media print'))
    expect(print).toMatch(/\.print-hide\s*\{[^}]*display:\s*none\s*!important/)
    // `print-only` has to be display:none by default, or the print-only heading
    // and the gutter letters would show up on screen as well.
    expect(CSS).toMatch(/\.print-only\s*\{\s*display:\s*none/)
    expect(print).toMatch(/\.print-only\s*\{[^}]*display:\s*revert\s*!important/)
  })

  it('unclamps the scroll box, which would otherwise print one screenful', () => {
    const print = CSS.slice(CSS.indexOf('@media print'))
    expect(print).toMatch(/\.ch-scroll\s*\{[^}]*max-height:\s*none\s*!important/)
    expect(print).toMatch(/\.ch-scroll\s*\{[^}]*overflow:\s*visible\s*!important/)
    expect(TABLE).toContain('ch-scroll')
    expect(TABLE).toContain('ch-frame')
  })

  it('repoints the palette at paper so a dark theme does not print as a slab', () => {
    const print = CSS.slice(CSS.indexOf('@media print'))
    expect(print).toMatch(/--bg:\s*#ffffff/)
    expect(print).toMatch(/--tx:\s*#000000/)
    // The row tints are the marking that colour cannot carry onto paper, so
    // they are dropped rather than approximated in grey.
    for (const tint of ['--okB', '--cnB', '--dgB', '--inB']) {
      expect(print).toMatch(new RegExp(`${tint}:\\s*transparent`))
    }
  })
})

describe('the interface is not printed', () => {
  it('drops the nav and the site footer', () => {
    expect(blockAfter(LAYOUT, '<header')).toContain('print-hide')
    expect(blockAfter(LAYOUT, '<footer')).toContain('print-hide')
  })

  it('drops the status bar, which is only true while a session is live', () => {
    expect(blockAfter(STATUS_BAR, 'v-if="codeplug.isOpen"')).toContain('print-hide')
  })

  it('drops the table’s own toolbar and footer', () => {
    expect(blockAfter(TABLE, '<!-- Toolbar -->')).toContain('print-hide')
    expect(blockAfter(TABLE, '<!-- Footer')).toContain('print-hide')
  })

  it('introduces the sheet in their place', () => {
    // With the status bar gone, nothing else on the page says which radio this
    // is or when it was printed.
    const heading = blockAfter(TABLE, 'class="print-only"', 700)
    expect(heading).toContain('radioName')
    expect(heading).toContain('printedFacts')
  })
})

describe('printing bypasses the virtualiser', () => {
  it('renders every channel while printing, and the window otherwise', () => {
    const block = blockAfter(TABLE, 'const renderedRows = computed', 500)
    expect(block).toContain('if (printing.value)')

    const printBranch = block.slice(block.indexOf('if (printing.value)'), block.indexOf('return virtualizer'))
    expect(printBranch).toContain('printRows.value')
    expect(printBranch, 'the print path still asks the virtualiser what is visible').not.toContain('getVirtualItems')

    // And the screen path is untouched: this is a mode, not a removal.
    expect(block).toContain('virtualizer.value.getVirtualItems()')
  })

  it('lays the rows out in flow, because absolute rows cannot paginate', () => {
    const block = blockAfter(TABLE, 'function rowStyle', 600)
    expect(block).toContain('if (printing.value) return base')
    expect(block).toContain("position: 'absolute'")
  })

  it('drops the spacer the virtualiser needs, which would print as blank pages', () => {
    const block = blockAfter(TABLE, 'const bodyStyle = computed', 300)
    expect(block).toContain('printing.value')
    expect(block).toContain('totalHeight.value')
  })
})

describe('receive-only survives losing colour', () => {
  it('has a printed marking that is a character, not a mask-image', () => {
    // A `UIcon` is a CSS mask, and a printer drops it with the rest of the
    // background graphics unless someone went looking for the setting.
    expect(TABLE).toMatch(/'receive-only':\s*\{[^}]*mark:\s*'RX'/)
    const gutter = blockAfter(TABLE, '<!-- Status gutter -->', 600)
    expect(gutter).toContain('class="print-hide"')
    expect(gutter).toContain('print-only')
    expect(gutter).toContain('r.view.gutter.mark')
  })

  it('says what the marking means on the sheet itself', () => {
    expect(TABLE).toContain('RX = receive-only')
  })
})

describe('the shareable summary is wired to the Export control', () => {
  it('is offered next to the other exports', () => {
    expect(TABLE).toContain('downloadSummaryHtml()')
    expect(TABLE).toContain('downloadSummaryMarkdown()')
    expect(TABLE).toContain('A summary never includes encryption keys')
  })

  it('is produced by the framework-agnostic core, not assembled in the page', () => {
    expect(SESSION).toContain("from '#core/io/summary.js'")
    expect(SESSION).toContain('summaryHtml(summary)')
    expect(SESSION).toContain('summaryMarkdown(summary)')
    expect(TABLE).not.toContain('#core/io/summary.js')
  })
})

describe('print mode is entered by both routes', () => {
  it('listens for the browser’s own print, and for Safari’s media query', () => {
    expect(PRINT_MODE).toContain("addEventListener('beforeprint'")
    expect(PRINT_MODE).toContain("addEventListener('afterprint'")
    expect(PRINT_MODE).toContain("matchMedia?.('print')")
  })

  it('lets Vue flush before opening the dialog itself', () => {
    // The whole point of the button: a script-initiated `window.print()` runs
    // with a non-empty stack, so no microtask checkpoint happens between the
    // flag being set and the page being laid out. `nextTick` is the checkpoint.
    const block = blockAfter(PRINT_MODE, 'async function print()', 260)
    expect(block.indexOf('await nextTick()')).toBeLessThan(block.indexOf('window.print()'))
  })
})

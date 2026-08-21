// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Is this page about to be printed?
 *
 * The channel table renders a window of about forty rows and nothing else,
 * which is what keeps four thousand slots usable. It is also what would put
 * forty rows on paper. Printing therefore has to be a state the table can see,
 * so it can drop out of the virtualiser for the one render that goes to the
 * printer - a cost that is fine once and would be intolerable continuously.
 *
 * Two ways in, because there are two ways out.
 *
 * `print()` is the deterministic one, used by the button: set the flag, let Vue
 * flush, then open the dialog. Nothing races.
 *
 * `beforeprint` covers Ctrl+P, where nothing of ours runs first. It works
 * because the print is browser-initiated: the listener returns to an empty
 * JavaScript stack, the microtask checkpoint that follows is where Vue's
 * scheduler flushes, and only then does the browser lay the page out. That
 * ordering does not hold when a script calls `window.print()` itself - the
 * stack is not empty and no checkpoint happens - which is exactly why the
 * button does not rely on this path.
 *
 * Safari fires neither event and answers a print media query instead, so that
 * is registered too.
 */
const printing = ref(false)

let consumers = 0
let detach: (() => void) | null = null

function attach(): () => void {
  const before = () => {
    printing.value = true
  }
  const after = () => {
    printing.value = false
  }

  window.addEventListener('beforeprint', before)
  window.addEventListener('afterprint', after)

  const media = window.matchMedia?.('print') ?? null
  const onMedia = (e: MediaQueryListEvent) => {
    printing.value = e.matches
  }
  media?.addEventListener('change', onMedia)

  return () => {
    window.removeEventListener('beforeprint', before)
    window.removeEventListener('afterprint', after)
    media?.removeEventListener('change', onMedia)
    printing.value = false
  }
}

export function usePrintMode() {
  if (import.meta.client) {
    if (consumers === 0) detach = attach()
    consumers++
    onScopeDispose(() => {
      consumers--
      if (consumers === 0) {
        detach?.()
        detach = null
      }
    }, true)
  }

  /**
   * Print, having first rendered everything that has to be on the paper.
   *
   * `window.print()` blocks until the dialog is dismissed in every browser that
   * can drive a radio, so the flag can be cleared once it returns. It is only
   * cleared here when the browser has no `afterprint` to clear it, so that a
   * browser which does return early is not left printing a table that has
   * already collapsed back to forty rows.
   */
  async function print() {
    printing.value = true
    await nextTick()
    try {
      window.print()
    } finally {
      if (!('onafterprint' in window)) printing.value = false
    }
  }

  return { printing: readonly(printing), print }
}

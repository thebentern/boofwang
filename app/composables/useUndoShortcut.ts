// SPDX-License-Identifier: GPL-3.0-or-later
// Vue's reactivity is imported rather than left to Nuxt's auto-imports, for
// the same reason the codeplug store does it: the shortcut's guards are
// exercised by a spec that runs outside the Nuxt build, where there is nothing
// to supply `ref` or `computed`. Nuxt takes an explicit import in preference to
// its own, so nothing changes for the app.
import { computed, onScopeDispose, ref, watch } from 'vue'
import { useCodeplugStore } from '~/stores/codeplug'

/**
 * Ctrl/Cmd-Z for the whole codeplug, from whichever screen made the edit.
 *
 * There is one history over one open document, but the edits that fill it are
 * made on several pages: channels in the table, zones and the DMR lists on
 * their own page, settings on another. While the shortcut and its buttons
 * lived inside the channel table, the person who had just done the thing they
 * wanted back had to navigate somewhere else to take it back - and the further
 * the edit was from the channel table, the less likely they were to guess that
 * was where the way back lived.
 *
 * So the listener is installed once, by the status bar, which is the only
 * component mounted on every page a codeplug can be edited from.
 */

/**
 * How many inline editors are open anywhere in the app.
 *
 * Counted rather than flagged because the state is published by whichever
 * component owns the editor and withdrawn when that component goes away, and
 * two of them open at once must not have the first to close speak for both.
 *
 * State rather than a query for the open field, because the field is focused a
 * tick or more after it opens - the channel table's virtualiser has to mount
 * the row first, which can follow a two-hundred-row scroll - and for that
 * window the editor is open without being either rendered or focused.
 */
const editorsOpen = ref(0)

/** Is some component's own editor holding the shortcut? */
export const undoShortcutHeld = computed(() => editorsOpen.value > 0)

/**
 * Hold the shortcut while this component's editor is open.
 *
 * Released on unmount as well as on the editor closing, so a page torn down
 * mid-edit cannot leave the shortcut held for the rest of the session.
 */
export function suppressUndoShortcut(open: () => boolean) {
  let held = false
  const set = (on: boolean) => {
    if (on === held) return
    held = on
    editorsOpen.value += on ? 1 : -1
  }
  // Synchronous, because this is read from a keydown listener rather than
  // from a render. A watcher that settles on the next microtask leaves a
  // window in which the editor is open and the shortcut does not yet know it,
  // and the whole point of publishing this as state was to close exactly that
  // kind of window.
  watch(open, set, { immediate: true, flush: 'sync' })
  onScopeDispose(() => set(false), true)
}

/** Anything that keeps an undo history of its own: a field being typed into. */
function isTextEntry(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  if (!el || typeof el.tagName !== 'string') return false
  return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable === true
}

/** The parts of a keydown this decision reads. */
export interface ShortcutKey {
  readonly key: string
  readonly metaKey: boolean
  readonly ctrlKey: boolean
  readonly altKey: boolean
  readonly shiftKey: boolean
  readonly target: EventTarget | null
}

/**
 * What this keystroke should do to the history, if anything.
 *
 * Pure and separate from the listener because these three refusals are the
 * whole of what makes a document-wide shortcut safe, and they are the part of
 * this file that has no business being hard to test.
 *
 * A cell editor is open on every second keystroke in the channel table, and
 * Ctrl-Z over a half-typed name means the browser's own undo of that typing.
 * Taking that away to revert the codeplug instead would be the worst kind of
 * surprise: the keystroke would appear to do nothing, and some other channel
 * would silently have changed. The filter box and the full editor's fields are
 * covered by the same test.
 *
 * The dialog test covers the case the field test cannot. The channel editor is
 * a modal over a table that is still mounted underneath it, so with the focus
 * on a select or a switch rather than an input, the shortcut would revert an
 * edit behind an open form whose Save would then put it straight back. Nothing
 * to undo is the right answer while an overlay owns the screen.
 *
 * `dialogOpen` is a function rather than a value so that the search of the DOM
 * for an overlay happens only once a Ctrl-Z has already been recognised,
 * rather than on every keystroke typed anywhere in the app.
 */
export function undoShortcutAction(
  e: ShortcutKey,
  ctx: { held: boolean; dialogOpen: () => boolean },
): 'undo' | 'redo' | null {
  if (e.key.toLowerCase() !== 'z' || !(e.metaKey || e.ctrlKey) || e.altKey) return null
  if (ctx.held || isTextEntry(e.target)) return null
  if (ctx.dialogOpen()) return null
  return e.shiftKey ? 'redo' : 'undo'
}

/**
 * The shortcut hint, in the modifier this machine actually uses.
 *
 * Told from the platform rather than assumed, because a tooltip that says Ctrl
 * to a Mac user is worse than no tooltip: it names a key that does nothing.
 */
const isApple = computed(() =>
  typeof navigator === 'undefined' ? false : /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent),
)

export const undoHint = computed(() => (isApple.value ? '⌘Z' : 'Ctrl+Z'))
export const redoHint = computed(() => (isApple.value ? '⇧⌘Z' : 'Shift+Ctrl+Z'))

/**
 * Which consumer owns the one live listener.
 *
 * A second mount of the status bar - a test that mounts it twice, or a layout
 * that grows a second one - would otherwise take back two actions per press,
 * and an undo that silently skips a step is worse than one that does not fire
 * at all. The first caller wins and releases on unmount, rather than the last
 * caller winning, so a transient double mount cannot leave the surviving bar
 * inert.
 */
let owner: symbol | null = null

/**
 * Install the document-wide undo and redo shortcut.
 *
 * Mounted alongside the buttons rather than in the layout, so the keyboard
 * path and the pointer path to the same two actions cannot drift apart.
 */
export function useUndoShortcut() {
  const codeplug = useCodeplugStore()
  const token = Symbol('undo-shortcut')
  if (owner === null) owner = token
  onScopeDispose(() => {
    if (owner === token) owner = null
  }, true)

  // A raw listener rather than VueUse's, because `@vueuse/core` is only here
  // as a transitive dependency of the Nuxt module and this file is imported
  // directly by its spec. `usePrintMode` attaches its own for the same reason.
  if (typeof window === 'undefined') return

  const onKeydown = (e: KeyboardEvent) => {
    if (owner !== token) return
    const action = undoShortcutAction(e, {
      held: undoShortcutHeld.value,
      dialogOpen: () => document.querySelector('[role="dialog"]') !== null,
    })
    if (action === null) return
    e.preventDefault()
    if (action === 'redo') codeplug.redo()
    else codeplug.undo()
  }

  window.addEventListener('keydown', onKeydown)
  onScopeDispose(() => window.removeEventListener('keydown', onKeydown), true)
}

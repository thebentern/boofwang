// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest'
import { effectScope, ref } from 'vue'
import {
  suppressUndoShortcut,
  undoShortcutAction,
  undoShortcutHeld,
} from '~/composables/useUndoShortcut'

/**
 * The guards that make a document-wide shortcut safe.
 *
 * Undo and redo used to live inside the channel table, where the only screen
 * that could reach them was the one screen whose local state told the listener
 * when to keep quiet. Moving them to the status bar put the listener on every
 * page, which is the point - and also the hazard, because each of these three
 * refusals was written against a specific way the shortcut goes wrong, and a
 * move is exactly when that kind of reason gets dropped.
 *
 * The decision is tested rather than the listener: there is no DOM in this
 * suite, and what has to survive is which keystrokes act, not how they are
 * subscribed to.
 */

/** A keydown, with the shape the decision reads and nothing else. */
function key(over: Partial<Parameters<typeof undoShortcutAction>[0]> = {}) {
  return {
    key: 'z',
    metaKey: true,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    target: null,
    ...over,
  }
}

/** An element, as the decision inspects one. */
function el(tagName: string, isContentEditable = false) {
  return { tagName, isContentEditable } as unknown as EventTarget
}

const free = { held: false, dialogOpen: () => false }

describe('which keystrokes reach the history', () => {
  it('takes Cmd-Z and Ctrl-Z, and Shift for redo', () => {
    expect(undoShortcutAction(key(), free)).toBe('undo')
    expect(undoShortcutAction(key({ metaKey: false, ctrlKey: true }), free)).toBe('undo')
    expect(undoShortcutAction(key({ shiftKey: true }), free)).toBe('redo')
  })

  it('ignores Z without a modifier, and Alt-Z', () => {
    expect(undoShortcutAction(key({ metaKey: false }), free)).toBeNull()
    // Alt-Z is a character on several layouts, and undoing while someone types
    // one would be a keystroke that appears to do nothing to the text.
    expect(undoShortcutAction(key({ altKey: true }), free)).toBeNull()
  })

  it('is told the key case-insensitively', () => {
    // Caps lock, or Shift-Cmd-Z on a browser that reports the shifted letter.
    expect(undoShortcutAction(key({ key: 'Z', shiftKey: true }), free)).toBe('redo')
  })
})

describe('the three refusals', () => {
  it('leaves a text field its own undo', () => {
    // Reverting the codeplug instead of the typing would look like a dead
    // keystroke, with some other channel silently changed.
    for (const t of [el('INPUT'), el('TEXTAREA'), el('DIV', true)]) {
      expect(undoShortcutAction(key({ target: t }), free)).toBeNull()
    }
    expect(undoShortcutAction(key({ target: el('DIV') }), free)).toBe('undo')
  })

  it('keeps quiet while an overlay owns the screen', () => {
    // The channel editor is a modal over a table still mounted underneath it,
    // and its selects and switches are not text fields.
    expect(undoShortcutAction(key(), { held: false, dialogOpen: () => true })).toBeNull()
  })

  it('keeps quiet while a component holds it for its own editor', () => {
    // The channel table's cell editor is open before it is focused, so the
    // field test above cannot see it.
    expect(undoShortcutAction(key(), { held: true, dialogOpen: () => false })).toBeNull()
  })

  it('does not go looking for an overlay on keystrokes that are not the shortcut', () => {
    // The search is a DOM query and this listener sees every key typed in the
    // app, including every keystroke into the channel table's cell editors.
    let searched = 0
    const dialogOpen = () => {
      searched++
      return false
    }
    undoShortcutAction(key({ key: 'a' }), { held: false, dialogOpen })
    undoShortcutAction(key({ target: el('INPUT') }), { held: false, dialogOpen })
    expect(searched).toBe(0)

    undoShortcutAction(key(), { held: false, dialogOpen })
    expect(searched).toBe(1)
  })
})

describe('holding the shortcut', () => {
  it('follows the editor open and closed', () => {
    const scope = effectScope()
    const open = ref(false)
    scope.run(() => suppressUndoShortcut(() => open.value))

    expect(undoShortcutHeld.value).toBe(false)
    open.value = true
    expect(undoShortcutHeld.value).toBe(true)
    open.value = false
    expect(undoShortcutHeld.value).toBe(false)
    scope.stop()
  })

  it('releases when the component goes away mid-edit', () => {
    // A page torn down with a cell editor open would otherwise hold the
    // shortcut for the rest of the session.
    const scope = effectScope()
    const open = ref(true)
    scope.run(() => suppressUndoShortcut(() => open.value))
    expect(undoShortcutHeld.value).toBe(true)

    scope.stop()
    expect(undoShortcutHeld.value).toBe(false)
  })

  it('needs every holder to let go, not just the first', () => {
    const a = effectScope()
    const b = effectScope()
    a.run(() => suppressUndoShortcut(() => true))
    b.run(() => suppressUndoShortcut(() => true))
    expect(undoShortcutHeld.value).toBe(true)

    a.stop()
    expect(undoShortcutHeld.value).toBe(true)
    b.stop()
    expect(undoShortcutHeld.value).toBe(false)
  })
})

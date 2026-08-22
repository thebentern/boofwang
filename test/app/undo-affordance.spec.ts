// SPDX-License-Identifier: GPL-3.0-or-later
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * The way back has to be reachable from wherever the edit was made.
 *
 * One history serves one open codeplug, but the edits that fill it are made on
 * several pages. For a while the undo buttons and the Ctrl/Cmd-Z listener both
 * lived inside the channel table, which only the channels page mounts - so an
 * edit made anywhere else could only be taken back by navigating to a screen
 * that had nothing to do with it, and a user who did not already know the
 * feature existed had no way to find out.
 *
 * That is a placement bug rather than a logic one, so it is checked where
 * placement is decided. A source check, deliberately: these projects have no
 * DOM and no Vue harness, and what has to hold is which component mounts what.
 */
const app = fileURLToPath(new URL('../../app', import.meta.url))

function vueFiles(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) out.push(...vueFiles(path))
    else if (name.endsWith('.vue')) out.push(path)
  }
  return out
}

const files = vueFiles(app).map((path) => ({
  path,
  name: path.slice(app.length + 1),
  source: readFileSync(path, 'utf8'),
}))

const layout = files.find((f) => f.name === 'layouts/default.vue')!
const statusBar = files.find((f) => f.name === 'components/AppStatusBar.vue')!
const control = files.find((f) => f.name === 'components/UndoRedo.vue')!

describe('undo and redo are reachable from every page', () => {
  it('finds the files it is meant to check', () => {
    expect(files.length).toBeGreaterThan(10)
    for (const f of [layout, statusBar, control]) expect(f).toBeDefined()
  })

  it('is mounted by the status bar, which the layout mounts on every page', () => {
    expect(statusBar.source).toMatch(/<UndoRedo\s*\/>/)
    expect(layout.source).toMatch(/<AppStatusBar\s*\/>/)
  })

  it('is not gated on a route, a radio feature or a page', () => {
    // The status bar renders while a codeplug is open and not otherwise, which
    // is the one condition undo should have. Anything narrower would put the
    // control back on some pages and not others.
    const mount = /<UndoRedo\s*\/>/.exec(statusBar.source)!
    const line = statusBar.source.slice(0, mount.index).split('\n').length
    const context = statusBar.source.split('\n').slice(line - 3, line).join('\n')
    expect(context).not.toMatch(/v-if|v-show/)
  })
})

describe('one control and one listener, not one per page', () => {
  /** Everything that presses the history, other than the shared control. */
  const callers = files.filter(
    (f) => f.name !== 'components/UndoRedo.vue' && /codeplug\.(undo|redo)\(\)/.test(f.source),
  )

  it('no page or component keeps an undo control of its own', () => {
    // A second pair would not be merely redundant. The two would disagree the
    // moment one of them grew a guard the other did not.
    expect(callers.map((f) => f.name)).toEqual([])
  })

  it('the keyboard shortcut is installed exactly once', () => {
    // Two live listeners take back two actions per press, and an undo that
    // silently skips a step is worse than one that does not fire at all.
    const installers = files.filter((f) => /\buseUndoShortcut\(\)/.test(f.source))
    expect(installers.map((f) => f.name)).toEqual(['components/AppStatusBar.vue'])
  })

  it('names the action a press would take back', () => {
    // One stack behind several screens: the press that reverts a talk group
    // import and the press that reverts a frequency typo look identical, and
    // the label the store keeps is the only thing that tells them apart.
    expect(control.source).toMatch(/codeplug\.undoLabel/)
    expect(control.source).toMatch(/codeplug\.redoLabel/)
  })

  it('carries the word in an accessible name, not only in the visible label', () => {
    // The visible word is hidden on a narrow bar, and the two icons are
    // approximations - lucide ships no undo or redo arrow in this bundle - so
    // without this the control would be two unlabelled glyphs on a laptop.
    expect(control.source).toMatch(/aria-label="undoTitle"/)
    expect(control.source).toMatch(/aria-label="redoTitle"/)
  })
})

// SPDX-License-Identifier: GPL-3.0-or-later
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * A read must not throw away unwritten edits without asking.
 *
 * `connectAndRead` stored the backup and then loaded what it read over the
 * open codeplug, edits and all, without a word. The write gate's remedy for a
 * missing backup was "read the radio first", and a codeplug opened from a
 * file of a radio with no backup stored is exactly where that blocker
 * appears, so the remedy was the way in.
 *
 * Source checks, because what is guarded is an ordering the browser imposes:
 * the port chooser needs transient activation, so the question cannot sit
 * between the click and the chooser. It takes the chooser's place, and the
 * slide that answers it starts the read. Nothing here can open a chooser to
 * prove that; what it can do is fail when an await or a direct call creeps in
 * between. The store's answers are covered in test/nuxt/read-over-edits.
 */
const root = fileURLToPath(new URL('../..', import.meta.url))
const read = (rel: string) => readFileSync(join(root, rel), 'utf8')

const SESSION = read('app/composables/useRadioSession.ts')
const PAGE = read('app/pages/index.vue')
const PANEL = read('app/components/ReadOverEdits.vue')
const FLEET_SESSION = read('app/composables/useFleetSession.ts')
const FLEET_PAGE = read('app/pages/fleet.vue')

/** One function, from its declaration to its closing brace at `indent`. */
function body(source: string, declaration: string, indent = ''): string {
  const at = source.indexOf(declaration)
  expect(at, `${declaration} is gone`).toBeGreaterThan(-1)
  const end = source.indexOf(`\n${indent}}\n`, at)
  return source.slice(at, end === -1 ? undefined : end)
}

const script = (sfc: string) => sfc.slice(0, sfc.indexOf('</script>'))
const template = (sfc: string) => sfc.slice(sfc.indexOf('</script>'))

describe('connectAndRead', () => {
  const fn = body(SESSION, 'async function connectAndRead(', '  ')

  it('refuses before it opens a chooser, not after somebody has used one', () => {
    const asked = fn.indexOf('codeplug.canReplace(')
    expect(asked, 'connectAndRead no longer asks whether it may replace the codeplug').toBeGreaterThan(-1)
    expect(asked).toBeLessThan(fn.indexOf('acquirePort('))
    // And synchronously: an await ahead of it would be spent activation.
    expect(asked).toBeLessThan(fn.indexOf('await '))
  })

  it('asks again between storing the backup and opening the read', () => {
    // Edits made on the channel page while the radio was being read were
    // never part of any agreement. The backup still stands; only the load
    // waits on the answer.
    const put = fn.indexOf('db.putBackup(')
    const load = fn.indexOf('codeplug.load(')
    const again = fn.indexOf('codeplug.canReplace(', put)
    expect(again, 'the second check is gone').toBeGreaterThan(put)
    expect(again).toBeLessThan(load)
  })

  it('is told what was agreed to, rather than told to go ahead', () => {
    // A boolean would carry an agreement given for one set of edits over to
    // the next. The revision covers exactly what was on screen.
    expect(SESSION).toMatch(/readonly discarding\?: number \| null/)
    expect(fn).toMatch(/canReplace\(options\.discarding/)
  })
})

describe('every caller of connectAndRead', () => {
  /*
   * The decision is per caller, so the callers are found rather than listed:
   * a new one has to say what it may discard, or `connectAndRead` refuses.
   */
  const callers: { file: string; call: string }[] = []
  const walk = (dir: string) => {
    for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
      const rel = join(dir, entry.name)
      if (entry.isDirectory()) walk(rel)
      else if (/\.(vue|ts)$/.test(entry.name)) {
        const source = read(rel)
        for (const m of source.matchAll(/session\.connectAndRead\(([^)]*)\)/g)) {
          callers.push({ file: rel, call: m[1] ?? '' })
        }
      }
    }
  }
  walk('app')

  it('are the connect page and the fleet run', () => {
    expect(callers.map((c) => c.file).sort()).toEqual(['app/composables/useFleetSession.ts', 'app/pages/index.vue'])
  })

  it('each say what they may discard', () => {
    for (const c of callers) expect(c.call, c.file).toMatch(/discarding:/)
  })
})

describe('the connect page', () => {
  const S = script(PAGE)
  const T = template(PAGE)

  it('starts no read from the template except through onAction', () => {
    // A card event wired straight to `readRadio` is a read that never meets
    // the question.
    for (const name of ['pickPort', 'readRadio', 'connectBluetooth', 'useCableInstead']) {
      expect(T, `the template calls ${name} directly`).not.toMatch(new RegExp(`\\b${name}\\b`))
    }
    for (const event of ['@read', '@other-port', '@bluetooth']) {
      expect(T, `${event} no longer goes through onAction`).toMatch(new RegExp(`${event}="onAction\\('`))
    }
  })

  it('puts every read onAction knows about behind the question', () => {
    const fn = body(S, 'function onAction(')
    for (const key of ['pick', 'cable', 'read', 'bluetooth', 'bluetooth-all']) {
      expect(fn, `'${key}' skips unlessItDiscards`).toMatch(new RegExp(`key === '${key}'\\) unlessItDiscards\\(`))
    }
  })

  it('reaches the read functions from nowhere else', () => {
    // Outside onAction, the only calls left are the hand-offs from a chooser
    // to the read it was opened for, and they carry the agreement on.
    const outside = S.replace(body(S, 'function onAction('), '')
    const calls = [...outside.matchAll(/(?<!function )\b(pickPort|readRadio|connectBluetooth|useCableInstead)\(([^)]*)\)/g)]
      .map((m) => `${m[1]}(${m[2]})`)
    expect(calls.sort()).toEqual(['pickPort(consent)', 'readRadio(choice, consent)', 'readRadio(choice, consent)'])
  })

  it('asks only when the read would lose something', () => {
    const fn = body(S, 'function unlessItDiscards(')
    expect(fn).toMatch(/codeplug\.canReplace\(\)/)
    expect(fn).toMatch(/heldRead\.value = start/)
    expect(fn).not.toMatch(/await /)
  })

  it('starts the read inside the slide’s own event, awaiting nothing first', () => {
    const fn = body(S, 'function discardAndRead(')
    expect(fn).not.toMatch(/await /)
    expect(fn).toMatch(/start\?\.\(codeplug\.revision\)/)
  })

  it('puts the question where the card was, not beside it', () => {
    const panel = T.indexOf('<ReadOverEdits')
    expect(panel, 'the connect page no longer asks').toBeGreaterThan(-1)
    expect(T.slice(panel, panel + 120)).toMatch(/v-if="askingToDiscard"/)
    expect(T).toMatch(/<ConnectConnectedCard\s+v-else-if="link === 'ready'"/)
    expect(T).toMatch(/@confirm="discardAndRead"/)
  })
})

describe('the question', () => {
  it('is the destructive slide, with the verb under the thumb', () => {
    const slide = PANEL.slice(PANEL.indexOf('<ConfirmSlide'), PANEL.indexOf('</ConfirmSlide>'))
    expect(slide).toMatch(/risk="destructive"/)
    expect(slide).toMatch(/label="Slide to discard edits and read"/)
  })

  it('passes the slide’s answer straight through', () => {
    // A handler that awaited anything here would spend the activation the
    // chooser needs before the page ever saw the answer.
    expect(PANEL).toMatch(/@confirm="emit\('confirm'\)"/)
  })

  it('offers the way to keep the edits beside the way to lose them', () => {
    expect(PANEL).toMatch(/label="Save a copy"/)
    expect(PANEL).toMatch(/session\.downloadBwp\(\)/)
    expect(PANEL).toMatch(/label="Keep editing"/)
  })
})

describe('the fleet run', () => {
  it('vouches for the documents it put in the editor, and only those', () => {
    const read = body(FLEET_SESSION, 'async function readUnit(', '  ')
    expect(read).toMatch(/discarding: consent \?\? fleet\.editorRevision/)
    // The plan is noted after it is handed over, or the next read would see
    // the run's own document as somebody's edit.
    expect(read.indexOf('fleet.noteEditor(')).toBeGreaterThan(read.indexOf('codeplug.replaceDocument('))
    expect(body(FLEET_SESSION, 'function startRun(', '  ')).toMatch(/fleet\.noteEditor\(codeplug\.revision\)/)
  })

  it('asks before a read that would lose an edit made by hand', () => {
    const S = script(FLEET_PAGE)
    const program = body(S, 'function program(')
    expect(program.indexOf('run.canRead()')).toBeGreaterThan(-1)
    expect(program.indexOf('run.canRead()')).toBeLessThan(program.indexOf('readRadio('))
    const answer = body(S, 'function discardAndRead(')
    expect(answer).not.toMatch(/await /)
    expect(answer).toMatch(/readRadio\(unit, codeplug\.revision\)/)
    expect(template(FLEET_PAGE)).toMatch(/<ReadOverEdits[\s\S]*?@confirm="discardAndRead"/)
  })
})

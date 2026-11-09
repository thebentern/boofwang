// SPDX-License-Identifier: GPL-3.0-or-later
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * Nothing puts a different codeplug in the editor without asking about the
 * unwritten edits it would take with it.
 *
 * A read did that, and so did opening a file, "Replace what's open" in the
 * donor dialog, opening a backup and finishing a restore: each loaded
 * something over the editor without looking at `dirty`. Ending a fleet run
 * dropped the only copy of an edited master while its slide named only the
 * record.
 *
 * Source checks, because what is guarded is which function asks before which
 * call. The store's answers are covered in test/nuxt/open-over-edits and
 * test/nuxt/read-over-edits, and which merge edits are lost in
 * test/lib/radio/transplant.
 */
const root = fileURLToPath(new URL('../..', import.meta.url))
const read = (rel: string) => readFileSync(join(root, rel), 'utf8')

const BUTTON = read('app/components/OpenCodeplugButton.vue')
const BACKUPS = read('app/pages/backups.vue')
const RESTORE = read('app/pages/restore.vue')
const SESSION = read('app/composables/useRadioSession.ts')
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

/** Comments blanked to spaces, so a call named in one is not counted and offsets survive. */
const blank = (s: string) => s.replace(/\/\*[\s\S]*?\*\/|<!--[\s\S]*?-->|(?<![:'"`])\/\/[^\n]*/g, (m) => m.replace(/[^\n]/g, ' '))

interface Site {
  readonly where: string
  readonly asked: boolean
  readonly inTemplate: boolean
}

/**
 * Every call that swaps the editor's document, found rather than listed, with
 * whether the function it sits in asks `canReplace` before it.
 */
function sites(): Site[] {
  const out: Site[] = []
  const walk = (dir: string) => {
    for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
      const rel = join(dir, entry.name)
      if (entry.isDirectory()) walk(rel)
      else if (/\.(vue|ts)$/.test(entry.name) && rel !== join('app', 'stores', 'codeplug.ts')) {
        const source = blank(read(rel))
        const scriptEnd = rel.endsWith('.vue') ? source.indexOf('</script>') : source.length
        for (const m of source.matchAll(/codeplug\.(load|replaceDocument|close)\(/g)) {
          const before = source.slice(0, m.index)
          const decl = [...before.matchAll(/function (\w+)\(/g)].at(-1)
          const asked = decl !== undefined && /codeplug\.canReplace\(/.test(source.slice(decl.index, m.index))
          out.push({ where: `${rel} ${decl?.[1] ?? '?'} ${m[1]}`, asked, inTemplate: m.index > scriptEnd })
        }
      }
    }
  }
  walk('app')
  return out
}

describe('every call that puts a different codeplug in the editor', () => {
  const all = sites()

  it('is made from a script, where it can be checked, not from a template', () => {
    expect(all.filter((s) => s.inTemplate).map((s) => s.where)).toEqual([])
  })

  it('asks first, unless what it replaces can be made again', () => {
    expect(all.filter((s) => !s.asked).map((s) => s.where).sort()).toEqual([
      // The plan replaces the read `connectAndRead` has just loaded, and that
      // read asked. Nothing has been edited between the two.
      join('app', 'composables', 'useFleetSession.ts') + ' readUnit replaceDocument',
      // What was just written, which the radio now holds. An edit made while
      // the write ran is lost here as well, and nothing asks about that yet:
      // it is not a question a slide can answer, because the edit was never
      // shown to anybody before the write began.
      join('app', 'composables', 'useRadioSession.ts') + ' writeToRadio load',
    ])
  })

  it('includes the paths that used to replace edits without a word', () => {
    // So the census cannot pass by finding nothing.
    const asked = all.filter((s) => s.asked).map((s) => s.where)
    for (const where of [
      join('app', 'components', 'OpenCodeplugButton.vue') + ' openInstead load',
      join('app', 'components', 'OpenCodeplugButton.vue') + ' applyToOpen replaceDocument',
      join('app', 'pages', 'backups.vue') + ' openBackup load',
      join('app', 'composables', 'useRadioSession.ts') + ' connectAndRead load',
      join('app', 'composables', 'useRadioSession.ts') + ' restoreToRadio load',
    ]) {
      expect(asked, where).toContain(where)
    }
  })
})

describe('opening a file', () => {
  const S = script(BUTTON)
  const T = template(BUTTON)

  it('holds the file for the question when the open would lose edits', () => {
    const fn = body(S, 'async function openInstead(')
    const guard = fn.indexOf('codeplug.canReplace(agreed)')
    expect(guard, 'openInstead no longer asks').toBeGreaterThan(-1)
    expect(fn.indexOf("held.value = { verb: 'open'")).toBeGreaterThan(guard)
    expect(guard).toBeLessThan(fn.indexOf('codeplug.load('))
  })

  it('asks before an apply that would replace an edit, and only then', () => {
    // The merge replaces whole lists and the history with them. An edit to
    // settings survives it, so the question is about the lists alone.
    const fn = body(S, 'async function applyToOpen(')
    const guard = fn.indexOf('applyDiscards.value.length > 0 && !codeplug.canReplace(agreed)')
    expect(guard, 'applyToOpen no longer asks').toBeGreaterThan(-1)
    expect(guard).toBeLessThan(fn.indexOf('codeplug.replaceDocument('))
    expect(S).toMatch(/editsReplaced\(driver\.decode\(image\), doc, result\)/)
  })

  it('sends both of the donor dialog’s verbs through those checks', () => {
    expect(T).toMatch(/@click="openInstead\(donor\.opened, donor\.driver\)"/)
    // A handler bound by reference is handed the click event, which would
    // arrive where the agreement goes.
    expect(T).toMatch(/@click="applyToOpen\(\)"/)
    expect(T).not.toMatch(/@click="(applyToOpen|openInstead)"/)
  })

  it('agrees to the edits on screen, and starts nothing else first', () => {
    const fn = body(S, 'function discardAndContinue(')
    expect(fn).toMatch(/const agreed = codeplug\.revision/)
    expect(fn).toMatch(/openInstead\(h\.opened, h\.driver, agreed\)/)
    expect(fn).toMatch(/applyToOpen\(agreed\)/)
  })

  it('asks in place of the donor dialog rather than on top of it', () => {
    expect(T).toMatch(/:open="donor !== null && held === null"/)
    const ask = T.slice(T.indexOf(':open="asking"'))
    expect(ask).toMatch(/<DiscardEdits[\s\S]*?@confirm="discardAndContinue"/)
    expect(S).toMatch(/label: 'Slide to discard edits and open'/)
    expect(S).toMatch(/label: 'Slide to discard edits and apply'/)
  })
})

describe('opening a backup', () => {
  it('asks before it replaces edits', () => {
    const fn = body(script(BACKUPS), 'async function openBackup(')
    const guard = fn.indexOf('codeplug.canReplace(agreed)')
    expect(guard, 'openBackup no longer asks').toBeGreaterThan(-1)
    expect(guard).toBeLessThan(fn.indexOf('codeplug.load('))
  })

  it('agrees only through the slide, to the edits on screen', () => {
    const T = template(BACKUPS)
    expect(T).toMatch(/@click="openBackup\(b\)"/)
    const ask = T.slice(T.indexOf('<DiscardEdits'))
    expect(ask).toMatch(/label="Slide to discard edits and open"/)
    expect(ask).toMatch(/@confirm="openBackup\(b, codeplug\.revision\)"/)
    // Every other call leaves the agreement out.
    const calls = [...T.matchAll(/openBackup\(([^)]*)\)/g)].map((m) => m[1])
    expect(calls.sort()).toEqual(['b', 'b, codeplug.revision'])
  })
})

describe('a restore', () => {
  it('names the editor’s loss on the slide that agrees to it', () => {
    expect(RESTORE).toMatch(/:label="discards \? 'Slide to discard edits and restore' : 'Slide to restore'"/)
    expect(RESTORE).toMatch(/const discards = computed\(\(\) => !codeplug\.canReplace\(\)\)/)
    expect(RESTORE).toMatch(/session\.downloadBwp\(\)/)
    expect(body(script(RESTORE), 'async function confirmRestore(')).toMatch(
      /restoreToRadio\(fromStoredBackup\(b\), \{ discarding: codeplug\.revision \}\)/,
    )
  })

  it('asks after the write, and keeps the editor rather than refusing the restore', () => {
    // The radio is what the slide was for. An edit nobody agreed to lose is
    // simply left open, and the restore still happens.
    const fn = body(SESSION, 'async function restoreToRadio(', '  ')
    const written = fn.indexOf('writeImage(')
    const asked = fn.indexOf('codeplug.canReplace(options.discarding ?? null)')
    expect(asked, 'restoreToRadio no longer asks').toBeGreaterThan(written)
    expect(fn).toMatch(/if \(!kept\) codeplug\.load\(/)
    expect(fn.indexOf('codeplug.canReplace(')).toBe(asked)
  })
})

describe('ending a fleet run', () => {
  it('records an edited master and what saving it needs', () => {
    expect(body(FLEET_SESSION, 'function startRun(', '  ')).toMatch(
      /codeplug\.dirty \? \{ image: codeplug\.encoded, generation: codeplug\.generation \} : null/,
    )
    expect(body(FLEET_SESSION, 'function masterOnlyHere(', '  ')).toMatch(
      /edits !== null && codeplug\.generation !== edits\.generation/,
    )
  })

  it('costs a slide when the master would go with it, written radios or not', () => {
    const S = script(FLEET_PAGE)
    const T = template(FLEET_PAGE)
    expect(S).toMatch(/master: run\.masterOnlyHere\(\)/)
    expect(S).toMatch(/!endLoses\.value\.record && !endLoses\.value\.master/)
    // The one-click end is offered only when nothing is lost.
    expect(T).toMatch(/v-if="endCostsNothing"[\s\S]{0,200}@click="finish"/)
    const panel = T.slice(T.indexOf('v-if="ending && !endCostsNothing"'))
    expect(panel).toMatch(/<ConfirmSlide[^>]*@confirm="finish"/)
    expect(panel).toMatch(/label="Save the master"[\s\S]{0,40}@click="run\.saveMaster\(\)"/)
    // Two calls to finish: the free button, and the slide.
    expect([...T.matchAll(/"finish"/g)]).toHaveLength(2)
  })
})

describe('the question', () => {
  it('names the verb it agrees to, wherever it is asked', () => {
    for (const [name, src] of [
      ['connect page', read('app/pages/index.vue')],
      ['fleet page', FLEET_PAGE],
      ['backups', BACKUPS],
    ] as const) {
      const labels = [...src.matchAll(/<DiscardEdits[\s\S]*?\slabel="([^"]+)"/g)].map((m) => m[1])
      expect(labels.length, `${name} has no question`).toBeGreaterThan(0)
      for (const l of labels) expect(l, name).toMatch(/^Slide to discard edits and \w+$/)
    }
  })
})

// SPDX-License-Identifier: GPL-3.0-or-later
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import { SCHEMAS } from '#core/radio/registry.js'

const require = createRequire(import.meta.url)
const root = fileURLToPath(new URL('../..', import.meta.url))

/**
 * With `icon.fallbackToApi: false` a name that is not in the client bundle
 * renders as nothing at all - no error, no placeholder, just a gap. And the
 * bundle scanner only sees icon names written as string literals in templates,
 * so any name that arrives as *data* (from a RadioSchema's FieldSpec.icon, say)
 * has to be declared explicitly in nuxt.config.
 *
 * These tests guard the two ways that goes wrong: a typo in a declared name,
 * and a name the scanner cannot see that nobody declared.
 */
describe('icon bundle coverage', () => {
  const config = readFileSync(new URL('../../nuxt.config.ts', import.meta.url), 'utf8')
  const declared = [...config.matchAll(/'(lucide:[a-z0-9-]+)'/g)].map((m) => m[1]!)

  const lucide = require('@iconify-json/lucide/icons.json') as {
    icons: Record<string, unknown>
    aliases?: Record<string, unknown>
  }

  it('declares a non-trivial set', () => {
    expect(declared.length).toBeGreaterThan(20)
  })

  it('every declared icon exists in @iconify-json/lucide', () => {
    const missing = declared.filter((name) => {
      const key = name.slice('lucide:'.length)
      return !(key in lucide.icons) && !(lucide.aliases && key in lucide.aliases)
    })
    expect(missing, `these icon names do not exist and would render blank: ${missing.join(', ')}`).toEqual([])
  })

  it('has no duplicates', () => {
    expect(declared.length).toBe(new Set(declared).size)
  })

  it('every icon a RadioSchema names is declared in nuxt.config', () => {
    // This is the case the bundle scanner cannot see. A FieldSpec's icon
    // arrives as data, not as a string literal in a template, so `scan: true`
    // never finds it and `fallbackToApi: false` renders it as a gap - on a
    // settings form where the gap looks like a missing control.
    const used = new Set<string>()
    for (const schema of Object.values(SCHEMAS)) {
      if (!schema) continue
      for (const f of schema.extraFields) if (f.icon) used.add(f.icon)
      for (const group of schema.settings) for (const f of group.fields) if (f.icon) used.add(f.icon)
    }
    expect(used.size, 'no schema declares an icon; this test would pass vacuously').toBeGreaterThan(3)

    const undeclared = [...used].filter((name) => !declared.includes(name))
    expect(
      undeclared,
      `these icons come from schema data, which the scanner cannot see, and are not in ` +
        `nuxt.config's SCHEMA_ICONS - they would render blank: ${undeclared.join(', ')}`,
    ).toEqual([])
  })

  it('every icon a RadioSchema names is spelled the way the config declares them', () => {
    // Two spellings work in a template (`i-lucide-x` and `lucide:x`) but only
    // one matches the config list, so a mixed convention silently defeats the
    // check above.
    const wrong: string[] = []
    for (const schema of Object.values(SCHEMAS)) {
      if (!schema) continue
      for (const f of schema.extraFields) if (f.icon?.startsWith('i-')) wrong.push(`${schema.id}: ${f.icon}`)
      for (const group of schema.settings) {
        for (const f of group.fields) if (f.icon?.startsWith('i-')) wrong.push(`${schema.id}: ${f.icon}`)
      }
    }
    expect(wrong, `schema icons must be written as 'lucide:name': ${wrong.join(', ')}`).toEqual([])
  })

  it('every i-lucide-* used in a template exists too', () => {
    // Statically written names are found by the scanner, but a typo still
    // renders blank, so they are worth checking all the same.
    // Every template under app/, found rather than listed. The list this
    // replaced named five files and went stale the moment one was deleted,
    // which is the wrong way round for a test whose job is catching drift.
    const used = new Set<string>()
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name)
        if (entry.isDirectory()) walk(full)
        else if (entry.name.endsWith('.vue')) {
          for (const m of readFileSync(full, 'utf8').matchAll(/i-lucide-([a-z0-9-]+)/g)) used.add(m[1]!)
        }
      }
    }
    walk(join(root, 'app'))
    expect(used.size).toBeGreaterThan(5)
    const missing = [...used].filter((k) => !(k in lucide.icons) && !(lucide.aliases && k in lucide.aliases))
    expect(missing, `unknown lucide icons referenced in templates: ${missing.join(', ')}`).toEqual([])
  })
})

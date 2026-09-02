// SPDX-License-Identifier: GPL-3.0-or-later
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Every source file we author carries an SPDX identifier.
 *
 * boofwang is GPLv3, and it borrows layout and protocol knowledge from GPL-3.0
 * (CHIRP), MIT (DM32-Protocol-Spec) and CC-BY-SA (SQ5BPF) sources. Per-file
 * identifiers are what keep that provenance legible to anyone who redistributes
 * the code, which the licence obliges them to be able to do.
 */

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const SPDX = 'SPDX-License-Identifier: GPL-3.0-or-later'
const ROOTS = ['lib', 'mobile', 'scripts', 'sw', 'test']
const EXTS = ['.ts', '.mjs', '.js']
// `android` and `ios` are the generated Capacitor projects under mobile/: no
// authored .ts lives there, and the web build is copied beneath them.
const SKIP_DIRS = new Set(['node_modules', '.nuxt', '.output', 'dist', 'reference', 'vendor', 'android', 'ios'])
const EXTRA_FILES = ['nuxt.config.ts', 'vitest.config.ts', 'eslint.config.mjs']

function* walk(dir) {
  let entries
  try {
    entries = readdirSync(dir)
  } catch {
    return
  }
  for (const name of entries) {
    if (SKIP_DIRS.has(name)) continue
    const full = join(dir, name)
    if (statSync(full).isDirectory()) yield* walk(full)
    else if (EXTS.some((e) => name.endsWith(e))) yield full
  }
}

const files = [...ROOTS.flatMap((r) => [...walk(join(ROOT, r))]), ...EXTRA_FILES.map((f) => join(ROOT, f))]

const missing = files.filter((f) => {
  // Only the head of the file counts, so a mention in prose does not pass.
  const head = readFileSync(f, 'utf8').slice(0, 400)
  return !head.includes(SPDX)
})

if (missing.length > 0) {
  console.error(`Missing "${SPDX}" in ${missing.length} file(s):`)
  for (const f of missing) console.error(`  ${relative(ROOT, f).split(sep).join('/')}`)
  console.error('\nAdd it as the first line, as a // comment.')
  process.exit(1)
}

console.log(`SPDX headers OK (${files.length} files)`)

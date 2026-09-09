// SPDX-License-Identifier: GPL-3.0-or-later
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * The commit-msg hook that refuses AI attribution.
 *
 * CLAUDE.md forbade the trailer from the start and seven commits carried it
 * anyway, so the rule is now enforced by scripts/hooks/commit-msg. This spec
 * runs the hook the way git does - a path to the message file, exit status
 * decides - so a change to its pattern is caught here rather than on the next
 * commit that slips through. It also checks the file is executable, because a
 * hook without the mode bit is silently skipped, which is the one failure
 * nobody would notice.
 */

const hook = fileURLToPath(new URL('../../scripts/hooks/commit-msg', import.meta.url))
const dir = mkdtempSync(join(tmpdir(), 'boofwang-hook-'))

function run(message: string): { status: number | null, stderr: string } {
  const file = join(dir, `msg-${Math.random().toString(36).slice(2)}`)
  writeFileSync(file, message)
  const r = spawnSync('bash', [hook, file], { encoding: 'utf8' })
  return { status: r.status, stderr: r.stderr }
}

describe('scripts/hooks/commit-msg', () => {
  it('is executable, or git would skip it without a word', () => {
    /*
     * The index mode, not the filesystem's. Windows has no executable bit for
     * node to read - `statSync().mode & 0o111` is 0 there for every file in
     * the tree - so asking the filesystem failed the Windows desktop build on
     * v0.1.6 while saying nothing about the hook. The bit that actually
     * decides whether git runs it is the one recorded in the index, which is
     * what a POSIX checkout restores, and git reports that identically
     * everywhere.
     */
    const root = fileURLToPath(new URL('../../', import.meta.url))
    const r = spawnSync('git', ['ls-files', '-s', '--', 'scripts/hooks/commit-msg'], { cwd: root, encoding: 'utf8' })
    expect(r.stdout).toMatch(/^100755 /)
  })

  it('lets an ordinary message through', () => {
    expect(run('Add the thing\n\nBecause it was missing.\n').status).toBe(0)
  })

  it('refuses a Co-Authored-By trailer that credits Claude', () => {
    const r = run('Add the thing\n\nBody.\n\nCo-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>\n')
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('Co-Authored-By')
    expect(r.stderr).toContain('CLAUDE.md')
  })

  it('refuses the Claude Code badge line', () => {
    expect(run('Add the thing\n\nGenerated with [Claude Code](https://claude.com/claude-code)\n').status).toBe(1)
  })

  it('leaves a human co-author alone', () => {
    expect(run('Add the thing\n\nCo-Authored-By: Dave Example <dave@example.com>\n').status).toBe(0)
  })

  it('ignores the word in prose and in git\'s own comment lines', () => {
    expect(run('Add the thing\n\nThis drops the Co-Authored-By trailer from CLAUDE.md.\n').status).toBe(0)
    expect(run('Add the thing\n\n# Co-Authored-By: Claude <x@y>\n').status).toBe(0)
  })
})

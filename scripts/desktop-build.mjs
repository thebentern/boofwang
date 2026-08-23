// SPDX-License-Identifier: GPL-3.0-or-later
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Package the desktop shell, signing it when there is anything to sign with.
 *
 * electron-builder takes its signing credentials from the environment, and does
 * different things depending on which are present. That branch has to live
 * somewhere: putting it in the YAML is impossible, and putting it in a shell
 * `if` in the workflow means it is invisible to anybody building locally. So it
 * is here, stated once, and both CI and `pnpm desktop:build` go through it.
 *
 * The rule is that a missing credential produces an unsigned build and says so.
 * It does not fail, and it does not quietly half-sign: an unsigned build is a
 * legitimate thing this project ships - every release so far has been one - and
 * a contributor without a certificate still needs to be able to package the app
 * to see whether it works.
 *
 *   macOS      CSC_LINK + CSC_KEY_PASSWORD           a Developer ID Application
 *              certificate as base64 .p12. Turns on the hardened runtime, which
 *              notarization requires and which does nothing without a signature.
 *
 *              APPLE_API_KEY + APPLE_API_KEY_ID      notarization, the App Store
 *              + APPLE_API_ISSUER                    Connect API key way.
 *              APPLE_API_KEY is a *path* to the .p8, not its contents - the
 *              workflow decodes a base64 secret to a file outside the
 *              workspace. Also accepts APPLE_ID + APPLE_APP_SPECIFIC_PASSWORD
 *              + APPLE_TEAM_ID.
 *
 *   Windows    CSC_LINK + CSC_KEY_PASSWORD           a .pfx, if the certificate
 *              is one that can live in a file. Most OV certificates issued since
 *              June 2023 cannot - they are on hardware tokens, which no CI
 *              runner can hold. See docs/signing.md for what to do instead.
 *
 * Notarization is deliberately separate from signing. A signed but un-notarized
 * macOS build still meets Gatekeeper's first-run dialogue; only notarization
 * removes it. Signing without notarizing is a real intermediate state and worth
 * being able to produce.
 */

const platform = process.argv[2] ?? null

const has = (...names) => names.every((n) => (process.env[n] ?? '').length > 0)

/*
 * An empty variable is worse than a missing one.
 *
 * A workflow that maps a secret which has not been set hands the step
 * `CSC_LINK=''` - defined, and empty. electron-builder reads the environment
 * itself and treats "defined" as "there is a certificate here", resolves the
 * empty path against the working directory and fails with
 * `/path/to/repo not a file`, having first announced that it would use an empty
 * password. Every other platform in the same run built fine, which made it look
 * like a macOS problem rather than an empty string.
 */
for (const name of [
  'CSC_LINK',
  'CSC_KEY_PASSWORD',
  'APPLE_API_KEY',
  'APPLE_API_KEY_ID',
  'APPLE_API_ISSUER',
  'APPLE_ID',
  'APPLE_APP_SPECIFIC_PASSWORD',
  'APPLE_TEAM_ID',
]) {
  if (name in process.env && process.env[name] === '') delete process.env[name]
}

const args = ['--config', 'electron-builder.yml', '--publish', 'never']
if (platform) args.unshift(platform)

const notes = []

if (process.platform === 'darwin') {
  if (has('CSC_LINK', 'CSC_KEY_PASSWORD')) {
    // Required for notarization, and inert without a signature - so it is set
    // here rather than in the YAML, where it would be on for unsigned builds
    // too and imply something that was not happening.
    args.push('-c.mac.hardenedRuntime=true')
    notes.push('signing macOS with the certificate in CSC_LINK')

    const apiKey = has('APPLE_API_KEY', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER')
    const appleId = has('APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID')
    if (apiKey || appleId) {
      args.push('-c.mac.notarize=true')
      notes.push(`notarizing with ${apiKey ? 'an App Store Connect API key' : 'an Apple ID'}`)
    } else {
      notes.push('not notarizing: no Apple credentials. Gatekeeper will still warn on first run.')
    }
  } else {
    // Otherwise electron-builder hunts the keychain, finds the expired
    // certificates that are on most developers' machines, and emits a wall of
    // warnings about identities it cannot use.
    process.env.CSC_IDENTITY_AUTO_DISCOVERY = 'false'
    notes.push('building macOS unsigned: no CSC_LINK. See docs/signing.md.')
  }
}

if (process.platform === 'win32' && !has('CSC_LINK', 'CSC_KEY_PASSWORD')) {
  process.env.CSC_IDENTITY_AUTO_DISCOVERY = 'false'
  notes.push('building Windows unsigned: no CSC_LINK. See docs/signing.md.')
}

for (const note of notes) console.log(`desktop-build: ${note}`)

/**
 * Find electron-builder without relying on PATH.
 *
 * A pnpm script gets `node_modules/.bin` on PATH; this file does not, because
 * CI runs it as `node scripts/desktop-build.mjs`. The first run on the three
 * platforms failed identically and only after doing everything else right -
 * "'electron-builder' is not recognized" on Windows, a bare exit 1 on the
 * others. Resolving it here means the script behaves the same however it is
 * invoked.
 */
function electronBuilder() {
  const bin = join(dirname(fileURLToPath(import.meta.url)), '..', 'node_modules', '.bin', 'electron-builder')
  const windows = process.platform === 'win32'
  const local = windows ? `${bin}.cmd` : bin
  return existsSync(local) ? local : 'electron-builder'
}

const command = electronBuilder()
console.log(`desktop-build: ${command} ${args.join(' ')}`)

// `shell` on Windows because .bin holds a .cmd, which CreateProcess will not
// run on its own.
const run = spawnSync(command, args, { stdio: 'inherit', shell: process.platform === 'win32' })
process.exit(run.status ?? 1)

// SPDX-License-Identifier: GPL-3.0-or-later
import { spawnSync } from 'node:child_process'

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

const run = spawnSync('electron-builder', args, { stdio: 'inherit', shell: process.platform === 'win32' })
process.exit(run.status ?? 1)

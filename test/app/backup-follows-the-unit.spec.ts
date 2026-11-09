// SPDX-License-Identifier: GPL-3.0-or-later
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * The backup a write is offered is chosen by unit, not only by firmware.
 *
 * A source check, because this composable is built on Nuxt auto-imports and
 * cannot be loaded by these DOM-less projects; the choice itself is
 * `chooseBackup` in lib/storage and is tested there on real bytes. What has to
 * hold here is that the composable goes through it. The newest backup with a
 * matching identify hash was the whole of the old choice, and on a radio that
 * fingerprints it offers a second identical radio's backup, or a backup stored
 * before the fingerprint existed with no fingerprint on it - both of which the
 * driver refuses, after the slide.
 */
const SOURCE = readFileSync(
  fileURLToPath(new URL('../../app/composables/useRadioSession.ts', import.meta.url)),
  'utf8',
)

describe('the backup offered for a write', () => {
  it('is chosen by chooseBackup, against the open codeplug\'s own fingerprint', () => {
    const start = SOURCE.indexOf('async function latestBackupForOpenCodeplug')
    expect(start, 'latestBackupForOpenCodeplug is no longer declared').toBeGreaterThan(-1)
    const body = SOURCE.slice(start, SOURCE.indexOf('\n  }\n', start))
    expect(body).toContain('chooseBackup(')
    expect(body).toMatch(/unit: .*unitFingerprint\(image\)/)
    // The fingerprint handed on is the chosen one, computed where the backup
    // was stored without one, and not the stored field read back as-is.
    expect(body).toContain('unitHash: chosen.unitHash')
  })
})

// SPDX-License-Identifier: GPL-3.0-or-later
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * A read must persist its backup before it opens the codeplug.
 *
 * This is a source-order check rather than a behavioural one, and deliberately
 * so: there is no Vue or Pinia harness in this suite, and the defect it guards
 * is precisely that two statements were the wrong way round.
 *
 * Opening the codeplug is what tells the rest of the app that a radio has been
 * read. The status bar answers "is there a way back" the moment it hears that,
 * and it does not ask again. With the load first, every read finished with a
 * toast saying a backup had been saved sitting next to a status bar telling the
 * user to read the radio to get one - on the one indicator the whole safety
 * story rests on.
 */
const SOURCE = readFileSync(
  fileURLToPath(new URL('../../app/composables/useRadioSession.ts', import.meta.url)),
  'utf8',
)

describe('reading a radio', () => {
  it('saves the backup before the codeplug is opened', () => {
    const read = SOURCE.slice(SOURCE.indexOf('async function connectAndRead'))
    const body = read.slice(0, read.indexOf('\n  async function ', 1) + 1 || undefined)

    const put = body.indexOf('db.putBackup(')
    const load = body.indexOf('codeplug.load(')

    expect(put, 'connectAndRead no longer calls db.putBackup').toBeGreaterThan(-1)
    expect(load, 'connectAndRead no longer calls codeplug.load').toBeGreaterThan(-1)
    expect(put, 'db.putBackup must come before codeplug.load').toBeLessThan(load)
  })

  it('takes the unit fingerprint while the radio is still connected', () => {
    // unitFingerprint goes through currentDriver(), which throws once the
    // session disconnects in the finally block.
    const read = SOURCE.slice(SOURCE.indexOf('async function connectAndRead'))
    const fingerprint = read.indexOf('unitFingerprint(')
    const disconnect = read.indexOf('device.disconnect()')
    expect(fingerprint).toBeGreaterThan(-1)
    if (disconnect > -1) expect(fingerprint).toBeLessThan(disconnect)
  })
})

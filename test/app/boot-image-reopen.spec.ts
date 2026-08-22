// SPDX-License-Identifier: GPL-3.0-or-later
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * The startup-picture flow must close the port after every operation.
 *
 * The DM-32UV has no command for leaving programming mode. The specification's
 * state machine says it leaves on "close port (DTR reset)", and that was
 * measured rather than taken on trust: retrying on the same open port never
 * recovered, however long it waited. A read that stayed connected therefore
 * left the radio in programming mode, V-frames stopped answering, and the next
 * write timed out with nothing buffered on a perfectly good cable until it was
 * pulled. That is the bug somebody hit, and the unplug was their only way out.
 *
 * A source check, deliberately: there is no Nuxt or Pinia harness in this
 * suite, and what is being guarded is the shape of the session - one port per
 * operation, released on the way out, the settle honoured on the way back in.
 */
const SOURCE = readFileSync(
  fileURLToPath(new URL('../../app/composables/useBootImage.ts', import.meta.url)),
  'utf8',
)

function body(name: string): string {
  const at = SOURCE.indexOf(`async function ${name}`)
  expect(at, `${name} is defined`).toBeGreaterThanOrEqual(0)
  return SOURCE.slice(at, SOURCE.indexOf('\n  }\n', at) + 4)
}

describe('the startup-picture session', () => {
  it('releases the port when an operation finishes, whether or not it worked', () => {
    // In the finally, so a failed read cannot leave the radio stranded either.
    const w = body('withRadio')
    const fin = w.slice(w.lastIndexOf('finally'))
    expect(fin).toContain('device.disconnect()')
  })

  it('remembers that it closed, so the next connect knows to wait', () => {
    const w = body('withRadio')
    const fin = w.slice(w.lastIndexOf('finally'))
    expect(fin).toContain('closedAt = Date.now()')
  })

  it('waits out the radio on a reconnect that follows its own close', () => {
    // REOPEN_SETTLE_MS is the measured figure, and the gap is taken from the
    // protocol module rather than typed here so the two cannot drift apart.
    const e = body('ensureConnected')
    expect(e).toContain('REOPEN_SETTLE_MS')
    expect(e).toMatch(/closedAt !== null/)
    expect(e).toMatch(/Date\.now\(\) - closedAt/)
  })

  it('does not wait on a cold first connection', () => {
    // Nothing to settle when we have not closed anything; making a first-time
    // user sit through three seconds would be pointless.
    const e = body('ensureConnected')
    const guard = e.indexOf('closedAt !== null')
    const wait = e.indexOf('REOPEN_SETTLE_MS')
    expect(guard).toBeGreaterThanOrEqual(0)
    expect(guard).toBeLessThan(wait)
  })

  it('still short-circuits when a connection is already live', () => {
    // The first thing checked. A live connection - from the codeplug read that
    // got someone here - is reused rather than torn down and rebuilt.
    const e = body('ensureConnected')
    expect(e.indexOf('if (device.connected) return true')).toBeLessThan(e.indexOf('closedAt !== null'))
  })
})

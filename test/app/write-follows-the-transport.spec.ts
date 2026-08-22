// SPDX-License-Identifier: GPL-3.0-or-later
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * A write reconnects over the carrier the session was already using.
 *
 * `lib/` has known about Bluetooth for a while: `SerialPortLike.kind` reaches
 * the driver, and the UV-5R Mini's `writeImage` uses it to pick the 0x80 upload
 * block a BLE link takes instead of the cable's 0x40. None of that was
 * reachable, because the app layer's reconnect called the serial chooser outright.
 *
 * The effect was not a refusal - nothing declined to write over Bluetooth - but
 * a cable dialogue put in front of someone holding a radio that has no cable
 * attached, with a toast about serial ports. And it fired every time rather
 * than occasionally: reading closes the port when it finishes, so there is
 * never a live link by the time an edit has been made.
 *
 * A source check, deliberately: this composable is built on Nuxt auto-imports
 * and cannot be loaded by these DOM-less projects, and what has to hold is
 * which chooser each path reaches for.
 */
const SESSION = readFileSync(
  fileURLToPath(new URL('../../app/composables/useRadioSession.ts', import.meta.url)),
  'utf8',
)
const DEVICE = readFileSync(fileURLToPath(new URL('../../app/stores/device.ts', import.meta.url)), 'utf8')

/** The screens that send bytes, as the reader sees them: template only. */
const SCREENS = ['pages/write.vue', 'pages/restore.vue', 'components/WriteToRadioDialog.vue'].map((name) => ({
  name,
  template: readFileSync(fileURLToPath(new URL(`../../app/${name}`, import.meta.url)), 'utf8').split('</script>').pop()!,
}))

/** One top-level function's body, by name. */
function body(source: string, name: string): string {
  const start = source.indexOf(`function ${name}(`)
  if (start === -1) throw new Error(`${name} is no longer declared`)
  const rest = source.slice(start)
  const next = rest.slice(1).search(/\n {2}(?:async )?function \w+\(|\n {2}\/\*\*/)
  return next === -1 ? rest : rest.slice(0, next + 1)
}

describe('the paths that reconnect', () => {
  it('finds the functions it is meant to check', () => {
    for (const name of ['writeToRadio', 'restoreToRadio', 'acquireLike']) {
      expect(() => body(SESSION, name), name).not.toThrow()
    }
  })

  it('never reach for the serial chooser by name', () => {
    // `acquireLike` is the one place allowed to name a chooser, because
    // choosing between them is the whole of what it does.
    for (const name of ['writeToRadio', 'restoreToRadio']) {
      expect(body(SESSION, name), `${name} opens the serial chooser regardless of carrier`).not.toMatch(
        /acquirePort|requestPort/,
      )
    }
  })

  it('ask for a port over the carrier the session last used', () => {
    for (const name of ['writeToRadio', 'restoreToRadio']) {
      expect(body(SESSION, name), `${name} does not consult the transport`).toMatch(/acquireLike\(/)
      expect(body(SESSION, name), `${name} does not read the last carrier`).toMatch(/device\.lastKind/)
    }
  })

  it('try the granted Bluetooth device before raising a second chooser', () => {
    // `requestDevice` needs transient user activation and shows a dialogue for
    // a radio the user has already picked once. `gatt.connect()` on a granted
    // device needs neither.
    const chooser = body(SESSION, 'acquireLike')
    expect(chooser).toMatch(/reconnectBluetoothRadio\(\)/)
    expect(chooser.indexOf('reconnectBluetoothRadio')).toBeLessThan(chooser.indexOf('requestBluetoothRadio'))
  })
})

describe('the carrier outlives the connection', () => {
  it('is recorded when a port is opened', () => {
    expect(DEVICE).toMatch(/lastKind\.value = chosen\.kind \?\? 'serial'/)
  })

  it('is not cleared by disconnect', () => {
    // This is the entire point of the field: it is read when nothing is
    // connected. Tidying it away in `disconnect` alongside `ident` would send
    // every Bluetooth write back to the serial chooser, and nothing else would
    // look wrong.
    expect(body(DEVICE, 'disconnect')).not.toMatch(/lastKind/)
  })
})

describe('what the screens tell the user to keep connected', () => {
  it('never names a cable, which half the transports do not have', () => {
    // The advice itself is worth keeping - a knocked-out plug and a radio
    // carried out of range are both real - so this is not a demand for neutral
    // wording. It is a demand that the wording come from `keepLinkUp`, which
    // knows which of the two is in use.
    for (const screen of SCREENS) {
      expect(screen.template, `${screen.name} tells a Bluetooth user to check a cable`).not.toMatch(/cable/i)
      expect(screen.template, `${screen.name} does not take its wording from the transport`).toMatch(
        /device\.keepLinkUp/,
      )
    }
  })

  it('is one phrase in one place', () => {
    // Three screens each carrying their own wording is how one of them is
    // still talking about cables a year from now.
    expect(DEVICE).toMatch(/in range/)
    expect(DEVICE).toMatch(/cable connected/)
  })
})

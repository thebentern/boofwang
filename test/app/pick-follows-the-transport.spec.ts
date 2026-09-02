// SPDX-License-Identifier: GPL-3.0-or-later
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * Asking for a port must go through `acquirePort`, like every other acquisition.
 *
 * `acquirePort` is the one place that knows the order - the dev bridge, then
 * the shell's native cable, then the browser's chooser - and `requestPort` is
 * only the last of those three. The connect page's primary button called
 * `requestPort` directly, so inside the Android app, where there is no
 * `navigator.serial` for it to reach, "Connect a radio" threw a TypeError that
 * the page then reported as a chooser that would not open. `serialAvailable()`
 * did not stop it: it answers for the native plugin before it looks at the
 * navigator at all.
 *
 * Nothing about the read path was wrong. `grantedPorts` already routed
 * natively, so a phone that had been granted an adapter could read a radio and
 * could not be asked for one - which is the shape of failure that survives a
 * casual test.
 */

const root = new URL('../../', import.meta.url)
const read = (path: string) => readFileSync(fileURLToPath(new URL(path, root)), 'utf8')

const page = read('app/pages/index.vue')
const fault = read('app/components/connect/LinkFault.vue')
const serial = read('app/composables/useWebSerial.ts')
const mobile = read('app/mobile/serial.ts')

const appFiles = (dir: string): string[] =>
  readdirSync(fileURLToPath(new URL(dir, root)), { withFileTypes: true }).flatMap((d) =>
    d.isDirectory() ? appFiles(`${dir}${d.name}/`) : /\.(ts|vue)$/.test(d.name) ? [`${dir}${d.name}`] : [],
  )

/**
 * A call, not a mention. Four files name `requestPort` in prose - it is the
 * canonical example of a call needing transient activation - and the rule is
 * about who invokes it, so the pattern wants the parenthesis and has to refuse
 * a backticked `requestPort()` inside a comment.
 */
const CALLS_REQUEST_PORT = /(?<![\w.`])requestPort\s*\(/

describe('every request for a port', () => {
  it('is routed through acquirePort, outside useWebSerial itself', () => {
    const offenders = appFiles('app/').filter(
      (f) => f !== 'app/composables/useWebSerial.ts' && CALLS_REQUEST_PORT.test(read(f)),
    )
    expect(offenders).toEqual([])
  })

  it('reaches the browser chooser last of the three routes', () => {
    const fn = serial.slice(serial.indexOf('export async function acquirePort'))
    const order = ['bridgeEnabled()', 'nativeSerial()', 'return requestPort()']
    let at = -1
    for (const step of order) {
      const next = fn.indexOf(step)
      expect(next).toBeGreaterThan(at)
      at = next
    }
  })
})

describe('the connect page', () => {
  it('picks through acquirePort', () => {
    const fn = page.slice(page.indexOf('async function pickPort'))
    expect(fn.slice(0, 500)).toContain('await acquirePort()')
  })

  it('asks for the capability rather than for the shell', () => {
    // An iPhone is in a shell too and has no USB host at all. It stays on the
    // browser path here, fails there for a different reason, and its advice is
    // a different sentence - so `inShell` is the wrong question.
    expect(page).toContain("hostSupports(useShell().host, ['nativeSerial'])")
    expect(page).not.toMatch(/shellPicksPort\s*=\s*inShell/)
  })

  it('does not blame an empty chooser when the shell did the picking', () => {
    // Reusing that card would tell someone to reseat a cable the app can
    // plainly see, because on the native path a null is a declined prompt.
    expect(page).toContain("if (!choice && !hasPort.value && !shellPicksPort) fault.value = 'empty'")
  })

  it('does not name a chooser in the failure the shell raises', () => {
    expect(page).toMatch(
      /shellPicksPort \? 'Could not open a serial port' : 'Could not open the port chooser'/,
    )
  })

  it('tells the fault card which dialogue is up', () => {
    expect(page).toContain(':shell-picks-port="shellPicksPort"')
  })
})

describe('the picking card', () => {
  const BROWSER_CLAIM = 'We cannot style that list'

  it('keeps the browser copy for the browser', () => {
    expect(fault).toContain(BROWSER_CLAIM)
  })

  it('has a version for the app, where there is no list to be shown', () => {
    expect(fault).toContain('const PICKING_IN_APP')
    expect(fault).toMatch(/props\.state === 'picking' && props\.shellPicksPort/)
  })

  it('never claims a list it cannot see, in the one place it owns the list', () => {
    const inApp = fault.slice(fault.indexOf('const PICKING_IN_APP'), fault.indexOf('const copy = computed'))
    expect(inApp).not.toContain(BROWSER_CLAIM)
    expect(inApp).toContain('There is no list to choose from')
    // The four USB-serial chip ids are guidance for finding your cable in a
    // chooser. In the app they would be a table for a list nobody opens.
    expect(inApp).not.toContain('staticLog')
  })
})

describe('the native pick', () => {
  it('throws for no adapter and returns null only for a declined prompt', () => {
    // What the page's empty-chooser branch rests on. The browser folds both
    // outcomes into one silent null and cannot tell them apart; this one can,
    // so the two cases must not share a card.
    const fn = mobile.slice(mobile.indexOf('export async function requestNativePort'))
    expect(fn).toMatch(/devices\.length === 0[\s\S]{0,160}throw new Error/)
    expect(fn).toContain('if (!granted) return null')
  })
})

// SPDX-License-Identifier: GPL-3.0-or-later
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * A failed Bluetooth attempt must always leave a way back to the cable.
 *
 * Bluetooth is the newer and less certain of the two routes: the service number
 * it looks for is a guess on most radios. Someone whose radio will not pair
 * needs the cable one click away, and before this the Bluetooth faults offered
 * only their own retry - so the screen's answer to "it did not work" was to
 * suggest doing it again.
 */
const fault = readFileSync(
  fileURLToPath(new URL('../../app/components/connect/LinkFault.vue', import.meta.url)),
  'utf8',
)
const page = readFileSync(fileURLToPath(new URL('../../app/pages/index.vue', import.meta.url)), 'utf8')

describe('a stranded Bluetooth attempt', () => {
  it('is offered the cable from any settled state', () => {
    // The rule is carrier-based rather than listed per state, because a
    // Bluetooth read that times out lands in the shared `off` state.
    expect(fault).toMatch(/via\.value === 'bluetooth'/)
    expect(fault).toContain('USE_CABLE')
  })

  it('is not offered it mid-attempt', () => {
    expect(fault).toMatch(/IN_PROGRESS[\s\S]{0,160}'picking'[\s\S]{0,60}'reading'[\s\S]{0,60}'ble-picking'/)
    expect(fault).toContain("!IN_PROGRESS.includes(props.state)")
  })

  it('never offers the cable twice', () => {
    expect(fault).toContain("listed.some((a) => a.key === 'cable')")
  })

  it('has a handler that actually goes back to the cable', () => {
    expect(page).toContain("key === 'cable'")
    expect(page).toContain('useCableInstead')
  })

  it('clears the Bluetooth failure before asking about a cable', () => {
    // Otherwise the card keeps explaining a Bluetooth problem while the native
    // port chooser is open in front of it.
    const fn = page.slice(page.indexOf('async function useCableInstead'))
    expect(fn.slice(0, 260)).toContain('device.error = null')
    expect(fn.slice(0, 260)).toContain('blePicking.value = false')
  })
})

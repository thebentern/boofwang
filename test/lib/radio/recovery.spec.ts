// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest'
import { recoveryAdvice } from '#core/radio/recovery.js'
import {
  DesyncedError,
  DeviceDisconnectedError,
  ProtocolError,
  TransportTimeoutError,
} from '#core/transport/errors.js'

const stranded = { abortPolicy: 'power-cycle' as const }
const resettable = { abortPolicy: 'reset-command' as const }

describe('recoveryAdvice', () => {
  it('tells a stranded radio to have its cable pulled', () => {
    // The DM-32UV and the UV-5R Mini have no command for leaving programming
    // mode, so the cable is the only thing that resets them.
    const advice = recoveryAdvice(new DesyncedError('write'), stranded)!
    expect(advice).toMatch(/unplug the cable/i)
    expect(advice).toMatch(/no command for leaving programming mode/i)
  })

  it('prefers pulling the cable to reloading the page', () => {
    // A reload clears the line too, but discards the open codeplug with it -
    // a bad trade for someone whose radio is fine and whose line is confused.
    const advice = recoveryAdvice(new DesyncedError('write'), stranded)!
    expect(advice.indexOf('Unplug')).toBeLessThan(advice.indexOf('Reloading'))
    expect(advice).toMatch(/discards the codeplug you have open/i)
  })

  it('asks a UV-K5 only to read again, since it has a reset command', () => {
    const advice = recoveryAdvice(new DesyncedError('read'), resettable)!
    expect(advice).toMatch(/read the radio again/i)
    expect(advice).not.toMatch(/no command for leaving/i)
  })

  it('says something useful about a timeout and a disconnect', () => {
    const timeout = new TransportTimeoutError('read 3 byte(s)', 3000, '(nothing)', 0)
    // Silence on a stranded radio usually means it is still in programming
    // mode from an earlier attempt, which reads like a dead cable and is not.
    expect(recoveryAdvice(timeout, stranded)).toMatch(/still\s+in programming mode/i)
    expect(recoveryAdvice(timeout, stranded)).toMatch(/unplug the cable/i)
    expect(recoveryAdvice(timeout, resettable)).toMatch(/switched on/i)
    expect(recoveryAdvice(new DeviceDisconnectedError(), stranded)).toMatch(/plug it back in/i)
  })

  it('stays quiet about errors it has no advice for', () => {
    // A protocol error is a boofwang problem, not something the user can fix by
    // touching the cable, and inventing advice for it would waste the one line
    // that gets read.
    expect(recoveryAdvice(new ProtocolError('Bad V-frame'), stranded)).toBeNull()
    expect(recoveryAdvice(new Error('something else'), stranded)).toBeNull()
  })

  it('still advises when the driver is gone', () => {
    // Error handling runs after a disconnect, so a null driver is normal and
    // must not become a second failure.
    expect(recoveryAdvice(new DesyncedError('write'), null)).toMatch(/unplug the cable/i)
  })
})

// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest'
import { createUvk5Driver, decodeChannel } from '#core/radios/uvk5/driver.js'
import { txFrequency, chirpMode, type Channel } from '#core/model/channel.js'
import { CHIRP_ATTRS, CHIRP_CHANNELS, buildEeprom, imageFrom } from './fixture.js'

const driver = createUvk5Driver()

function decodeOne(record: string, extra: { name?: string; attr?: number } = {}): Channel {
  const mem = buildEeprom([{ slot: 0, record, ...extra }])
  const ch = decodeChannel(mem, 0)
  expect(ch, 'fixture should decode to a channel').not.toBeNull()
  return ch!
}

describe('decoding records CHIRP itself encoded', () => {
  it('reads a plain simplex channel', () => {
    const ch = decodeOne(CHIRP_CHANNELS.SIMPLEX, { name: 'CALLING', attr: CHIRP_ATTRS.SL1_BAND2 })
    expect(ch.rxFreq).toBe(146_520_000)
    expect(ch.name).toBe('CALLING')
    expect(ch.tx).toEqual({ kind: 'simplex' })
    expect(ch.txAllowed).toBe(true)
    expect(ch.tone).toEqual({ rx: null, tx: null, rxInverted: false })
    expect(ch.modulation).toBe('FM')
    expect(ch.bandwidthHz).toBe(25_000)
    expect(ch.power).toMatchObject({ mW: 5000, label: 'High' })
    expect(ch.tuningStep).toBe(5_000)
    expect(chirpMode(ch)).toBe('FM')
    expect(txFrequency(ch)).toBe(146_520_000)
  })

  it('reads a repeater channel with a mixed tone pair', () => {
    const ch = decodeOne(CHIRP_CHANNELS.REPEATER, { name: 'W4ABC', attr: CHIRP_ATTRS.SL1_BAND2 })
    expect(ch.rxFreq).toBe(146_940_000)
    expect(ch.tx).toEqual({ kind: 'offset', direction: 'minus', offset: 600_000 })
    expect(txFrequency(ch)).toBe(146_340_000)
    // TX carries CTCSS 88.5 while RX requires DTCS 023 - the case CHIRP has to
    // spell out as a Cross mode across four separate columns.
    expect(ch.tone.tx).toEqual({ kind: 'ctcss', deciHz: 885 })
    expect(ch.tone.rx).toEqual({ kind: 'dtcs', code: 23, polarity: 'N' })
    expect(ch.bandwidthHz).toBe(12_500)
    expect(chirpMode(ch)).toBe('NFM')
    expect(ch.power.label).toBe('Med')
    expect(ch.extras.uvk5?.scanList1).toBe(true)
  })

  it('reads a UHF channel with a plus shift and matching tones', () => {
    const ch = decodeOne(CHIRP_CHANNELS.UHF_PLUS)
    expect(ch.rxFreq).toBe(442_100_000)
    expect(ch.tx).toEqual({ kind: 'offset', direction: 'plus', offset: 5_000_000 })
    expect(txFrequency(ch)).toBe(447_100_000)
    expect(ch.tone.rx).toEqual({ kind: 'ctcss', deciHz: 1000 })
    expect(ch.tone.tx).toEqual({ kind: 'ctcss', deciHz: 1000 })
    expect(ch.tuningStep).toBe(12_500)
  })

  it('recognises CHIRP’s transmit-disable encoding', () => {
    // The UV-K5 has no TX-inhibit bit. CHIRP parks transmit at 0 MHz using a
    // minus shift whose offset equals the receive frequency. Failing to notice
    // that would turn a NOAA weather channel into a transmit-capable one.
    const ch = decodeOne(CHIRP_CHANNELS.TX_DISABLED, { name: 'WX3' })
    expect(ch.rxFreq).toBe(162_550_000)
    expect(ch.txAllowed).toBe(false)
    expect(ch.txInhibitReason).toMatch(/0 MHz/)
    expect(txFrequency(ch)).toBeNull()
    // The offset is consumed by the inhibit encoding, so no shift is reported.
    expect(ch.tx).toEqual({ kind: 'simplex' })
  })

  it('reads an AM air-band channel', () => {
    const ch = decodeOne(CHIRP_CHANNELS.AIR_AM, { name: 'GUARD' })
    expect(ch.rxFreq).toBe(121_500_000)
    expect(ch.modulation).toBe('AM')
    expect(ch.bandwidthHz).toBe(25_000)
    expect(chirpMode(ch)).toBe('AM')
    expect(ch.power.label).toBe('Low')
  })

  it('distinguishes an inverted DTCS code from a normal one', () => {
    const ch = decodeOne(CHIRP_CHANNELS.DTCS_R)
    expect(ch.tone.tx).toEqual({ kind: 'dtcs', code: 31, polarity: 'R' })
    expect(ch.tone.rx).toBeNull()
  })

  it('reads every radio-specific extra', () => {
    const ch = decodeOne(CHIRP_CHANNELS.EXTRAS, { attr: CHIRP_ATTRS.SL2_COMP3_BAND5 })
    expect(ch.extras.uvk5).toEqual({
      scanList1: false,
      scanList2: true,
      compander: 3,
      scrambler: 10,
      busyChannelLockout: true,
      freqReverse: true,
      dtmfDecode: true,
      dtmfPttId: 3,
      band: 5,
      stepIndex: 5,
    })
    expect(ch.tuningStep).toBe(25_000)
  })
})

describe('empty slots', () => {
  it('treats an erased 0xFF record as empty', () => {
    const mem = buildEeprom([])
    expect(decodeChannel(mem, 0)).toBeNull()
    expect(decodeChannel(mem, 199)).toBeNull()
  })

  it('treats a zero frequency as empty, as CHIRP does', () => {
    const mem = buildEeprom([{ slot: 0, record: '00'.repeat(16) }])
    expect(decodeChannel(mem, 0)).toBeNull()
  })
})

describe('driver.decode over a whole image', () => {
  const mem = buildEeprom([
    { slot: 0, record: CHIRP_CHANNELS.SIMPLEX, name: 'CALLING', attr: CHIRP_ATTRS.SL1_BAND2 },
    { slot: 1, record: CHIRP_CHANNELS.REPEATER, name: 'W4ABC', attr: CHIRP_ATTRS.SL1_BAND2 },
    { slot: 4, record: CHIRP_CHANNELS.TX_DISABLED, name: 'WX3', attr: CHIRP_ATTRS.NONE_BAND2 },
    // A VFO pseudo-channel: zero-based 200, which the radio shows as F1(50M-76M)A.
    { slot: 200, record: CHIRP_CHANNELS.SIMPLEX },
  ])
  const cp = driver.decode(imageFrom(mem))

  it('keeps memory slots sparse and 1-based', () => {
    expect([...cp.channels.keys()].sort((a, b) => a - b)).toEqual([1, 2, 5, 201])
    expect(cp.channels.get(1)!.name).toBe('CALLING')
    expect(cp.channels.get(5)!.name).toBe('WX3')
  })

  it('names the VFO pseudo-channels from the radio’s own labels', () => {
    // Slots past 200 have no name storage at 0x0F50 at all, so reading one
    // would run off the end of the name table into the DTMF contacts.
    expect(cp.channels.get(201)!.name).toBe('F1(50M-76M)A')
  })

  it('records the firmware it came from', () => {
    expect(cp.meta.variant).toBe('k5_2.01.26')
    expect(cp.radio).toBe('uvk5')
  })

  it('rejects an image from a different radio', () => {
    const foreign = { ...imageFrom(mem), radioId: 'dm32uv' as const }
    expect(() => driver.decode(foreign)).toThrow(/Not a UV-K5 image/)
  })
})

describe('validate', () => {
  it('flags a frequency outside every band the radio covers', () => {
    const mem = buildEeprom([{ slot: 0, record: CHIRP_CHANNELS.SIMPLEX }])
    const cp = driver.decode(imageFrom(mem))
    const ch = cp.channels.get(1)!
    cp.channels.set(1, { ...ch, rxFreq: 900_000_000 as typeof ch.rxFreq })
    const diags = driver.validate(cp)
    expect(diags.map((d) => d.ruleId)).toContain('radio.band.rx-out-of-range')
  })

  it('is quiet for a valid codeplug', () => {
    const mem = buildEeprom([{ slot: 0, record: CHIRP_CHANNELS.SIMPLEX, name: 'CALLING' }])
    expect(driver.validate(driver.decode(imageFrom(mem)))).toEqual([])
  })
})

describe('ownedRanges', () => {
  it('claims the channel, attribute and name tables', () => {
    expect(driver.ownedRanges(0x0000)).toEqual([
      [0x0000, 0x0d60],
      [0x0d60, 0x0e28],
      [0x0f50, 0x1bd0],
    ])
  })

  it('claims nothing in the calibration region, which is what makes it unwritable', () => {
    expect(driver.ownedRanges(0x1d00)).toEqual([])
  })
})

describe('write path', () => {
  it('is absent, and says so, rather than half-working', () => {
    const mem = buildEeprom([{ slot: 0, record: CHIRP_CHANNELS.SIMPLEX }])
    const image = imageFrom(mem)
    expect(() => driver.encode(driver.decode(image), image)).toThrow(/not supported/)
  })

  it('reports the radio as read-only in its schema', () => {
    expect(driver.schema.capabilities.write).toBe(false)
    expect(driver.schema.capabilities.read).toBe(true)
  })
})

// SPDX-License-Identifier: GPL-3.0-or-later
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { equalBytes, rangesContain } from '#core/codec/struct.js'
import { chirpMode, txFrequency } from '#core/model/channel.js'
import { UnsupportedFirmwareError } from '#core/radio/driver.js'
import type { RadioImage } from '#core/radio/image.js'
import { createUvk5Driver } from '#core/radios/uvk5/driver.js'
import {
  EGZUMER_ATTR_COUNT,
  EGZUMER_CAL_START,
  EGZUMER_REGIONS,
  EGZUMER_STEPS_HZ,
  egzumerBands,
  egzumerVfoChannelNames,
} from '#core/radios/uvk5/egzumer-layout.js'
import { ATTR_BASE, NAMED_CHANNEL_COUNT } from '#core/radios/uvk5/layout.js'
import { readBuildOptions } from '#core/radios/uvk5/egzumer.js'
import { MEM_SIZE, buildFrame, xorArray } from '#core/radios/uvk5/protocol.js'
import { classifyFirmware, variantsCompatible } from '#core/radios/uvk5/variants.js'
import { FakeSerialPort } from '#core/transport/fake-serial-port.js'
import { SerialTransport } from '#core/transport/serial-transport.js'

/**
 * The egzumer layout, checked against CHIRP's own egzumer driver.
 *
 * **There is no hardware capture of this firmware.** Nobody working on
 * boofwang has a radio running it, and this file does not pretend otherwise.
 * `uvk5-egzumer-synthetic.bin` is exactly what its name says: an image built by
 * `scripts/gen-egzumer-fixture.py`, every byte of it written by CHIRP's
 * `uvk5_egzumer` driver through CHIRP's `bitwise` engine. The JSON beside it is
 * what that same driver reads back out of those bytes.
 *
 * What that proves is worth being precise about. It proves boofwang's offsets,
 * bit order, step table, band nibble and mode derivation agree with the
 * reference implementation, which is the thing that goes wrong when a driver is
 * ported by hand - and neither side of the comparison was written by boofwang.
 * It does not prove the reference is right about the radio. Only a radio can do
 * that, which is why writing is still refused; see docs/protocols/uvk5.md.
 */

const RAW = new Uint8Array(
  readFileSync(fileURLToPath(new URL('../../../fixtures/images/uvk5-egzumer-synthetic.bin', import.meta.url))),
)

interface ChirpTone {
  kind: string
  deciHz?: number
  code?: number
  polarity?: string
}

interface ChirpChannel {
  name: string
  freq: number
  offset: number
  duplex: string
  mode: string
  tuningStepHz: number
  power: string | null
  txtone: ChirpTone | null
  rxtone: ChirpTone | null
  raw: Record<string, number>
  attr?: Record<string, number>
}

interface ChirpDump {
  vfoChannelNames: string[]
  bands: [number, number][]
  steps: number[]
  buildOptions: Record<string, number>
  fmPresets: number[]
  settings: Record<string, number | string>
  channels: Record<string, ChirpChannel>
  specials: Record<string, number>
}

const CHIRP = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../../fixtures/uvk5-egzumer-chirp-decode.json', import.meta.url)), 'utf8'),
) as ChirpDump

const FIRMWARE = 'EGZUMER v0.22'

function image(mem: Uint8Array = RAW): RadioImage {
  return {
    radioId: 'uvk5',
    variant: FIRMWARE,
    layout: 'egzumer',
    createdAt: '2026-08-21T00:00:00.000Z',
    regions: EGZUMER_REGIONS.map((r) => ({
      start: r.start,
      data: mem.slice(r.start, r.start + r.length),
      readOnly: r.readOnly,
      label: r.label,
    })),
    meta: {},
    sha256: '',
  }
}

const driver = createUvk5Driver()
const writable = createUvk5Driver({ enableWrite: true })

describe('the variant', () => {
  it('is recognised by its hello prefix and moves the calibration boundary', () => {
    const v = classifyFirmware(FIRMWARE)
    expect(v.layout).toBe('egzumer')
    expect(v.calStart).toBe(EGZUMER_CAL_START)
    expect(v.calStart).toBe(0x1e00)
  })

  it('gives egzumer 256 more programmable bytes than stock', () => {
    expect(classifyFirmware(FIRMWARE).calStart - classifyFirmware('2.01.32').calStart).toBe(0x100)
  })

  it('splits the image at that boundary, calibration read-only', () => {
    const img = image()
    expect(RAW.length).toBe(MEM_SIZE)
    expect(img.regions[0]!.data.length).toBe(0x1e00)
    expect(img.regions[1]!.start).toBe(0x1e00)
    expect(img.regions[1]!.data.length).toBe(0x200)
    expect(img.regions[1]!.readOnly).toBe(true)
  })

  it('will not let a stock image be written to an egzumer radio, or the reverse', () => {
    expect(variantsCompatible('2.01.32', FIRMWARE)).toBe(false)
    expect(variantsCompatible(FIRMWARE, '2.01.32')).toBe(false)
    expect(variantsCompatible(FIRMWARE, 'EGZUMER v0.23')).toBe(true)
  })
})

describe('the transcribed tables agree with CHIRP', () => {
  it('has CHIRP\'s twenty-four tuning steps, in CHIRP\'s order', () => {
    expect([...EGZUMER_STEPS_HZ]).toEqual(CHIRP.steps)
  })

  it('names the fourteen VFO presets the way CHIRP does', () => {
    expect(egzumerVfoChannelNames(true)).toEqual(CHIRP.vfoChannelNames)
    expect(Object.keys(CHIRP.specials)).toEqual(CHIRP.vfoChannelNames)
  })

  it('uses the band plan CHIRP picks for this build', () => {
    const build = readBuildOptions(image().regions[1]!.data, EGZUMER_CAL_START)
    expect(build.wideRx).toBe(true)
    expect(egzumerBands(build.wideRx).map(([lo, hi]) => [lo, hi])).toEqual(CHIRP.bands)
  })

  it('reads the build flags CHIRP reads', () => {
    const b = readBuildOptions(image().regions[1]!.data, EGZUMER_CAL_START)
    expect(b.wideRx).toBe(CHIRP.buildOptions.ENABLE_WIDE_RX === 1)
    expect(b.fmRadio).toBe(CHIRP.buildOptions.ENABLE_FMRADIO === 1)
    expect(b.noaa).toBe(CHIRP.buildOptions.ENABLE_NOAA === 1)
    expect(b.dtmfCalling).toBe(CHIRP.buildOptions.ENABLE_DTMF_CALLING === 1)
    expect(b.spectrum).toBe(CHIRP.buildOptions.ENABLE_SPECTRUM === 1)
    expect(b.amFix).toBe(CHIRP.buildOptions.ENABLE_AM_FIX === 1)
    expect(b.voice).toBe(CHIRP.buildOptions.ENABLE_VOICE === 1)
    expect(b.rawDemodulators).toBe(CHIRP.buildOptions.ENABLE_RAW_DEMODULATORS === 1)
  })
})

describe('decoded channels agree with CHIRP field for field', () => {
  const cp = driver.decode(image())
  const numbers = Object.keys(CHIRP.channels)
    .map(Number)
    .sort((a, b) => a - b)

  it('finds exactly the channels CHIRP finds', () => {
    expect([...cp.channels.keys()].sort((a, b) => a - b)).toEqual(numbers)
    expect(numbers.length).toBe(14)
  })

  it.each(numbers)('channel %i matches', (index) => {
    const mine = cp.channels.get(index)!
    const theirs = CHIRP.channels[String(index)]!
    expect(mine, `channel ${index} missing`).toBeDefined()

    // Slots past 200 are the VFO presets: CHIRP reports no name for them and
    // boofwang substitutes the radio's own label, which is a display decision
    // rather than stored data.
    if (index <= 200) expect(mine.name).toBe(theirs.name)
    else expect(mine.name).toBe(CHIRP.vfoChannelNames[index - 201])

    expect(mine.rxFreq).toBe(theirs.freq)
    expect(mine.tuningStep).toBe(theirs.tuningStepHz)
    expect(mine.power.label).toBe(theirs.power)

    // CHIRP folds demodulator and bandwidth into one mode string; boofwang
    // keeps them apart and recomposes. This is where the egzumer modulation
    // nibble is actually checked - USB has no stock equivalent at all.
    expect(chirpMode(mine)).toBe(theirs.mode)

    // Duplex, expressed as the frequency the radio would key up on.
    if (theirs.duplex === 'off') {
      expect(mine.txAllowed).toBe(false)
      expect(txFrequency(mine)).toBeNull()
    } else if (theirs.duplex === '') {
      expect(txFrequency(mine)).toBe(theirs.freq)
    } else {
      const sign = theirs.duplex === '+' ? 1 : -1
      expect(txFrequency(mine)).toBe(theirs.freq + sign * theirs.offset)
    }

    for (const [side, expected] of [
      ['rx', theirs.rxtone],
      ['tx', theirs.txtone],
    ] as const) {
      const got = side === 'rx' ? mine.tone.rx : mine.tone.tx
      if (expected === null) expect(got, `channel ${index} ${side} tone`).toBeNull()
      else if (expected.kind === 'ctcss') expect(got).toEqual({ kind: 'ctcss', deciHz: expected.deciHz })
      else expect(got).toEqual({ kind: 'dtcs', code: expected.code, polarity: expected.polarity })
    }

    // The raw bit fields, which is where a mis-transcribed nibble shows up
    // before it shows up anywhere else.
    const e = mine.extras.uvk5!
    expect(e.stepIndex).toBe(theirs.raw.step)
    expect(e.scrambler).toBe(theirs.raw.scrambler)
    expect(e.busyChannelLockout).toBe(theirs.raw.bclo === 1)
    expect(e.freqReverse).toBe(theirs.raw.freqReverse === 1)
    expect(e.dtmfDecode).toBe(theirs.raw.dtmfDecode === 1)
    expect(e.dtmfPttId).toBe(theirs.raw.dtmfPttId)

    if (theirs.attr) {
      expect(e.scanList1).toBe(theirs.attr.scanList1 === 1)
      expect(e.scanList2).toBe(theirs.attr.scanList2 === 1)
      expect(e.compander).toBe(theirs.attr.compander)
      expect(e.band).toBe(theirs.attr.band)
    }
  })

  it('reads the three-bit PTT-ID field egzumer widened', () => {
    // Stock gives this field two bits and four values. Egzumer adds a fifth,
    // Apollo Quindar, which cannot be read at all without the extra bit.
    expect(cp.channels.get(9)!.extras.uvk5!.dtmfPttId).toBe(4)
    expect(CHIRP.channels['9']!.raw.dtmfPttId).toBe(4)
  })

  it('reads the single-sideband channel stock has no encoding for', () => {
    expect(cp.channels.get(7)!.modulation).toBe('USB')
    expect(cp.channels.get(10)!.modulation).toBe('USB')
    expect(CHIRP.channels['7']!.raw.modulation).toBe(2)
  })

  it('reads a step from outside stock\'s six-entry table', () => {
    // 8.33 kHz is index 6 on egzumer and does not exist on stock at all.
    expect(cp.channels.get(5)!.tuningStep).toBe(8330)
    expect(cp.channels.get(5)!.extras.uvk5!.stepIndex).toBe(6)
    expect(cp.channels.get(6)!.tuningStep).toBe(10)
  })

  it('reads channels outside stock\'s band plan', () => {
    expect(cp.channels.get(10)!.rxFreq).toBe(21_300_000)
    expect(cp.channels.get(11)!.rxFreq).toBe(1_240_000_000)
  })
})

describe('decoded settings agree with CHIRP', () => {
  const s = driver.decode(image()).settings

  /**
   * boofwang's key on the left, the name CHIRP's MEM_FORMAT gives the same
   * bytes on the right. Written out rather than derived so that a rename on
   * either side has to be noticed here.
   */
  const SAME: Record<string, string> = {
    callChannel: 'call_channel',
    squelch: 'squelch',
    maxTalkTime: 'max_talk_time',
    noaaAutoscan: 'noaa_autoscan',
    keyLock: 'key_lock',
    voxSwitch: 'vox_switch',
    voxLevel: 'vox_level',
    micGain: 'mic_gain',
    backlightMin: 'backlight_min',
    backlightMax: 'backlight_max',
    channelDisplayMode: 'channel_display_mode',
    crossband: 'crossband',
    batterySave: 'battery_save',
    dualWatch: 'dual_watch',
    backlightTime: 'backlight_time',
    ste: 'ste',
    freqModeAllowed: 'freq_mode_allowed',
    screenChannelA: 'ScreenChannel_A',
    mrChannelA: 'MrChannel_A',
    freqChannelA: 'FreqChannel_A',
    screenChannelB: 'ScreenChannel_B',
    mrChannelB: 'MrChannel_B',
    freqChannelB: 'FreqChannel_B',
    noaaChannelA: 'NoaaChannel_A',
    noaaChannelB: 'NoaaChannel_B',
    keyMLongpressAction: 'keyM_longpress_action',
    buttonBeep: 'button_beep',
    key1ShortpressAction: 'key1_shortpress_action',
    key1LongpressAction: 'key1_longpress_action',
    key2ShortpressAction: 'key2_shortpress_action',
    key2LongpressAction: 'key2_longpress_action',
    scanResumeMode: 'scan_resume_mode',
    autoKeypadLock: 'auto_keypad_lock',
    powerOnDispmode: 'power_on_dispmode',
    password: 'password',
    voice: 'voice',
    s0Level: 's0_level',
    s9Level: 's9_level',
    alarmMode: 'alarm_mode',
    rogerBeep: 'roger_beep',
    rpSte: 'rp_ste',
    txVfo: 'TX_VFO',
    batteryType: 'Battery_type',
    scanListDefault: 'slDef',
    scanList1PriorityEnable: 'sl1PriorEnab',
    scanList1PriorityCh1: 'sl1PriorCh1',
    scanList1PriorityCh2: 'sl1PriorCh2',
    scanList2PriorityEnable: 'sl2PriorEnab',
    scanList2PriorityCh1: 'sl2PriorCh1',
    scanList2PriorityCh2: 'sl2PriorCh2',
    intFlock: 'int_flock',
    int350Tx: 'int_350tx',
    intKilled: 'int_KILLED',
    int200Tx: 'int_200tx',
    int500Tx: 'int_500tx',
    int350En: 'int_350en',
    intScrEn: 'int_scren',
    backlightOnTxRx: 'backlight_on_TX_RX',
    amFix: 'AM_fix',
    micBar: 'mic_bar',
    batteryText: 'battery_text',
    liveDtmfDecoder: 'live_DTMF_decoder',
    logoLine1: 'logo_line1',
    logoLine2: 'logo_line2',
    dtmfSideTone: 'dtmf_side_tone',
    dtmfSeparateCode: 'dtmf_separate_code',
    dtmfGroupCallCode: 'dtmf_group_call_code',
    dtmfDecodeResponse: 'dtmf_decode_response',
    dtmfAutoResetTime: 'dtmf_auto_reset_time',
    dtmfPreloadTime: 'dtmf_preload_time',
    dtmfFirstCodePersistTime: 'dtmf_first_code_persist_time',
    dtmfHashPersistTime: 'dtmf_hash_persist_time',
    dtmfCodePersistTime: 'dtmf_code_persist_time',
    dtmfCodeIntervalTime: 'dtmf_code_interval_time',
    dtmfPermitRemoteKill: 'dtmf_permit_remote_kill',
    dtmfLocalCode: 'dtmf_local_code',
    dtmfKillCode: 'dtmf_kill_code',
    dtmfReviveCode: 'dtmf_revive_code',
    dtmfUpCode: 'dtmf_up_code',
    dtmfDownCode: 'dtmf_down_code',
  }

  it.each(Object.entries(SAME))('%s reads what CHIRP reads from %s', (mine, theirs) => {
    expect(CHIRP.settings, `the fixture has no ${theirs}`).toHaveProperty(theirs)
    expect(s[mine]).toEqual(CHIRP.settings[theirs])
  })

  it('reads all twenty FM broadcast presets', () => {
    for (let i = 0; i < 20; i++) expect(s[`fmPreset${i + 1}`]).toBe(CHIRP.fmPresets[i])
  })

  it('separates the two halves of the backlight byte the right way round', () => {
    // 0x0E78 is one byte under stock and two nibbles under egzumer, and getting
    // them the wrong way round is invisible unless min and max differ.
    expect(s.backlightMin).toBe(2)
    expect(s.backlightMax).toBe(9)
    expect(s.backlightMin).not.toBe(s.backlightMax)
  })

  it('reports the build flags that decided how the rest was read', () => {
    expect(s.buildWideRx).toBe(1)
    expect(s.buildFmRadio).toBe(1)
  })
})

describe('validation follows the wider receiver but not a wider transmitter', () => {
  const base = image()

  function withChannel(rxHz: number) {
    const doc = driver.decode(base)
    const one = doc.channels.get(1)!
    doc.channels.set(1, { ...one, rxFreq: rxHz as typeof one.rxFreq })
    return driver.validate(doc).filter((d) => d.channel === 1)
  }

  it('accepts the shortwave and 23 cm channels this firmware can reach', () => {
    // Both are outside stock's band plan entirely. Reporting them as errors
    // would put a permanent complaint on a channel the radio is happy with.
    expect(withChannel(21_300_000)).toEqual([])
    expect(withChannel(1_240_000_000)).toEqual([])
  })

  it('still refuses to let the broadcast band be a transmit channel', () => {
    // Wide receive puts 76-108 MHz inside band 0, which is otherwise
    // transmit-allowed. Inheriting that would quietly bless a transmit channel
    // on top of a broadcast station.
    const errors = withChannel(100_100_000)
    expect(errors.map((d) => d.ruleId)).toContain('regulatory.band.tx-not-permitted')
  })

  it('leaves the air band exactly as it was', () => {
    expect(withChannel(121_500_000).map((d) => d.ruleId)).toContain('regulatory.band.tx-not-permitted')
  })

  it('holds a codeplug with no build flags to the stock band plan', () => {
    // A codeplug built from a CSV has no settings at all, so there is nothing
    // saying it came off a widened radio. Stock's limits are the safe default.
    const doc = driver.decode(base)
    doc.settings = {}
    const one = doc.channels.get(1)!
    doc.channels.set(1, { ...one, rxFreq: 21_300_000 as typeof one.rxFreq })
    expect(driver.validate(doc).map((d) => d.ruleId)).toContain('radio.band.rx-out-of-range')
  })
})

describe('round trip', () => {
  it('encode(decode(image), image) is byte-identical, both regions', () => {
    const base = image()
    const out = driver.encode(driver.decode(base), base)
    expect(out.regions.length).toBe(base.regions.length)
    for (let i = 0; i < base.regions.length; i++) {
      expect(
        equalBytes(out.regions[i]!.data, base.regions[i]!.data),
        `region ${base.regions[i]!.label} changed`,
      ).toBe(true)
    }
  })

  it('leaves everything it does not decode exactly as it found it', () => {
    // The DTMF contact list at 0x1C00 and the seven attribute entries above
    // memory 200 are populated in the fixture precisely so that "preserved"
    // is a claim with something behind it.
    const base = image()
    const mem = driver.encode(driver.decode(base), base).regions[0]!.data
    expect(equalBytes(mem.subarray(0x1c00, 0x1d00), RAW.subarray(0x1c00, 0x1d00))).toBe(true)

    // Egzumer's attribute table runs to 207 entries where stock's runs to 200.
    // The extra seven are the frequency-mode band presets; CHIRP never reads
    // them for a memory and neither does this, so they must come back untouched.
    expect(EGZUMER_ATTR_COUNT).toBe(NAMED_CHANNEL_COUNT + 7)
    const extra = [ATTR_BASE + NAMED_CHANNEL_COUNT, ATTR_BASE + EGZUMER_ATTR_COUNT] as const
    expect(equalBytes(mem.subarray(...extra), RAW.subarray(...extra))).toBe(true)
  })

  it('leaves a record it does not understand exactly as it found it', () => {
    // Both fields have room for values the firmware never writes: the
    // modulation nibble has sixteen states and three meanings, and the step
    // byte has 256 and twenty-four. Both decode to a fallback - FM, and 2.5 kHz
    // - so re-encoding from the decoded value alone would rewrite the byte, on
    // exactly the record this build has admitted it cannot read.
    const mem = RAW.slice()
    mem[0x000b] = (0x0b << 4) | (mem[0x000b]! & 0x0f)
    mem[0x000e] = 200
    const base = image(mem)

    const doc = driver.decode(base)
    expect(doc.channels.get(1)!.modulation).toBe('FM')
    expect(doc.channels.get(1)!.tuningStep).toBe(EGZUMER_STEPS_HZ[0])

    const out = driver.encode(doc, base).regions[0]!.data
    expect(out[0x000b]).toBe(mem[0x000b])
    expect(out[0x000e]).toBe(200)
    expect(equalBytes(out, base.regions[0]!.data)).toBe(true)
  })

  it('carries an edited setting back into the bytes', () => {
    const base = image()
    const doc = driver.decode(base)
    doc.settings.squelch = 7
    doc.settings.backlightMax = 3
    doc.settings.fmPreset3 = 1007
    const round = driver.decode(driver.encode(doc, base))
    expect(round.settings.squelch).toBe(7)
    expect(round.settings.backlightMax).toBe(3)
    // The other nibble of the same byte must not have moved with it.
    expect(round.settings.backlightMin).toBe(2)
    expect(round.settings.fmPreset3).toBe(1007)
  })

  it('keeps every byte the encoder can move inside ownedRanges', () => {
    const base = image()
    const doc = driver.decode(base)
    for (const ch of doc.channels.values()) ch.name = ch.index <= 200 ? `X${ch.index}` : ch.name
    doc.settings.squelch = 9
    doc.settings.logoLine1 = 'CHANGED'
    const out = driver.encode(doc, base)

    const owned = driver.ownedRanges(0, out)
    const before = base.regions[0]!.data
    const after = out.regions[0]!.data
    for (let i = 0; i < before.length; i++) {
      if (before[i] === after[i]) continue
      expect(rangesContain(owned, [i, i + 1]), `0x${i.toString(16)} moved but is not claimed`).toBe(true)
    }
  })

  it('claims nothing in the calibration region', () => {
    expect(driver.ownedRanges(EGZUMER_CAL_START, image())).toEqual([])
  })
})

describe('writing is still refused', () => {
  const OPEN = { baudRate: 38_400 }

  function radioPort(eeprom: Uint8Array) {
    return new FakeSerialPort({
      respond: (frame) => {
        const payload = xorArray(frame.subarray(4, 4 + frame[2]!))
        if (payload[0] === 0x14) {
          const body = new Uint8Array(0x28)
          body[0] = 0x15
          body[1] = 0x05
          for (let i = 0; i < FIRMWARE.length; i++) body[4 + i] = FIRMWARE.charCodeAt(i)
          return buildFrame(body)
        }
        if (payload[0] === 0x1b) {
          const addr = payload[4]! | (payload[5]! << 8)
          const len = payload[6]!
          const body = new Uint8Array(8 + len)
          body[0] = 0x1c
          body[4] = addr & 0xff
          body[5] = (addr >> 8) & 0xff
          body[6] = len
          body.set(eeprom.subarray(addr, addr + len), 8)
          return buildFrame(body)
        }
        throw new Error(`the test radio was sent command 0x${payload[0]!.toString(16)}; it should never be written to`)
      },
    })
  }

  async function connect() {
    const t = new SerialTransport(radioPort(RAW.slice()))
    await t.open(OPEN)
    return t
  }

  it('reports the firmware as read-only at handshake, with a reason', async () => {
    const t = await connect()
    const ident = await driver.identify(t, { readTimeoutMs: 1000 })
    await t.close()
    expect(ident.layout).toBe('egzumer')
    expect(ident.caps.read).toBe(true)
    expect(ident.caps.write).toBe(false)
    expect(ident.caps.reason).toMatch(/writing stays off/)
  })

  it('refuses the write even with the driver gate open and a matching backup', async () => {
    const t = await connect()
    const ident = await writable.identify(t, { readTimeoutMs: 1000 })
    await expect(
      writable.writeImage(t, image(), {
        readTimeoutMs: 1000,
        ident,
        backup: { id: 'b1', identHash: ident.identHash, createdAt: '2026-08-21T00:00:00Z' },
      }),
    ).rejects.toBeInstanceOf(UnsupportedFirmwareError)
    await t.close()
  })

  it('reads the calibration region from 0x1E00 when fingerprinting', async () => {
    // Reading from stock's 0x1D00 would fold 256 bytes of programmable memory
    // into the unit fingerprint, so a user changing a channel would change the
    // identity of their own radio and invalidate their own backup.
    const t = await connect()
    const a = await driver.identify(t, { readTimeoutMs: 1000 })
    await t.close()

    const edited = RAW.slice()
    edited[0x1d80] = edited[0x1d80]! ^ 0xff
    const t2 = new SerialTransport(radioPort(edited))
    await t2.open(OPEN)
    const b = await driver.identify(t2, { readTimeoutMs: 1000 })
    await t2.close()

    expect(b.identHash).toBe(a.identHash)
  })
})

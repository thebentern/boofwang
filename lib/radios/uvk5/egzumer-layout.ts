// SPDX-License-Identifier: GPL-3.0-or-later
import { ascii, chirpBits, scaled, u8, u32le } from '../../codec/fields.js'
import { at, defineStruct } from '../../codec/struct.js'
import { ATTR_BASE, NAMED_CHANNEL_COUNT, NAME_BASE, NAME_SIZE, regionsFor } from './layout.js'

/**
 * The egzumer custom firmware's EEPROM layout.
 *
 * Offsets and bit orders transcribed from `MEM_FORMAT` in CHIRP's
 * `chirp/drivers/uvk5_egzumer.py` (GPL-3.0), then checked back against CHIRP's
 * own `bitwise` parser: every field below was set through CHIRP on an otherwise
 * zeroed image and the byte that moved recorded. That is why the declarations
 * here are worth trusting - they are not a second reading of the format string
 * by the same eyes that wrote the first.
 *
 * Most of the radio is unchanged from stock. The channel table is the same
 * shape and lives at the same place; the divergences are the two flag bytes
 * inside each record, a much longer tuning-step table, a wider band plan, and
 * a settings window that stock and egzumer agree on the *addresses* of while
 * disagreeing about what a good third of them mean.
 */

/** `_cal_start` in uvk5_egzumer.py. 256 bytes more programmable space than stock. */
export const EGZUMER_CAL_START = 0x1e00

export const EGZUMER_REGIONS = regionsFor(EGZUMER_CAL_START)

// ---------------------------------------------------------------- channels --

/**
 * One channel record.
 *
 * Identical to stock except for two bytes:
 *
 * - 0x0B is `modulation:4, shift:4` where stock has five placeholder bits, an
 *   `enable_am` flag and a two-bit shift. The low bit of egzumer's modulation
 *   nibble is stock's `enable_am` bit, so the two layouts agree on FM and AM
 *   and only diverge once `modulation` reaches 2, which is single sideband.
 *   Stock's `is_in_scanlist` bit is inside egzumer's shift nibble; nothing in
 *   the egzumer driver reads it, and scan-list membership lives in the
 *   attribute byte for both.
 * - 0x0D gives the PTT-ID field three bits rather than two, because egzumer
 *   adds a fifth option (Apollo Quindar tones) to the four stock has.
 */
export const EGZUMER_CHANNEL = defineStruct(16, {
  freq: at(0x00, scaled(u32le, 10, [0x00000000, 0xffffffff])),
  offset: at(0x04, scaled(u32le, 10, [0x00000000, 0xffffffff])),
  rxCode: at(0x08, u8),
  txCode: at(0x09, u8),
  codeFlags: at(
    0x0a,
    chirpBits(1, [
      ['txCodeFlag', 4],
      ['rxCodeFlag', 4],
    ]),
  ),
  modeFlags: at(
    0x0b,
    chirpBits(1, [
      ['modulation', 4],
      ['shift', 4],
    ]),
  ),
  flags2: at(
    0x0c,
    chirpBits(1, [
      ['unused1', 3],
      ['bclo', 1],
      ['txPower', 2],
      ['bandwidth', 1],
      ['freqReverse', 1],
    ]),
  ),
  dtmfFlags: at(
    0x0d,
    chirpBits(1, [
      ['unused2', 4],
      ['dtmfPttId', 3],
      ['dtmfDecode', 1],
    ]),
  ),
  step: at(0x0e, u8),
  scrambler: at(0x0f, u8),
})

/**
 * `channel_attributes[207]`, seven entries longer than stock's 200.
 *
 * The extra seven cover the radio's frequency-mode band presets. CHIRP's
 * egzumer driver never reads them - `get_memory` consults the attribute table
 * only for slots below 200 - so this driver does not decode or write them
 * either, and they survive as bytes nobody claims.
 */
export const EGZUMER_ATTR_COUNT = 207

/**
 * `_steps` in uvk5_egzumer.py, in hertz rather than the kHz floats CHIRP uses.
 *
 * The first six are stock's table in stock's order, which is what lets an
 * ordinary channel read the same under either firmware. The eighteen after
 * them are egzumer's own, and they are not sorted - index 6 is 8.33 kHz, the
 * air-band channel spacing, sitting after 25 kHz. Sorting this list would
 * silently retune every channel on the radio.
 */
export const EGZUMER_STEPS_HZ = [
  2_500, 5_000, 6_250, 10_000, 12_500, 25_000, 8_330, 10, 50, 100, 250, 500, 1_000, 1_250, 9_000, 15_000,
  20_000, 30_000, 50_000, 100_000, 125_000, 200_000, 250_000, 500_000,
] as const

/**
 * `modulation` nibble values, from `_get_mem_mode`: CHIRP derives its mode
 * string as `valid_modes[modulation * 2 + bandwidth]` over
 * `["FM", "NFM", "AM", "NAM", "USB"]`. So the nibble alone chooses the
 * demodulator and the bandwidth bit narrows it; `modulation` 2 with the narrow
 * bit set falls off the end of that list and CHIRP maps it back to USB.
 */
export const MODULATION_FM = 0
export const MODULATION_AM = 1
export const MODULATION_USB = 2

/**
 * `BANDS_STANDARD` and `BANDS_WIDE`, in hertz.
 *
 * Which applies is a build option rather than a setting: `_get_bands` picks
 * `BANDS_WIDE` when `BUILD_OPTIONS.ENABLE_WIDE_RX` is set. Only the first and
 * last entries differ, and the band nibble stored in a channel's attribute
 * byte means the same index either way.
 */
export const EGZUMER_BANDS_STANDARD_HZ: readonly (readonly [number, number])[] = [
  [50_000_000, 76_000_000],
  [108_000_000, 136_999_900],
  [137_000_000, 173_999_900],
  [174_000_000, 349_999_900],
  [350_000_000, 399_999_900],
  [400_000_000, 469_999_900],
  [470_000_000, 600_000_000],
]

export const EGZUMER_BANDS_WIDE_HZ: readonly (readonly [number, number])[] = [
  [18_000_000, 108_000_000],
  [108_000_000, 136_999_900],
  [137_000_000, 173_999_900],
  [174_000_000, 349_999_900],
  [350_000_000, 399_999_900],
  [400_000_000, 469_999_900],
  [470_000_000, 1_300_000_000],
]

export const egzumerBands = (wideRx: boolean) => (wideRx ? EGZUMER_BANDS_WIDE_HZ : EGZUMER_BANDS_STANDARD_HZ)

/**
 * `BANDS_NOLIMITS` in uvk5.py - a third table, and the one that decides the
 * band nibble written into a channel's attribute byte.
 *
 * It is not either of the two above, which is easy to miss and worth spelling
 * out. CHIRP's `set_memory` calls the module-level `_find_band(self, freq)`,
 * passing the radio object where the function expects a "no limits" flag; the
 * object is always truthy, so the modified-firmware table always wins, for
 * every UV-K5 variant. Deriving the nibble from the band plan the radio
 * *displays* instead would disagree with CHIRP on any channel below 50 MHz and
 * put a different byte in the image.
 */
const BAND_NIBBLE_HZ: readonly (readonly [number, number])[] = [
  [18_000_000, 76_000_000],
  [108_000_000, 136_999_900],
  [137_000_000, 173_999_900],
  [174_000_000, 349_999_900],
  [350_000_000, 399_999_900],
  [400_000_000, 469_999_900],
  [470_000_000, 1_300_000_000],
]

/**
 * The band nibble for a frequency, transcribed from `_find_band`.
 *
 * The sub-50 MHz case is CHIRP's, comment and all: "currently the hacked
 * firmware sets band=1 below 50 MHz". It fires before the table is consulted,
 * so 21 MHz is band 1 rather than the band 0 the table would give.
 */
export function egzumerBandForFreq(hz: number): number {
  if (hz < 50_000_000) return 1
  for (let i = 0; i < BAND_NIBBLE_HZ.length; i++) {
    const [lo, hi] = BAND_NIBBLE_HZ[i]!
    if (hz >= lo && hz <= hi) return i
  }
  // CHIRP returns False here, which lands in the nibble as zero.
  return 0
}

/**
 * The 14 VFO pseudo-channels, named the way the radio names them.
 *
 * `_get_vfo_channel_names` builds these from whichever band table is in force,
 * so on a wide-receive build the first and last pairs read F1(18M-108M) and
 * F7(470M-1300M) rather than stock's F1(50M-76M) and F7(470M-600M). The
 * rounding is CHIRP's: `round(rng[0])` on a megahertz float, so 136.9999
 * becomes 137.
 */
export function egzumerVfoChannelNames(wideRx: boolean): string[] {
  const out: string[] = []
  egzumerBands(wideRx).forEach(([lo, hi], i) => {
    const name = `F${i + 1}(${Math.round(lo / 1e6)}M-${Math.round(hi / 1e6)}M)`
    out.push(`${name}A`, `${name}B`)
  })
  return out
}

// ---------------------------------------------------------------- settings --

/** FM broadcast presets: `ul16 fmfreq[20]` at 0x0E40, in units of 100 kHz. */
export const FM_PRESET_BASE = 0x0e40
export const FM_PRESET_COUNT = 20
/** What the firmware stores in a preset that holds no station. */
export const FM_PRESET_EMPTY = 0xffff

export const EGZUMER_SETTINGS_BASE = 0x0e70
/** One past the last settings byte: 0x0F48, where the channel-name table's run-up begins. */
export const EGZUMER_SETTINGS_END = 0x0f48

/**
 * Everything the radio configures about itself, as one record.
 *
 * Declared as a single struct rather than a scatter of addresses because
 * `defineStruct` then refuses overlapping fields at module load, and because
 * `write()` applies a partial patch: the bytes inside this window that no field
 * below claims - and there are several runs of them - keep whatever the radio
 * had. That is what makes `encode(decode(image), image)` byte-exact over a
 * region this driver only partly understands.
 *
 * Offsets are relative to {@link EGZUMER_SETTINGS_BASE}.
 */
export const EGZUMER_SETTINGS = defineStruct(EGZUMER_SETTINGS_END - EGZUMER_SETTINGS_BASE, {
  // 0x0E70
  callChannel: at(0x00, u8),
  squelch: at(0x01, u8),
  maxTalkTime: at(0x02, u8),
  noaaAutoscan: at(0x03, u8),
  keyLock: at(0x04, u8),
  voxSwitch: at(0x05, u8),
  voxLevel: at(0x06, u8),
  micGain: at(0x07, u8),
  // 0x0E78. Stock declares this byte as a single unknown; egzumer splits it.
  backlightLevels: at(
    0x08,
    chirpBits(1, [
      ['backlightMin', 4],
      ['backlightMax', 4],
    ]),
  ),
  channelDisplayMode: at(0x09, u8),
  crossband: at(0x0a, u8),
  batterySave: at(0x0b, u8),
  dualWatch: at(0x0c, u8),
  backlightTime: at(0x0d, u8),
  ste: at(0x0e, u8),
  freqModeAllowed: at(0x0f, u8),

  // 0x0E80. Stock's MEM_FORMAT does not declare this run at all.
  screenChannelA: at(0x10, u8),
  mrChannelA: at(0x11, u8),
  freqChannelA: at(0x12, u8),
  screenChannelB: at(0x13, u8),
  mrChannelB: at(0x14, u8),
  freqChannelB: at(0x15, u8),
  noaaChannelA: at(0x16, u8),
  noaaChannelB: at(0x17, u8),

  // 0x0E90. Stock uses the whole byte for `beep_control`; egzumer keeps the
  // beep in bit 0 and spends the other seven on the menu key's long press.
  menuKey: at(
    0x20,
    chirpBits(1, [
      ['keyMLongpressAction', 7],
      ['buttonBeep', 1],
    ]),
  ),
  key1ShortpressAction: at(0x21, u8),
  key1LongpressAction: at(0x22, u8),
  key2ShortpressAction: at(0x23, u8),
  key2LongpressAction: at(0x24, u8),
  scanResumeMode: at(0x25, u8),
  autoKeypadLock: at(0x26, u8),
  powerOnDispmode: at(0x27, u8),
  // 0x0E98. A 32-bit number, where stock declares eight separate bytes.
  // Anything at or above 1,000,000 means no password is set.
  password: at(0x28, u32le),

  // 0x0EA0. Stock reads these three bytes as keypad tone and language.
  voice: at(0x30, u8),
  s0Level: at(0x31, u8),
  s9Level: at(0x32, u8),

  // 0x0EA8
  alarmMode: at(0x38, u8),
  rogerBeep: at(0x39, u8),
  rpSte: at(0x3a, u8),
  txVfo: at(0x3b, u8),
  batteryType: at(0x3c, u8),

  // 0x0EB0. The two lines of the power-on message. The field is 16 bytes and
  // CHIRP writes at most 12 characters into it, so 12 is the usable length.
  logoLine1: at(0x40, ascii(16, { pad: 0x00, terminators: [0x00, 0xff] })),
  logoLine2: at(0x50, ascii(16, { pad: 0x00, terminators: [0x00, 0xff] })),

  // 0x0ED0. Identical to stock's `dtmf_settings`.
  dtmfSideTone: at(0x60, u8),
  dtmfSeparateCode: at(0x61, ascii(1, { pad: 0x00 })),
  dtmfGroupCallCode: at(0x62, ascii(1, { pad: 0x00 })),
  dtmfDecodeResponse: at(0x63, u8),
  dtmfAutoResetTime: at(0x64, u8),
  // The five timers below are stored in units of 10 ms; CHIRP multiplies on
  // read and divides on write. They are left in the radio's own units here so
  // that a value the firmware holds and this build cannot express - an odd
  // number of milliseconds - cannot be lost to rounding.
  dtmfPreloadTime: at(0x65, u8),
  dtmfFirstCodePersistTime: at(0x66, u8),
  dtmfHashPersistTime: at(0x67, u8),
  dtmfCodePersistTime: at(0x68, u8),
  dtmfCodeIntervalTime: at(0x69, u8),
  dtmfPermitRemoteKill: at(0x6a, u8),

  // 0x0EE0. Five gaps run through this block; the struct declares only the
  // codes themselves, so the gaps are preserved rather than normalised.
  dtmfLocalCode: at(0x70, ascii(3, { pad: 0x00 })),
  dtmfKillCode: at(0x78, ascii(5, { pad: 0x00 })),
  dtmfReviveCode: at(0x80, ascii(5, { pad: 0x00 })),
  dtmfUpCode: at(0x88, ascii(16, { pad: 0x00 })),
  dtmfDownCode: at(0x98, ascii(16, { pad: 0x00 })),

  // 0x0F18. Stock has an eighth byte here that egzumer does not declare.
  // Priority channels are stored zero-based, with 0xFF for "none".
  scanListDefault: at(0xa8, u8),
  scanList1PriorityEnable: at(0xa9, u8),
  scanList1PriorityCh1: at(0xaa, u8),
  scanList1PriorityCh2: at(0xab, u8),
  scanList2PriorityEnable: at(0xac, u8),
  scanList2PriorityCh1: at(0xad, u8),
  scanList2PriorityCh2: at(0xae, u8),

  // 0x0F40. The same seven transmit-lock bytes stock calls `lock`.
  intFlock: at(0xd0, u8),
  int350Tx: at(0xd1, u8),
  intKilled: at(0xd2, u8),
  int200Tx: at(0xd3, u8),
  int500Tx: at(0xd4, u8),
  int350En: at(0xd5, u8),
  intScrEn: at(0xd6, u8),
  // 0x0F47. Egzumer's own; stock declares nothing here.
  displayFlags: at(
    0xd7,
    chirpBits(1, [
      ['backlightOnTxRx', 2],
      ['amFix', 1],
      ['micBar', 1],
      ['batteryText', 2],
      ['liveDtmfDecoder', 1],
      ['unused', 1],
    ]),
  ),
})

/**
 * The build-time feature flags, at 0x1FF0.
 *
 * These sit *inside* the calibration region, above `_cal_start`, which is the
 * only reason this driver reads them at all: they are never written, so
 * reporting what the firmware was built with costs nothing and risks nothing.
 * `ENABLE_WIDE_RX` is the one that changes how an image decodes, because it
 * decides which band plan and which VFO preset names apply.
 */
export const BUILD_OPTIONS_ADDR = 0x1ff0

export const EGZUMER_BUILD_OPTIONS = defineStruct(2, {
  first: at(
    0x00,
    chirpBits(1, [
      ['enableDtmfCalling', 1],
      ['enablePwronPassword', 1],
      ['enableTx1750', 1],
      ['enableAlarm', 1],
      ['enableVox', 1],
      ['enableVoice', 1],
      ['enableNoaa', 1],
      ['enableFmRadio', 1],
    ]),
  ),
  second: at(
    0x01,
    chirpBits(1, [
      ['unused', 2],
      ['enableSpectrum', 1],
      ['enableAmFix', 1],
      ['enableBlminTmpOff', 1],
      ['enableRawDemodulators', 1],
      ['enableWideRx', 1],
      ['enableFlashlight', 1],
    ]),
  ),
})

// ---------------------------------------------------------------- addresses --

export const fmPresetAddr = (i: number) => FM_PRESET_BASE + i * 2

/**
 * Byte ranges of the programmable region this driver claims to understand
 * under the egzumer layout.
 *
 * The channel, name and attribute tables are stock's, at stock's addresses.
 * What is added is the FM preset table and the settings window - and only the
 * settings window, not the seven extra attribute entries above slot 199, which
 * are read back verbatim because nothing here knows what they hold.
 */
export function egzumerOwnedRanges(): (readonly [number, number])[] {
  return [
    [0x0000, 214 * EGZUMER_CHANNEL.size],
    [ATTR_BASE, ATTR_BASE + NAMED_CHANNEL_COUNT],
    [FM_PRESET_BASE, FM_PRESET_BASE + FM_PRESET_COUNT * 2],
    ...EGZUMER_SETTINGS.ranges().map(
      ([s, e]) => [EGZUMER_SETTINGS_BASE + s, EGZUMER_SETTINGS_BASE + e] as const,
    ),
    [NAME_BASE, NAME_BASE + NAMED_CHANNEL_COUNT * NAME_SIZE],
  ]
}

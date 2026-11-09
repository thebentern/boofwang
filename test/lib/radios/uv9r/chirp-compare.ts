// SPDX-License-Identifier: GPL-3.0-or-later
import { expect } from 'vitest'
import { txFrequency, type Channel } from '#core/model/channel.js'
import type { RadioSchema } from '#core/radio/schema.js'

/**
 * Holding boofwang's WP970I decode to what CHIRP's own driver reports.
 *
 * The JSON comes from scripts/dump-wp970i-family.py, which builds CHIRP's real
 * driver class over the image and calls `get_memory` and `get_settings`. This
 * file is only the translation between the two vocabularies - CHIRP's duplex
 * strings and list labels against boofwang's transmit spec and raw values -
 * and every rule in it is CHIRP's.
 */

type Tone = { kind: 'ctcss'; deciHz: number } | { kind: 'dtcs'; code: number; polarity: 'N' | 'R' } | null

export interface ChirpChannel {
  readonly name: string
  readonly rx: number
  readonly tx: number
  readonly duplex: '' | '+' | '-' | 'split' | 'off'
  readonly bw: number
  readonly power: string
  readonly lowpower: number
  readonly skip: 'none' | 'skip'
  readonly rxtone: Tone
  readonly txtone: Tone
  readonly bcl: string
  readonly pttid: string
  readonly scode: string
}

export type ChirpDecode = Record<string, ChirpChannel | { readonly error: string }>

export interface ChirpSettings {
  readonly source: string
  readonly class: string
  readonly bytes: number
  readonly sha256: string
  readonly settings: Record<string, number | number[]>
  readonly poweron_msg: { readonly line1: string; readonly line2: string }
  readonly get_settings: Record<string, { readonly value: string; readonly index?: number; readonly options?: number }>
}

/** `LIST_PTTID` in baofeng_wp970i.py. */
const PTTID = ['Off', 'BOT', 'EOT', 'Both']

export function expectSameChannel(mine: Channel | undefined, theirs: ChirpChannel, index: number): void {
  expect(mine, `channel ${index} is missing`).toBeDefined()
  const ch = mine!
  expect(ch.name, `${index} name`).toBe(theirs.name)
  expect(ch.rxFreq, `${index} rx`).toBe(theirs.rx)
  expect(txFrequency(ch) ?? 0, `${index} tx`).toBe(theirs.tx)

  // The shape of the transmit spec, not just where it lands: CHIRP's duplex
  // decides shift against split by its own bands, and so must the decoder.
  const shape =
    !ch.txAllowed ? 'off'
    : ch.tx.kind === 'simplex' ? ''
    : ch.tx.kind === 'split' ? 'split'
    : ch.tx.direction === 'plus' ? '+'
    : '-'
  expect(shape, `${index} duplex`).toBe(theirs.duplex)

  expect(ch.bandwidthHz, `${index} bandwidth`).toBe(theirs.bw)
  expect(ch.power.label, `${index} power`).toBe(theirs.power)
  expect(ch.skip, `${index} skip`).toBe(theirs.skip)
  expect(ch.tone.rx, `${index} rx tone`).toEqual(theirs.rxtone)
  expect(ch.tone.tx, `${index} tx tone`).toEqual(theirs.txtone)

  // `mem.extra`, as CHIRP labels it: a boolean, a PTT ID label, and an S-code
  // from a list that starts at "1" for a stored 0.
  const vendor = ch.extras.vendor ?? {}
  expect(vendor.busyChannelLockout, `${index} bcl`).toBe(theirs.bcl === 'True' ? '1' : '0')
  expect(vendor.pttId, `${index} ptt id`).toBe(String(PTTID.indexOf(theirs.pttid)))
  expect(vendor.scode, `${index} s-code`).toBe(String(Number(theirs.scode) - 1))
}

/**
 * CHIRP's names for the settings struct, against boofwang's keys.
 *
 * The keys are the UV-82's, because the struct is: `unknown_e22` in
 * baofeng_wp970i.py is `unknown1` in uv5r.py and in lib/radios/uv82/layout.ts,
 * at the same radio address. Bit groups carry the byte's offset name, `f2a`.
 */
export const SETTINGS_KEYS: Readonly<Record<string, string>> = {
  squelch: 'squelch',
  step: 'step',
  unknown_e22: 'unknown1',
  save: 'save',
  vox: 'vox',
  unknown_e25: 'unknown2',
  abr: 'abr',
  tdr: 'tdr',
  beep: 'beep',
  timeout: 'timeout',
  voice: 'voice',
  unknown_e2f: 'unknown4',
  dtmfst: 'dtmfst',
  unknown_e31: 'unknown5',
  unknown_e32: 'f12.unknown12',
  screv: 'f12.screv',
  pttid: 'pttid',
  pttlt: 'pttlt',
  mdfa: 'mdfa',
  mdfb: 'mdfb',
  bcl: 'bcl',
  autolk: 'autolk',
  sftd: 'sftd',
  wtled: 'wtled',
  rxled: 'rxled',
  txled: 'txled',
  almod: 'almod',
  band: 'band',
  tdrab: 'tdrab',
  ste: 'ste',
  rpste: 'rpste',
  rptrl: 'rptrl',
  ponmsg: 'ponmsg',
  roger: 'roger',
  rogerrx: 'rogerrx',
  tdrch: 'tdrch',
  displayab: 'f2a.displayab',
  unknown_e4a1: 'f2a.unknown7',
  fmradio: 'f2a.fmradio',
  alarm: 'f2a.alarm',
  unknown_e4a2: 'f2a.unknown8',
  reset: 'f2a.reset',
  menu: 'f2a.menu',
  unknown_e4b: 'f2b.unknown9',
  singleptt: 'f2b.singleptt',
  vfomrlock: 'f2b.vfomrlock',
  workmode: 'workmode',
  keylock: 'keylock',
}

/** The two byte runs `decodeSettings` deliberately leaves out of the map. */
export const SETTINGS_BYTE_RUNS: Readonly<Record<string, { readonly offset: number; readonly length: number }>> = {
  unknown_e2a: { offset: 0x0a, length: 4 },
  unknown_e3a: { offset: 0x1a, length: 3 },
}

/**
 * The control a CHIRP `get_settings` entry corresponds to.
 *
 * `settings.screv` is `f12.screv` here; `pttlt` is CHIRP's one setting named
 * without its struct, and `set_settings` resolves a bare name against the
 * settings struct, so it is the same byte.
 */
export function controlKeyFor(chirpName: string): string | null {
  const bare = chirpName.startsWith('settings.') ? chirpName.slice('settings.'.length) : chirpName === 'pttlt' ? 'pttlt' : null
  return bare === null ? null : (SETTINGS_KEYS[bare] ?? null)
}

/** Every offered control's key, from a schema. */
export function offeredKeys(schema: RadioSchema): string[] {
  return schema.settings.flatMap((g) => g.fields.map((f) => f.key))
}

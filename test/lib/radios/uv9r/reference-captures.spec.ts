// SPDX-License-Identifier: GPL-3.0-or-later
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { sha256Hex } from '#core/codec/checksum.js'
import { equalBytes } from '#core/codec/struct.js'
import type { RadioImage } from '#core/radio/image.js'
import { createDriver } from '#core/radio/registry.js'
import { decodeSettings, IDENT_UV9R } from '#core/radios/uv9r/driver.js'
import { SETTINGS_BASE } from '#core/radios/uv9r/layout.js'
import { IMAGE_SIZE } from '#core/radios/uv9r/protocol.js'
import { CHIRP_MAGIC } from '#core/io/chirp-img.js'
import { type ChirpChannel, expectSameChannel, SETTINGS_BYTE_RUNS, SETTINGS_KEYS } from './chirp-compare.js'

/**
 * Real UV-9R-family radios, checked against CHIRP - when they are here.
 *
 * Three captures of radios that answer the UV-9R's magic and send its ident:
 * a 2017 UV-9R and a factory UV-9R Pro, both uploaded to CHIRP's tracker by
 * their owners (issues 4511 and 9932), and CHIRP's own BF-A58S test image.
 * The first two are not this project's to redistribute, so none of them is
 * committed: `./scripts/fetch-reference.sh` puts them in the git-ignored
 * reference/ directory, and this spec skips when they are absent - which is
 * always, in CI. What is committed is CHIRP's reading of them,
 * uv9r-reference-chirp-decode.json, made by `dump-wp970i-family.py
 * decode-many` with CHIRP's own `UV9R` class.
 *
 * So it is the strongest evidence there is that this driver reads a real
 * UV-9R the way CHIRP does, and it is local. A capture whose bytes are not
 * the ones CHIRP was asked about fails loudly rather than skipping.
 */
const reference = (rel: string) => fileURLToPath(new URL(`../../../../reference/${rel}`, import.meta.url))
const CHIRP = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../../fixtures/uv9r-reference-chirp-decode.json', import.meta.url)), 'utf8'),
) as Record<string, { sha256: string; class: string; channels: Record<string, ChirpChannel>; settings: Record<string, number | number[]> }>

const CAPTURES: readonly { file: string; path: string; what: string }[] = [
  { file: 'Baofeng_UV-9R_20170301.img', path: 'chirp-tickets/Baofeng_UV-9R_20170301.img', what: 'a 2017 UV-9R' },
  { file: 'Baofeng_UV-9R_Pro_Factory.img', path: 'chirp-tickets/Baofeng_UV-9R_Pro_Factory.img', what: 'a factory UV-9R Pro' },
  { file: 'Baofeng_BF-A58S.img', path: 'chirp-images/Baofeng_BF-A58S.img', what: "CHIRP's BF-A58S" },
]

/** The memory of a CHIRP `.img`: trailer dropped, and the model name older builds appended after the ident. */
function memoryOf(data: Uint8Array): Uint8Array {
  let end = data.length
  outer: for (let i = data.length - CHIRP_MAGIC.length; i >= 0; i--) {
    for (let j = 0; j < CHIRP_MAGIC.length; j++) if (data[i + j] !== CHIRP_MAGIC[j]) continue outer
    end = i
    break
  }
  return data.slice(0, Math.min(end, IMAGE_SIZE))
}

const driver = createDriver('uv9r')

for (const capture of CAPTURES) {
  const path = reference(capture.path)
  describe.skipIf(!existsSync(path))(`${capture.what}, read as a UV-9R`, () => {
    const mem = existsSync(path) ? memoryOf(new Uint8Array(readFileSync(path))) : new Uint8Array(0)
    const theirs = CHIRP[capture.file]!
    const image: RadioImage = {
      radioId: 'uv9r',
      variant: '',
      layout: 'uv9r',
      createdAt: '2026-11-09T00:00:00.000Z',
      regions: [{ start: 0, data: mem, readOnly: false, label: 'image' }],
      meta: {},
      sha256: '',
    }

    it('is the capture CHIRP was asked about', async () => {
      expect(mem.length).toBe(IMAGE_SIZE)
      expect(await sha256Hex(mem)).toBe(theirs.sha256)
      expect([...mem.subarray(0x2000)]).toEqual([...IDENT_UV9R])
    })

    it('decodes every channel the way CHIRP does', () => {
      const cp = driver.decode(image)
      expect([...cp.channels.keys()].sort((a, b) => a - b)).toEqual(
        Object.keys(theirs.channels).map(Number).sort((a, b) => a - b),
      )
      for (const [index, ch] of Object.entries(theirs.channels)) {
        expectSameChannel(cp.channels.get(Number(index)), ch, Number(index))
      }
    })

    it('reads the settings struct the way CHIRP does', () => {
      const mine = decodeSettings(mem)
      for (const [name, value] of Object.entries(theirs.settings)) {
        const run = SETTINGS_BYTE_RUNS[name]
        if (run) {
          expect([...mem.subarray(SETTINGS_BASE + run.offset, SETTINGS_BASE + run.offset + run.length)], name).toEqual(value)
        } else {
          expect(mine[SETTINGS_KEYS[name]!], name).toBe(value)
        }
      }
    })

    it('round-trips byte for byte', () => {
      const out = driver.encode(driver.decode(image), image).regions[0]!.data
      expect(equalBytes(out, mem)).toBe(true)
    })
  })
}

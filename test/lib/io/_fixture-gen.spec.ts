// SPDX-License-Identifier: GPL-3.0-or-later
import { writeFileSync } from 'node:fs'
import { describe, it } from 'vitest'
import { encodeBwp } from '#core/io/bwp.js'
import { CHIRP_ATTRS, CHIRP_CHANNELS, buildEeprom, imageFrom, type FixtureChannel } from '../radios/uvk5/fixture.js'

/**
 * Generates a realistic 200-channel image for manual UI checks: the channel
 * table's virtualisation, the diagnostics summary and the receive-only styling
 * are all things you have to look at rather than assert.
 *
 * Skipped unless BOOFWANG_FIXTURE is set, so a normal run writes nothing.
 *
 *     BOOFWANG_FIXTURE=1 pnpm vitest run test/lib/io/_fixture-gen.spec.ts
 *     cp /tmp/boofwang-fixture.bwp public/   # then open it in the running app
 */
describe.skipIf(!process.env.BOOFWANG_FIXTURE)('fixture generation', () => {
  it('writes a full 200-channel .bwp', async () => {
    const kinds = Object.values(CHIRP_CHANNELS)
    const attrs = Object.values(CHIRP_ATTRS)
    const names = ['CALLING', 'W4ABC', 'UHF RPT', 'WX3', 'GUARD', 'DTCSR', 'EXTRAS', 'SIMPLEX', 'REPEATER', 'SCAN']

    const channels: FixtureChannel[] = []
    for (let i = 0; i < 200; i++) {
      channels.push({
        slot: i,
        record: kinds[i % kinds.length]!,
        name: `${names[i % names.length]}${String(i + 1).padStart(3, '0')}`.slice(0, 10),
        attr: attrs[i % attrs.length]!,
      })
    }
    // A couple of VFO pseudo-channels too.
    channels.push({ slot: 200, record: CHIRP_CHANNELS.SIMPLEX })
    channels.push({ slot: 205, record: CHIRP_CHANNELS.AIR_AM })

    const image = imageFrom(buildEeprom(channels))
    writeFileSync('/tmp/boofwang-fixture.bwp', await encodeBwp(image))
  })
})

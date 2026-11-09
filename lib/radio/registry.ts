// SPDX-License-Identifier: GPL-3.0-or-later
import type { RadioId } from '../model/codeplug.js'
import { createDm32uvDriver } from '../radios/dm32uv/driver.js'
import { createUv82Driver } from '../radios/uv82/driver.js'
import { createUv5gDriver } from '../radios/uv5g/driver.js'
import { createUv5rDriver } from '../radios/uv5r/driver.js'
import { createUv5rMiniDriver } from '../radios/uv5rmini/driver.js'
import { createUvk5Driver } from '../radios/uvk5/driver.js'
import { createUv9rDriver } from '../radios/uv9r/driver.js'
import { createUv9gDriver } from '../radios/uv9g/driver.js'
import type { RadioDriver } from './driver.js'
import type { RadioSchema } from './schema.js'

/**
 * Every radio boofwang knows about.
 *
 * Adding one should mean a new folder under `lib/radios/` and a line here -
 * nothing under `app/`. If a new radio forces a UI change, the RadioSchema is
 * missing something, and that is the thing to fix.
 */

export const DRIVER_FACTORIES: Record<RadioId, (() => RadioDriver) | null> = {
  // Writing is enabled. The encoder round-trips a real radio's EEPROM byte for
  // byte, the write path survived an adversarial review, and every block is
  // read back and compared before the next is sent - but see
  // docs/protocols/uvk5.md for exactly which parts have been exercised against
  // hardware and which have not.
  uvk5: () => createUvk5Driver({ enableWrite: true }),
  // Writing is enabled and deliberately narrow: the channel records, the
  // settings block and the name table, sent as the 16-byte blocks that differ
  // from the base, once the radio has been read and found still to hold it.
  // The two windows CHIRP has always skipped fall outside all three, so a
  // diff-driven write cannot reach them. The unit and base checks that came
  // after the bench session (2026-11-09) add four reads to every write and 66
  // to an edit, none of which that session sent. See docs/protocols/uv82.md.
  uv82: () => createUv82Driver({ enableWrite: true }),
  // The UV-82's driver behind a different ident magic: CHIRP's
  // RadioddityUV5GRadio is a bare subclass of BaofengUV5R and this mirrors it.
  // Writing is enabled after a verified session on the bench radio (firmware
  // HN5RV011): rename, write, independent read showing exactly five bytes
  // moved, restore to the original sha256. The unit and base checks added
  // since (2026-11-09) read four blocks on every write and 66 more on an edit,
  // none of which that session sent. See docs/protocols/uv5g.md.
  uv5g: () => createUv5gDriver({ enableWrite: true }),
  // Writing is enabled, and deliberately scoped: channel records, zone names,
  // talk groups and the key slots, sent as whole 4 KiB pages. This radio's
  // pages move between sessions and 22 of its 59 allocated blocks have no
  // documented meaning, so every other byte is read, preserved and never sent
  // back. See docs/protocols/dm32uv.md.
  dm32uv: () => createDm32uvDriver({ enableWrite: true }),
  // Writing is enabled after a bench session on 2026-09-05 that had to settle
  // three things first. This radio cannot reprogram a byte, so the family's
  // diff-driven write could not shorten a name and left the tail of the old one
  // behind - it takes `writesWholeImage` and CHIRP's contiguous sweep. Its
  // read-back verification was reading the wrong memory, because a 0x10 read
  // here returns another block's bytes while echoing the address asked for;
  // verification reads 0x40 windows now, which is what the read path always
  // used. And its firmware reports the ambiguous `N5RV`, which names this radio
  // and a tri-power BF-F8HP alike, so `writeImage` decodes and re-encodes what
  // the radio sent and refuses if a byte moves rather than trusting the string.
  // Rename, sweep, verify, fresh read and restore to the original sha256 all
  // passed on the bench unit. The unit and base checks added since
  // (2026-11-09) read four blocks on every write and 66 more before an edit's
  // sweep, none of which that session sent. See docs/protocols/uv5r.md.
  uv5r: () => createUv5rDriver({ enableWrite: true }),
  // A UV-17 Pro family radio despite the name: 115200 baud, obfuscated 64-byte
  // blocks. Writing sends the WHOLE image every time - this radio erases a
  // flash page before programming and writes back only the block it was handed,
  // so a sparse write wipes everything sharing that page. It erased 19 channels
  // on a real radio before that was understood. See docs/protocols/uv5rmini.md.
  uv5rmini: () => createUv5rMiniDriver({ enableWrite: true }),
  // Writing is enabled WITHOUT a boofwang bench session, and this family is the
  // only one in the registry where that is true. The project owner asked for
  // full support with no UV-9R to test on, so the evidence is CHIRP's instead
  // of ours: CHIRP's maintainer reports CHIRP downloading and uploading a
  // UV-9R, a UV-9G and a UV-9R Pro (CHIRP issue 10270, 2023-11-30), and this
  // driver sends what CHIRP's upload sends - the same frames, the same 50 ms
  // pacing, a contiguous sweep of the owned ranges rather than a diff - inside
  // spans CHIRP itself writes. It reads more first: 73 blocks before an edit's
  // first frame where CHIRP reads six, to hold the backup, the image and the
  // base to the radio (2026-11-09). It reaches channel records, names and the
  // settings block, nothing else; only on an ident a captured UV-9R has sent
  // with an empty firmware window; only with a backup of this physical unit;
  // and every block is read back at the read path's block size before the write
  // is called done. The decoder agrees with CHIRP's own classes field for field
  // on four real images of the family. What no one has done is run
  // test/hardware/uv9r.spec.ts on a radio - see docs/protocols/uv9r.md.
  uv9r: () => createUv9rDriver({ enableWrite: true }),
  // The UV-9G: the same family behind its own magic, enabled on the same
  // terms - CHIRP's maintainer's report covers it too - with its decode
  // checked against CHIRP on CHIRP's own UV-9G test image. See
  // docs/protocols/uv9g.md.
  uv9g: () => createUv9gDriver({ enableWrite: true }),
}

export const SCHEMAS: Record<RadioId, RadioSchema | null> = {
  // The schema the UI renders must match what the driver enforces.
  uvk5: createUvk5Driver({ enableWrite: true }).schema,
  uv82: createUv82Driver({ enableWrite: true }).schema,
  uv5g: createUv5gDriver({ enableWrite: true }).schema,
  uv5r: createUv5rDriver({ enableWrite: true }).schema,
  dm32uv: createDm32uvDriver({ enableWrite: true }).schema,
  uv5rmini: createUv5rMiniDriver({ enableWrite: true }).schema,
  uv9r: createUv9rDriver({ enableWrite: true }).schema,
  uv9g: createUv9gDriver({ enableWrite: true }).schema,
}

export const RADIO_IDS: readonly RadioId[] = ['uvk5', 'uv82', 'uv5g', 'uv5r', 'uv5rmini', 'dm32uv', 'uv9r', 'uv9g']

export function createDriver(id: RadioId): RadioDriver {
  const factory = DRIVER_FACTORIES[id]
  if (!factory) throw new Error(`No driver is implemented for ${id} yet`)
  return factory()
}

export function isImplemented(id: RadioId): boolean {
  return DRIVER_FACTORIES[id] !== null
}

export const IMPLEMENTED_DRIVERS: readonly RadioId[] = RADIO_IDS.filter(isImplemented)

/**
 * Drivers ordered by how well a connected USB device matches them.
 *
 * A hint for ordering the port picker, never an identification: the CH340 in a
 * typical programming cable is in countless unrelated devices, so the handshake
 * is what actually decides.
 */
export function rankByUsb(info: { usbVendorId?: number; usbProductId?: number }): RadioDriver[] {
  const rank = { likely: 0, possible: 1, no: 2 } as const
  return IMPLEMENTED_DRIVERS.map(createDriver)
    .map((d) => ({ d, r: rank[d.match(info)] }))
    .filter((x) => x.r < 2)
    .sort((a, b) => a.r - b.r)
    .map((x) => x.d)
}

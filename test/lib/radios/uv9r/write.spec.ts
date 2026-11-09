// SPDX-License-Identifier: GPL-3.0-or-later
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { equalBytes } from '#core/codec/struct.js'
import {
  BackupRequiredError,
  DriverError,
  WriteBlockedError,
  WriteVerifyError,
  type BackupRef,
  type IdentifyResult,
  type RadioDriver,
} from '#core/radio/driver.js'
import { blocksToSend, diffImages } from '#core/radio/diff.js'
import type { RadioImage } from '#core/radio/image.js'
import { createDriver } from '#core/radio/registry.js'
import {
  IDENT_UV9R,
  createUv9rDriver,
  createWp970iFamilyDriver,
} from '#core/radios/uv9r/driver.js'
import { channelAddr, nameAddr, ownedRanges } from '#core/radios/uv9r/layout.js'
import { CHIRP_UPLOAD_RANGES, MAGIC_WP970I, MEM_SIZE, WRITE_BLOCK_SIZE } from '#core/radios/uv9r/protocol.js'
import { UV9R_SCHEMA } from '#core/radios/uv9r/schema.js'
import { type AckModel, drive, fakeRadio, type FakeRadio } from './fake-radio.js'

/**
 * The WP970I family's write path, against a scripted radio.
 *
 * The registry builds this family with writing on, without a boofwang bench
 * session behind it, so these specs are most of what stands between the
 * write path and a real radio: the refusals, the shape of what is sent, the
 * pacing, and the read-back. None of it is evidence that a real UV-9R stores
 * what it is sent - that is test/hardware/uv9r.spec.ts's job, and it has not
 * been run.
 */
const RAW = new Uint8Array(
  readFileSync(fileURLToPath(new URL('../../../fixtures/images/uv9r-chirp-synthetic.bin', import.meta.url))),
)
const MEMORY = RAW.slice(0, MEM_SIZE)

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

// What the registry builds.
const writable = createDriver('uv9r')
// Every owned block: what a sweep sends. 128 channel records, three settings
// blocks, 128 name records.
const OWNED_BLOCKS = ownedRanges().flatMap(([a, b]) =>
  Array.from({ length: (b - a) / WRITE_BLOCK_SIZE }, (_, i) => a + i * WRITE_BLOCK_SIZE),
)
const MODELS: readonly AckModel[] = ['answers-host-ack', 'acks-each-read']

interface Session {
  radio: FakeRadio
  ident: IdentifyResult
  baseline: RadioImage
  backup: BackupRef
}

async function session(
  memory: Uint8Array = MEMORY,
  opts: { ackModel?: AckModel; ident?: Uint8Array; ignoreWritesAt?: number; driver?: RadioDriver } = {},
): Promise<Session> {
  const driver = opts.driver ?? writable
  const radio = fakeRadio(memory, {
    magic: MAGIC_WP970I,
    ident: opts.ident ?? IDENT_UV9R,
    ...(opts.ackModel ? { ackModel: opts.ackModel } : {}),
    ...(opts.ignoreWritesAt === undefined ? {} : { ignoreWritesAt: opts.ignoreWritesAt }),
  })
  const ident = await drive(driver.identify(radio.transport, {}))
  const baseline = await drive(driver.readImage(radio.transport, ident, {}))
  const backup: BackupRef = {
    id: 'bench',
    identHash: ident.identHash,
    createdAt: baseline.createdAt,
    unitHash: await driver.unitFingerprint(baseline),
  }
  return { radio, ident, baseline, backup }
}

function renamed(base: RadioImage, slot: number, name: string, driver: RadioDriver = writable): RadioImage {
  const doc = driver.decode(base)
  const ch = doc.channels.get(slot)!
  doc.channels.set(slot, { ...ch, name })
  return driver.encode(doc, base)
}

const memOf = (img: RadioImage) => img.regions[0]!.data

describe('the gate', () => {
  it('is shut in a build that does not enable it, and says so by name', async () => {
    // The seam that keeps a driver built for a test or a file import off a
    // radio: only the registry passes `enableWrite`.
    const s = await session()
    const unwritable = createUv9rDriver()
    await expect(
      drive(unwritable.writeImage(s.radio.transport, s.baseline, { backup: s.backup, ident: s.ident })),
    ).rejects.toThrow(/Writing the UV-9R is not enabled in this build/)
    expect(s.radio.writes).toHaveLength(0)
  })

  it('refuses without a backup', async () => {
    const s = await session()
    await expect(drive(writable.writeImage(s.radio.transport, s.baseline, { ident: s.ident }))).rejects.toThrow(
      BackupRequiredError,
    )
  })

  it("refuses another radio's image before touching the port", async () => {
    await expect(
      writable.writeImage({} as never, { ...renamed(createImage(), 1, 'X'), radioId: 'uv9g' }, {
        backup: { id: 'b', identHash: 'x', createdAt: '' },
      }),
    ).rejects.toThrow(DriverError)
  })

  it('refuses a backup that cannot say which radio it came from', async () => {
    const s = await session()
    const { unitHash: _gone, ...old } = s.backup
    await expect(
      drive(writable.writeImage(s.radio.transport, renamed(s.baseline, 1, 'BOOF'), { backup: old, baseImage: s.baseline, ident: s.ident })),
    ).rejects.toThrow(/carries no record of which UV-9R/)
    expect(s.radio.writes).toHaveLength(0)
  })

  it('refuses a backup of a different unit, even of the same model and firmware', async () => {
    // Two radios with the same ident and the same empty firmware window hash
    // identically - which is every UV-9R anyone has bytes from. Only the
    // per-unit spans tell them apart.
    const s = await session()
    const other = MEMORY.slice()
    other[0x1f10] = other[0x1f10]! ^ 0x01
    const t = await session(other)
    await expect(
      drive(writable.writeImage(t.radio.transport, renamed(t.baseline, 1, 'BOOF'), { backup: s.backup, baseImage: t.baseline, ident: t.ident })),
    ).rejects.toThrow(/came from a different UV-9R/)
    expect(t.radio.writes).toHaveLength(0)
  })

  it('refuses a base image read from a different unit', async () => {
    const s = await session()
    const foreign = memOf(s.baseline).slice()
    foreign[0x1f20] = foreign[0x1f20]! ^ 0x01
    const base: RadioImage = { ...s.baseline, regions: [{ ...s.baseline.regions[0]!, data: foreign }] }
    await expect(
      drive(writable.writeImage(s.radio.transport, renamed(base, 1, 'BOOF'), { backup: s.backup, baseImage: base, ident: s.ident })),
    ).rejects.toThrow(/read from a different UV-9R/)
    expect(s.radio.writes).toHaveLength(0)
  })

  it("refuses to restore another unit's image, whatever backup reference comes with it", async () => {
    // The screen that restores passes the image's own fingerprint as the
    // backup's, which would catch this - but the driver is what enforces. A
    // genuine backup reference for this radio and an image from another one
    // used to come back written and verified.
    const s = await session()
    const foreign = memOf(s.baseline).slice()
    foreign[0x1f30] = foreign[0x1f30]! ^ 0x01
    const image: RadioImage = { ...s.baseline, regions: [{ ...s.baseline.regions[0]!, data: foreign }] }
    await expect(drive(writable.writeImage(s.radio.transport, image, { backup: s.backup, ident: s.ident }))).rejects.toThrow(
      /read from a different UV-9R than the one on the cable/,
    )
    expect(s.radio.writes).toHaveLength(0)
  })

  it('restores a radio holding bytes this build cannot round-trip', async () => {
    // Another program left a record of zeros: no empty marker, a receive
    // frequency of 0 Hz. An edit built on that is refused, but a restore
    // sends the backup's own bytes and must still put the radio back.
    const s = await session()
    const odd = MEMORY.slice()
    odd.fill(0x00, channelAddr(40), channelAddr(40) + 16)
    const t = await session(odd)
    const report = await drive(
      writable.writeImage(t.radio.transport, s.baseline, {
        backup: { ...t.backup, unitHash: await writable.unitFingerprint(s.baseline) },
        ident: t.ident,
      }),
    )
    expect(report.verified).toBe(true)
    expect(t.radio.writes.map((w) => w.addr)).toEqual(OWNED_BLOCKS)
    expect(equalBytes(t.radio.memory, MEMORY)).toBe(true)
  })

  it('refuses a radio whose ident no captured UV-9R has sent', async () => {
    const s = await session(MEMORY, { ident: Uint8Array.from([0xaa, 1, 2, 3, 4, 5, 6, 0xdd]) })
    expect(s.ident.caps.write).toBe(false)
    await expect(
      drive(writable.writeImage(s.radio.transport, renamed(s.baseline, 1, 'BOOF'), { backup: s.backup, baseImage: s.baseline, ident: s.ident })),
    ).rejects.toThrow(WriteBlockedError)
    expect(s.radio.writes).toHaveLength(0)
  })

  it('refuses a radio whose own bytes do not survive a decode and re-encode', async () => {
    // A record whose first byte is not the empty marker but whose receive
    // frequency is zero: it decodes as no channel, and re-encoding it would
    // stamp the marker in. A radio holding that is one this build does not
    // understand, so nothing is sent.
    const odd = MEMORY.slice()
    odd.fill(0x00, channelAddr(40), channelAddr(40) + 16)
    const s = await session(odd)
    await expect(
      drive(writable.writeImage(s.radio.transport, renamed(s.baseline, 1, 'BOOF'), { backup: s.backup, baseImage: s.baseline, ident: s.ident })),
    ).rejects.toThrow(/does not round-trip/)
    expect(s.radio.writes).toHaveLength(0)
  })

  it('refuses an image whose encoder moved a byte it does not own', async () => {
    const s = await session()
    const edited = renamed(s.baseline, 1, 'BOOF')
    // The VFO A frequency: read, never written, so a change there is a bug.
    memOf(edited)[0x0f08] = memOf(edited)[0x0f08]! ^ 0x01
    await expect(
      drive(writable.writeImage(s.radio.transport, edited, { backup: s.backup, baseImage: s.baseline, ident: s.ident })),
    ).rejects.toThrow(/defect in boofwang/)
    expect(s.radio.writes).toHaveLength(0)
  })
})

describe.each(MODELS)('writing, when the radio %s', (ackModel) => {
  it('writes nothing when the radio already holds the image', async () => {
    const s = await session(MEMORY, { ackModel })
    const report = await drive(
      writable.writeImage(s.radio.transport, s.baseline, { backup: s.backup, baseImage: s.baseline, ident: s.ident }),
    )
    expect(report.blocksWritten).toBe(0)
    expect(s.radio.writes).toHaveLength(0)
  })

  it('sends a rename as a sweep of every owned block, in order, and reads it back', async () => {
    const s = await session(MEMORY, { ackModel })
    const edited = renamed(s.baseline, 1, 'BOOF')
    const report = await drive(
      writable.writeImage(s.radio.transport, edited, { backup: s.backup, baseImage: s.baseline, ident: s.ident }),
    )
    // CHIRP's shape, not a diff: all 259 owned blocks go, the way `_upload`
    // sends contiguous ranges. Radio addresses with nothing added - this
    // family's image has no prefix.
    expect(report).toMatchObject({
      blocksWritten: OWNED_BLOCKS.length,
      bytesWritten: OWNED_BLOCKS.length * WRITE_BLOCK_SIZE,
      verified: true,
    })
    expect(OWNED_BLOCKS).toHaveLength(259)
    expect(s.radio.writes.map((w) => w.addr)).toEqual(OWNED_BLOCKS)
    expect(equalBytes(s.radio.memory, memOf(edited).subarray(0, MEM_SIZE))).toBe(true)

    // And a fresh session sees the rename and nothing else.
    const fresh = await session(s.radio.memory, { ackModel })
    const before = memOf(s.baseline)
    const after = memOf(fresh.baseline)
    const moved = [...after].flatMap((b, i) => (b === before[i] ? [] : [i]))
    expect(moved.length).toBeGreaterThan(0)
    for (const at of moved) expect(at >= nameAddr(0) && at < nameAddr(0) + 7, `0x${at.toString(16)}`).toBe(true)
    expect(writable.decode(fresh.baseline).channels.get(1)!.name).toBe('BOOF')
  })

  it('restores through the read-first path, as a sweep', async () => {
    const s = await session(MEMORY, { ackModel })
    const drifted = MEMORY.slice()
    drifted[0x0e20] = 0x09 // squelch, from the keypad
    const t = await session(drifted, { ackModel })
    const report = await drive(
      writable.writeImage(t.radio.transport, s.baseline, {
        backup: { ...t.backup, unitHash: await writable.unitFingerprint(s.baseline) },
        ident: t.ident,
      }),
    )
    expect(report.verified).toBe(true)
    expect(t.radio.writes.map((w) => w.addr)).toEqual(OWNED_BLOCKS)
    expect(t.radio.memory[0x0e20]).toBe(MEMORY[0x0e20])
    expect(equalBytes(t.radio.memory, MEMORY)).toBe(true)
  })

  it('leaves what it does not own as the radio has it, on a restore', async () => {
    // The VFO A frequency has moved since the backup - a radio in use - and a
    // restore writes channels, names and settings only. It is not a defect
    // that the VFO differs; it is the scope of this driver's writes.
    const tuned = MEMORY.slice()
    tuned[0x0f09] = tuned[0x0f09]! ^ 0x01
    const t = await session(tuned, { ackModel })
    const report = await drive(
      writable.writeImage(t.radio.transport, renamed(createImage(), 1, 'BOOF'), {
        backup: { ...t.backup, unitHash: await writable.unitFingerprint(createImage()) },
        ident: t.ident,
      }),
    )
    expect(report.verified).toBe(true)
    expect(t.radio.writes.map((w) => w.addr)).toEqual(OWNED_BLOCKS)
    expect(t.radio.memory[0x0f09]).toBe(tuned[0x0f09])
    expect(writable.decode({ ...createImage(), regions: [{ start: 0, data: Uint8Array.from([...t.radio.memory, ...IDENT_UV9R]), label: 'image' }] }).channels.get(1)!.name).toBe('BOOF')
  })

  it("paces its frames as CHIRP's upload does, 50 ms apart at least", async () => {
    // Under the reading where an acknowledgment is always already waiting,
    // reading it paces nothing; only the pause does. It was missing until an
    // adversarial review compared the loop with `_upload`.
    const s = await session(MEMORY, { ackModel })
    const doc = writable.decode(s.baseline)
    for (const index of [1, 2, 3]) doc.channels.set(index, { ...doc.channels.get(index)!, name: `P${index}` })
    await drive(
      writable.writeImage(s.radio.transport, writable.encode(doc, s.baseline), {
        backup: s.backup,
        baseImage: s.baseline,
        ident: s.ident,
      }),
    )
    expect(s.radio.writes.length).toBeGreaterThanOrEqual(2)
    for (let i = 1; i < s.radio.writes.length; i++) {
      expect(s.radio.writes[i]!.at - s.radio.writes[i - 1]!.at).toBeGreaterThanOrEqual(50)
    }
  })

  it('reports a block the radio did not store, with the bytes', async () => {
    const s = await session(MEMORY, { ackModel, ignoreWritesAt: nameAddr(0) })
    const failure = drive(
      writable.writeImage(s.radio.transport, renamed(s.baseline, 1, 'BOOF'), {
        backup: s.backup,
        baseImage: s.baseline,
        ident: s.ident,
      }),
    )
    await expect(failure).rejects.toThrow(WriteVerifyError)
    await expect(failure).rejects.toThrow(/sent: {6}42 4f 4f 46/)
  })
})

describe('what a write can reach', () => {
  it('stays inside the owned ranges and inside what CHIRP uploads, block by block', async () => {
    const s = await session()
    const doc = writable.decode(s.baseline)
    // A wide edit: every channel renamed and one setting changed.
    for (const [index, ch] of doc.channels) doc.channels.set(index, { ...ch, name: `C${index}` })
    doc.settings.squelch = 7
    const edited = writable.encode(doc, s.baseline)
    await drive(writable.writeImage(s.radio.transport, edited, { backup: s.backup, baseImage: s.baseline, ident: s.ident }))
    expect(s.radio.writes.length).toBeGreaterThan(20)
    for (const w of s.radio.writes) {
      const to = w.addr + w.data.length
      expect(ownedRanges().some(([a, b]) => w.addr >= a && to <= b), `0x${w.addr.toString(16)}`).toBe(true)
      expect(CHIRP_UPLOAD_RANGES.some(([a, b]) => w.addr >= a && to <= b), `0x${w.addr.toString(16)}`).toBe(true)
    }
  })

  it('is confirmed as the blocks it sends, not as the image', async () => {
    /*
     * The write page and the fleet run count a write with `blocksToSend`, and
     * for a radio that sweeps it used to count the image: 513 blocks and
     * 8,208 bytes, against 259 blocks sent. That count is what the user
     * agrees to, and the page repeats it afterwards as what was sent.
     */
    const s = await session()
    const edited = renamed(s.baseline, 1, 'BOOF')
    const promised = blocksToSend({
      diff: diffImages(s.baseline, edited, writable),
      image: s.baseline,
      driver: writable,
      wholeImage: writable.schema.capabilities.writesWholeImage === true,
    })
    await drive(writable.writeImage(s.radio.transport, edited, { backup: s.backup, baseImage: s.baseline, ident: s.ident }))
    expect(promised).toBe(259)
    expect(promised).toBe(s.radio.writes.length)
    expect(promised * writable.writeBlockBytes).toBe(s.radio.writes.reduce((n, w) => n + w.data.length, 0))
  })

  it('reports a dry run without sending anything', async () => {
    const s = await session()
    const report = await drive(
      writable.writeImage(s.radio.transport, renamed(s.baseline, 1, 'BOOF'), {
        backup: s.backup,
        baseImage: s.baseline,
        ident: s.ident,
        dryRun: true,
      }),
    )
    expect(report).toMatchObject({ dryRun: true, blocksWritten: OWNED_BLOCKS.length, verified: false })
    expect(s.radio.writes).toHaveLength(0)
  })

  it('sends only what changed when a member does not sweep', async () => {
    // Every member sweeps today, because CHIRP does. A bench session may show
    // a diff is safe on this radio, as it is on the UV-82, and the switch back
    // has to work when it is thrown.
    const diffing = createWp970iFamilyDriver(
      {
        id: 'uv9r',
        label: 'UV-9R',
        magics: [MAGIC_WP970I],
        schema: { ...UV9R_SCHEMA, capabilities: { ...UV9R_SCHEMA.capabilities, writesWholeImage: false } },
        knownIdents: [IDENT_UV9R],
      },
      { enableWrite: true },
    )
    const s = await session(MEMORY, { driver: diffing })
    const report = await drive(
      diffing.writeImage(s.radio.transport, renamed(s.baseline, 1, 'BOOF', diffing), {
        backup: s.backup,
        baseImage: s.baseline,
        ident: s.ident,
      }),
    )
    expect(report).toMatchObject({ blocksWritten: 1, verified: true })
    expect(s.radio.writes.map((w) => w.addr)).toEqual([nameAddr(0)])
  })

  it('sends nothing at all when no owned block changed, sweep or not', async () => {
    const s = await session()
    const report = await drive(
      writable.writeImage(s.radio.transport, s.baseline, { backup: s.backup, baseImage: s.baseline, ident: s.ident }),
    )
    expect(report.blocksWritten).toBe(0)
    expect(s.radio.writes).toHaveLength(0)
  })
})

function createImage(): RadioImage {
  return {
    radioId: 'uv9r',
    variant: '',
    layout: 'uv9r',
    createdAt: '2026-11-09T00:00:00.000Z',
    regions: [{ start: 0, data: RAW.slice(), readOnly: false, label: 'image' }],
    meta: {},
    sha256: '',
  }
}

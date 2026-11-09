// SPDX-License-Identifier: GPL-3.0-or-later
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'
import { equalBytes } from '#core/codec/struct.js'
import {
  BackupRequiredError,
  DriverError,
  RadioChangedError,
  WriteBlockedError,
  type BackupRef,
} from '#core/radio/driver.js'
import type { RadioImage } from '#core/radio/image.js'
import { createUv5gDriver } from '#core/radios/uv5g/driver.js'
import { MAGIC_UV5G } from '#core/radios/uv5g/protocol.js'
import { unitHashOf } from '#core/radios/uv82/driver.js'
import {
  REGIONS,
  SETTINGS_BASE,
  UNIT_AREAS,
  channelAddr,
  nameAddr,
  ownedRanges,
} from '#core/radios/uv82/layout.js'
import { AUX_START, IDENT_SIZE, MAIN_SIZE } from '#core/radios/uv82/protocol.js'

/**
 * What the UV-5G changes about the shared family driver, exercised end to end.
 *
 * The write machinery itself - diffing, the owned-range refusals, the
 * read-back verification, receive-only marker handling - is the uv82 module's
 * and is tested there on the same code paths this driver runs. What this file
 * pins is everything that is different behind this radio's magic: the
 * handshake, the firmware classification, and the driver speaking its own
 * name.
 */
const fixture = (name: string) =>
  new Uint8Array(readFileSync(fileURLToPath(new URL(`../../../fixtures/images/${name}`, import.meta.url))))
const RAW = fixture('uv5g-HN5RV011.bin')

function image(bytes: Uint8Array = RAW): RadioImage {
  return {
    radioId: 'uv5g',
    variant: 'HN5RV011',
    layout: 'uv5g',
    createdAt: '2026-08-30T00:00:00.000Z',
    regions: REGIONS.map((r) => ({
      start: r.start,
      data: bytes.slice(r.start, r.start + r.length),
      label: r.label,
      readOnly: r.readOnly,
    })),
    meta: {},
    sha256: '',
  }
}

/**
 * Another UV-5G: the same codeplug, calibrated one step differently.
 *
 * One byte in the first span is the smallest difference two units can have,
 * which makes it the honest test of a check meant to tell them apart.
 */
function otherUnit(): Uint8Array {
  const other = RAW.slice()
  const at = UNIT_AREAS[0]![0]
  other[at] = other[at]! ^ 0x01
  return other
}

const driver = createUv5gDriver()
const writable = createUv5gDriver({ enableWrite: true })

/** The session's identification, so a write starts past the handshake. */
const ident = {
  radioId: 'uv5g' as const,
  variant: 'HN5RV011',
  layout: 'uv5g',
  raw: new Uint8Array(0),
  caps: { read: true, write: true },
  identHash: 'match',
}

/**
 * The reads a write with a base makes to hold that base to the radio: every
 * 0x40 window the channel records, the settings and the names touch, in
 * address order. Sixty-six of them.
 */
const OWNED_WINDOW_READS = [
  ...Array.from({ length: 32 }, (_, i) => i * 0x40),
  0x0e00,
  0x0e40,
  ...Array.from({ length: 32 }, (_, i) => 0x1000 + i * 0x40),
].map((a) => `read ${a.toString(16)}/40`)

/**
 * A radio that answers the classic protocol behind the UV-5G's magic.
 *
 * The magic arrives one byte at a time; a full match earns the 0x06. The
 * firmware probe's first block skips the leading acknowledgment - CHIRP's
 * `first_command` - and every read after it takes one, which is exactly the
 * flow a real UV-82 broke when it was got wrong.
 */
function radio(contents: Uint8Array, opts: { refuseFirstMagic?: boolean } = {}) {
  const out: number[] = []
  let magicBuf: number[] = []
  let magicAttempts = 0
  let identified = false
  const sent: { addr: number; data: Uint8Array }[] = []
  // Every block asked for and every block sent, in the order the radio saw
  // them, so a test can hold the whole conversation to what it should be.
  const wire: string[] = []
  return {
    sent,
    wire,
    async write(cmd: Uint8Array) {
      if (cmd.length === 1) {
        const b = cmd[0]!
        /*
         * Magic bytes first, control bytes after. The magic itself contains
         * 0x06 at index five, so a stub that answers every lone 0x06 with an
         * acknowledgment acks its own magic mid-stream - which is exactly
         * how the first version of this stub passed identify without ever
         * comparing a byte of it.
         */
        if (identified) {
          if (b === 0x02) out.push(...contents.subarray(0, IDENT_SIZE))
          if (b === 0x06) out.push(0x06)
          return
        }
        magicBuf.push(b)
        if (magicBuf.length === MAGIC_UV5G.length) {
          const ok = magicBuf.every((x, i) => x === MAGIC_UV5G[i])
          magicBuf = []
          magicAttempts++
          if (!ok) return
          // The bench unit's first-contact behavior: 0xfe to the first
          // magic after sitting idle, an acknowledgment to the next.
          if (opts.refuseFirstMagic && magicAttempts === 1) {
            out.push(0xfe)
          } else {
            out.push(0x06)
            identified = true
          }
        }
        return
      }
      if (cmd[0] === 0x53) {
        const addr = (cmd[1]! << 8) | cmd[2]!
        const size = cmd[3]!
        wire.push(`read ${addr.toString(16)}/${size.toString(16)}`)
        // The 0x1E80 warm-up block is the only one ever requested with the
        // leading acknowledgment skipped, so it is the only one that must not
        // send it.
        if (addr !== 0x1e80) out.push(0x06)
        out.push(0x58, cmd[1]!, cmd[2]!, cmd[3]!)
        for (let i = 0; i < size; i++) {
          const a = addr + i
          // Main block, then the aux area; the 0x1E80 warm-up block sits in
          // neither and reads as erased flash.
          const off = a < MAIN_SIZE ? IDENT_SIZE + a : a >= AUX_START ? IDENT_SIZE + MAIN_SIZE + (a - AUX_START) : -1
          out.push(off >= 0 && off < contents.length ? contents[off]! : 0xff)
        }
        return
      }
      if (cmd[0] === 0x58) {
        const addr = (cmd[1]! << 8) | cmd[2]!
        wire.push(`write ${addr.toString(16)}/${cmd[3]!.toString(16)}`)
        sent.push({ addr, data: cmd.slice(4) })
        contents.set(cmd.slice(4), IDENT_SIZE + addr)
        out.push(0x06)
      }
    },
    async readExactly(n: number) {
      if (out.length < n) throw new Error(`the radio has only ${out.length} byte(s), ${n} wanted`)
      return Uint8Array.from(out.splice(0, n))
    },
    // identify() drains the line before the magic; a fake has nothing stale.
    async resync() {
      return Uint8Array.from(out.splice(0, out.length))
    },
    peekHex: () => out.slice(0, 16).map((b) => b.toString(16).padStart(2, '0')).join(' '),
  } as never
}

describe('identify, over the wire', () => {
  it('acknowledges the UV-5G magic and reads the firmware behind it', async () => {
    const ident = await writable.identify(radio(RAW.slice()), {})
    expect(ident.radioId).toBe('uv5g')
    expect(ident.variant).toBe('HN5RV011')
    expect(ident.layout).toBe('uv5g')
    expect([...ident.raw]).toEqual([0xaa, 0x44, 0x46, 0x04, 0x00, 0x04, 0x70, 0xdd])
    expect(ident.caps).toEqual({ read: true, write: true })
  })

  it('tries the magic again when the first answer is a refusal', { timeout: 15_000 }, async () => {
    // The bench unit answered 0xfe to the first contact after sitting idle,
    // then acknowledged the very next attempt. One retry is the difference
    // between a working identify and a radio reported as refusing.
    const ident = await writable.identify(radio(RAW.slice(), { refuseFirstMagic: true }), {})
    expect(ident.variant).toBe('HN5RV011')
  })

  it('offers a firmware it does not recognize read-only, with the reason spelled out', async () => {
    const strange = RAW.slice()
    // The version window: aux block1[48:62], which is image 0x1838-0x1846.
    strange.set(new TextEncoder().encode('XYZZY123'), IDENT_SIZE + MAIN_SIZE + 48)
    const ident = await writable.identify(radio(strange), {})
    expect(ident.variant).toBe('XYZZY123')
    expect(ident.caps.write).toBe(false)
    expect(ident.caps.reason).toContain('XYZZY123')
    expect(ident.caps.read).toBe(true)
  })
})

describe('the write gate', () => {
  const backup: BackupRef = { id: 'b', identHash: 'nope', createdAt: '2026-08-30T00:00:00.000Z' }
  const transport = {} as never

  it('refuses when the build is not cleared to write, by name', async () => {
    await expect(driver.writeImage(transport, image(), { backup })).rejects.toThrow(/UV-5G/)
  })

  it('refuses without a backup', async () => {
    await expect(writable.writeImage(transport, image(), {})).rejects.toThrow(BackupRequiredError)
  })

  it('refuses an image from a different radio before touching the port', async () => {
    await expect(
      writable.writeImage(transport, { ...image(), radioId: 'uv82' }, { backup }),
    ).rejects.toThrow(DriverError)
  })

  it('writes nothing when the radio already holds the image', async () => {
    const report = await writable.writeImage(radio(RAW.slice()), image(), {
      backup: { ...backup, identHash: 'match', unitHash: await unitHashOf(RAW) },
      ident,
    })
    expect(report.blocksWritten).toBe(0)
  })

  it('restores a drifted byte through the read-first path and verifies it', async () => {
    const drifted = RAW.slice()
    drifted[SETTINGS_BASE] = 0xaa
    const port = radio(drifted)
    const report = await writable.writeImage(port, image(), {
      backup: { ...backup, identHash: 'match', unitHash: await unitHashOf(RAW) },
      ident,
    })
    expect(report.blocksWritten).toBe(1)
    expect(report.verified).toBe(true)
    expect((port as { sent: { addr: number }[] }).sent.map((s) => s.addr)).toEqual([SETTINGS_BASE - IDENT_SIZE])
  })
})

describe('which radio is on the cable', () => {
  const backup: BackupRef = { id: 'b', identHash: 'match', createdAt: '2026-08-30T00:00:00.000Z' }
  const wireOf = (port: unknown) => (port as { wire: string[] }).wire
  const sentOf = (port: unknown) => (port as { sent: unknown[] }).sent

  /** The squelch byte moved on, which is one block of the settings range. */
  function edited(): RadioImage {
    const next = image()
    const mem = next.regions[0]!.data
    mem[SETTINGS_BASE] = mem[SETTINGS_BASE]! ^ 0x01
    return next
  }

  it('tells the three bench radios apart, and says the same of them every time', async () => {
    // Pinned, not merely distinct: every backup stores this hash, so a change
    // to which bytes it covers would turn every backup on file into another
    // radio's. These are sha256 over the three spans of each committed capture.
    expect(await unitHashOf(fixture('uv82-N822413.bin'))).toBe(
      'f776cab465743c8954ed5b41c10191540d9b4667cd53eec78c993ceaf270ad4b',
    )
    expect(await writable.unitFingerprint(image())).toBe(
      'b65593e1f4c6c7ba9c05978ab5571e5906109967021ed96aab1331892476ee15',
    )
    expect(await unitHashOf(fixture('uv5r-HN5RV011.bin'))).toBe(
      '9f3b73461c395e72cdaffeeb6349499058016db6ad6cc829e42e61be08590161',
    )
  })

  it('covers the three spans CHIRP compares and nothing around them', async () => {
    // Every byte of the aux area, and a byte of each owned range. The spans
    // are written out as CHIRP's own `_get_data_from_image` arguments rather
    // than read from UNIT_AREAS, so this checks the constant instead of
    // agreeing with it. The squelch thresholds and band limits between them
    // are what CHIRP's default upload writes in the aux area, so a
    // fingerprint that included them would change under its owner whenever
    // CHIRP was used.
    const chirp = [[0x1848, 0x18a8], [0x18b8, 0x18c8], [0x18d8, 0x1908]] as const
    const held = await unitHashOf(RAW)
    const probes = [0x0008, 0x0e28, 0x1008]
    for (let off = IDENT_SIZE + MAIN_SIZE; off < RAW.length; off++) probes.push(off)
    for (const off of probes) {
      const moved = RAW.slice()
      moved[off] = moved[off]! ^ 0xff
      const inside = chirp.some(([s, e]) => off >= s && off < e)
      expect((await unitHashOf(moved)) !== held, `image 0x${off.toString(16)}`).toBe(inside)
    }
  })

  it('cannot tell for an image that stops before the aux block', async () => {
    const short = { ...image(), regions: [{ start: 0, data: RAW.slice(0, IDENT_SIZE + MAIN_SIZE), label: 'image' }] }
    expect(await writable.unitFingerprint(short)).toBeNull()
  })

  it('reads a main block and three aux blocks before sending anything, at the size the read path uses', async () => {
    const port = radio(RAW.slice())
    const report = await writable.writeImage(port, edited(), {
      backup: { ...backup, unitHash: await unitHashOf(RAW) },
      baseImage: image(),
      ident,
    })
    expect(report.verified).toBe(true)
    // The whole conversation: a main-area block, the three blocks
    // `_get_aux_data_from_radio` reads, the windows the base is held to, then
    // exactly what the write sent before either check existed - one settings
    // block and the 0x40 window it is verified through.
    expect(wireOf(port)).toEqual([
      'read 0/40',
      'read 1f00/40',
      'read 1f40/40',
      'read 1f80/40',
      ...OWNED_WINDOW_READS,
      'write e20/10',
      'read e00/40',
    ])
  })

  it('never follows the handshake\'s last block with an aux read', async () => {
    /*
     * The handshake ends on 0x1FC0, the block some units drop a byte from, and
     * no session had ever read the aux area straight after it. The adversarial
     * review found the first version of this check doing exactly that, which
     * the test above could not see: it hands over a session's identification,
     * so the handshake never reached its wire. This one lets the write
     * identify, and holds the order from the first block on.
     */
    const { identHash } = await writable.identify(radio(RAW.slice()), {})
    const port = radio(RAW.slice())
    await writable.writeImage(port, edited(), {
      backup: { ...backup, identHash, unitHash: await unitHashOf(RAW) },
      baseImage: image(),
    })
    expect(wireOf(port)).toEqual([
      'read 1e80/40',
      'read 1ec0/40',
      'read 1fc0/40',
      'read 0/40',
      'read 1f00/40',
      'read 1f40/40',
      'read 1f80/40',
      ...OWNED_WINDOW_READS,
      'write e20/10',
      'read e00/40',
    ])
  })

  it('refuses a backup that carries no record of which radio it came from', async () => {
    const port = radio(RAW.slice())
    await expect(writable.writeImage(port, edited(), { backup, baseImage: image(), ident })).rejects.toThrow(
      /carries no record of which UV-5G/,
    )
    expect(sentOf(port)).toEqual([])
  })

  it('refuses a backup of another UV-5G, having read only those four blocks', async () => {
    const port = radio(RAW.slice())
    const theirs = { ...backup, unitHash: await unitHashOf(otherUnit()) }
    const write = writable.writeImage(port, edited(), { backup: theirs, baseImage: image(), ident })
    await expect(write).rejects.toThrow(BackupRequiredError)
    await expect(write).rejects.toThrow(/different UV-5G/)
    expect(wireOf(port)).toEqual(['read 0/40', 'read 1f00/40', 'read 1f40/40', 'read 1f80/40'])
  })

  it('refuses to restore one UV-5G\'s backup onto another, called as the restore screen calls it', async () => {
    // The restore screen hands over the image as its own backup, with the
    // image's own fingerprint. Before the check a restore diffed that image
    // against whichever radio was on the cable and sent the difference, so one
    // unit's codeplug could be put back onto another.
    const port = radio(otherUnit())
    const write = writable.writeImage(port, image(), {
      backup: { id: 'restore', identHash: 'match', unitHash: await writable.unitFingerprint(image()), createdAt: '' },
      ident,
    })
    await expect(write).rejects.toThrow(BackupRequiredError)
    await expect(write).rejects.toThrow(/different UV-5G/)
    expect(sentOf(port)).toEqual([])
  })

  it('refuses an image read from another UV-5G even with a backup of this one', async () => {
    // The way back exists - the backup is the radio's own - and what is wrong
    // is the image. The backup check cannot see that; this one does.
    const port = radio(otherUnit())
    const write = writable.writeImage(port, image(), {
      backup: { ...backup, unitHash: await unitHashOf(otherUnit()) },
      ident,
    })
    await expect(write).rejects.toThrow(WriteBlockedError)
    await expect(write).rejects.toThrow(/read from a different UV-5G than the one on the cable/)
    expect(sentOf(port)).toEqual([])
  })

  it('refuses an edit built on another UV-5G\'s codeplug', async () => {
    const port = radio(RAW.slice())
    const write = writable.writeImage(port, edited(), {
      backup: { ...backup, unitHash: await unitHashOf(RAW) },
      baseImage: image(otherUnit()),
      ident,
    })
    await expect(write).rejects.toThrow(/this edit was built on was read from a different UV-5G/)
    expect(sentOf(port)).toEqual([])
  })

  it('refuses an image with no aux block, and says how long it was', async () => {
    const port = radio(RAW.slice())
    const short = { ...image(), regions: [{ start: 0, data: RAW.slice(0, IDENT_SIZE + MAIN_SIZE), label: 'image' }] }
    await expect(
      writable.writeImage(port, short, { backup: { ...backup, unitHash: await unitHashOf(RAW) }, ident }),
    ).rejects.toThrow(/6152 bytes and stops before the aux block/)
    expect(sentOf(port)).toEqual([])
  })
})

describe('an edit built on a codeplug the radio no longer holds', () => {
  // A backup of this unit, so every write below gets past the unit check and
  // reaches the one these tests are about.
  let backup: BackupRef
  beforeAll(async () => {
    backup = { id: 'b', identHash: 'match', unitHash: await unitHashOf(RAW), createdAt: '2026-08-30T00:00:00.000Z' }
  })
  const wireOf = (port: unknown) => (port as { wire: string[] }).wire
  const sentOf = (port: unknown) => (port as { sent: unknown[] }).sent
  const memOf = (img: RadioImage) => img.regions[0]!.data

  /** Squelch moved on by one, which is a single block of the settings range. */
  function edited(): RadioImage {
    const next = image()
    const mem = memOf(next)
    mem[SETTINGS_BASE] = mem[SETTINGS_BASE]! ^ 0x01
    return next
  }

  /**
   * The radio as it stands some time after the file was saved: slot 1 has
   * been given a channel called KEYPAD, where the file still has it empty.
   */
  function movedOn(): Uint8Array {
    const held = RAW.slice()
    held.set(RAW.subarray(channelAddr(1), channelAddr(2)), channelAddr(0))
    held.set(new TextEncoder().encode('KEYPAD'), nameAddr(0))
    return held
  }

  it('refuses rather than leave the radio holding a mixture of two codeplugs', async () => {
    /*
     * The adversarial review's case, on this radio's own bytes. The base is
     * the bench capture, opened as a file, which has slot 1 empty. A settings
     * edit used to send its one block, verify it and report success, and the
     * radio kept KEYPAD while the screen - which takes the written image as
     * its new baseline - showed slot 1 empty. Nothing in the write could have
     * noticed: every block it sent landed correctly.
     */
    const held = movedOn()
    const port = radio(held)
    const write = writable.writeImage(port, edited(), { backup, baseImage: image(), ident })
    await expect(write).rejects.toThrow(RadioChangedError)
    await expect(write).rejects.toThrow(/first difference is in channel 1,/)
    expect(sentOf(port)).toEqual([])
    expect(equalBytes(held, movedOn())).toBe(true)
  })

  it('reads every window the owned ranges touch before sending, then sends only the edit', async () => {
    /*
     * The price of the check, pinned: 66 reads of 0x40 in address order from
     * 0x0000 - blocks `readImage` reads, on its boundaries - after the unit
     * check's four and ahead of a write that sends one block. 0x0000 is read
     * twice, once for the unit check's order and once here, and 0x0E00 twice,
     * once to check and once to verify, because a read taken before the write
     * cannot speak for after it.
     */
    const port = radio(RAW.slice())
    const report = await writable.writeImage(port, edited(), { backup, baseImage: image(), ident })
    expect(report.verified).toBe(true)
    expect(report.blocksWritten).toBe(1)
    expect(OWNED_WINDOW_READS).toHaveLength(66)
    expect(wireOf(port)).toEqual([
      'read 0/40',
      'read 1f00/40',
      'read 1f40/40',
      'read 1f80/40',
      ...OWNED_WINDOW_READS,
      'write e20/10',
      'read e00/40',
    ])
  })

  it('refuses a keypad change that shares a byte with the edit', async () => {
    /*
     * Scan, bandwidth, busy lock and PTT ID share the last byte of a channel
     * record. Here scan was turned off for channel 2 on the radio, and busy
     * lock turned on in the app, so the byte the write sends carries the
     * file's scan bit. The first version of the check counted every byte the
     * edit changed as the edit's and put scan back on with no line in the
     * diff; the review of the check found it.
     */
    const at = channelAddr(1) + 0x0f
    const held = RAW.slice()
    held[at] = held[at]! & ~0x04
    const doc = writable.decode(image())
    const ch = doc.channels.get(2)!
    doc.channels.set(2, { ...ch, extras: { ...ch.extras, vendor: { ...ch.extras.vendor, busyChannelLockout: '1' } } })
    const next = writable.encode(doc, image())
    // The edit does change that byte, which is the case the first version
    // let through.
    expect(memOf(next)[at]).not.toBe(RAW[at])
    const port = radio(held)
    await expect(writable.writeImage(port, next, { backup, baseImage: image(), ident })).rejects.toThrow(
      /first difference is in channel 2,/,
    )
    expect(sentOf(port)).toEqual([])
  })

  it('refuses a channel created in a slot the radio has since filled', async () => {
    /*
     * An empty slot keeps stale bytes behind its 0xFF marker - every empty
     * slot on the bench UV-82 reads `ff 00 57 15 00 00 57 15 00 ... 44` - and
     * a channel stored from the keypad can match them past the frequencies.
     * Creating a channel in that slot changes every frequency byte, so a
     * check that took the edit's bytes as the edit's would let the new
     * channel replace the keypad's while the diff said "created". New
     * channels go to the first free slot, and so do the keypad's.
     */
    const SLOT = 100
    const rec = channelAddr(SLOT - 1)
    const file = RAW.slice()
    file.set([0xff, 0x00, 0x57, 0x15, 0x00, 0x00, 0x57, 0x15, 0, 0, 0, 0, 0, 0, 0, 0x44], rec)
    const held = file.slice()
    held.set(RAW.subarray(channelAddr(1), channelAddr(2)), rec)
    const doc = writable.decode(image(file))
    expect(doc.channels.has(SLOT)).toBe(false)
    doc.channels.set(SLOT, { ...doc.channels.get(3)!, index: SLOT })
    const port = radio(held)
    const write = writable.writeImage(port, writable.encode(doc, image(file)), { backup, baseImage: image(file), ident })
    await expect(write).rejects.toThrow(/first difference is in channel 100,/)
    // The byte the edit changes, so the bytes are given three ways: what the
    // radio holds, what the file held, and what the edit would have written.
    await expect(write).rejects.toThrow(
      /radio holds: 62 25 46 50 62 25 46 00\n {2}base: {8}00 57 15 00 00 57 15 00\n {2}edit: {8}87 25 46 50 87 25 46 00$/,
    )
    expect(sentOf(port)).toEqual([])
  })

  it('shows no byte past the block the first difference is in', async () => {
    // Channel 128's last byte ends a range, and the window after it is never
    // read, so eight bytes from there would print seven the radio was never
    // asked for.
    const at = channelAddr(127) + 0x0f
    const held = RAW.slice()
    held[at] = held[at]! ^ 0x01
    const hex = (b: number) => b.toString(16).padStart(2, '0')
    await expect(
      writable.writeImage(radio(held), edited(), { backup, baseImage: image(), ident }),
    ).rejects.toThrow(
      new RegExp(
        `\\(1 block differs; the first difference is in channel 128, at 0x07ff\\)[\\s\\S]*` +
          `radio holds: ${hex(held[at]!)}\\n {2}base: {8}${hex(RAW[at]!)}$`,
      ),
    )
  })

  it('reads the radio before saying there is nothing to send', async () => {
    // An unedited codeplug sends nothing, and the empty write used to return
    // verified without asking the radio, which held something else. The gate
    // stops the app sending a write with no changes, so only another caller
    // reaches this, but what `writeImage` reports has to be true either way.
    const port = radio(movedOn())
    await expect(writable.writeImage(port, image(), { backup, baseImage: image(), ident })).rejects.toThrow(
      RadioChangedError,
    )
    expect(sentOf(port)).toEqual([])
  })

  it('refuses a difference inside the block the edit sends, at a byte the edit leaves alone', async () => {
    /*
     * Squelch and the step share one sixteen-byte block. Comparing only the
     * blocks a write leaves out would let this through, and sending the block
     * would put the file's step back over the radio's without the diff ever
     * having shown it.
     */
    const held = RAW.slice()
    held[SETTINGS_BASE + 1] = held[SETTINGS_BASE + 1]! ^ 0x01
    const port = radio(held)
    const write = writable.writeImage(port, edited(), { backup, baseImage: image(), ident })
    await expect(write).rejects.toThrow(RadioChangedError)
    await expect(write).rejects.toThrow(/first difference is in the settings,/)
    expect(sentOf(port)).toEqual([])
  })

  it('refuses a rename built through the encoder on a base the radio does not hold', async () => {
    // How test/hardware/uv5g.spec.ts builds its refusal, run here so that a
    // slip in building it - one the round-trip check would catch first, with
    // a different error - shows up before a bench session rather than in one.
    const stale = image()
    memOf(stale)[SETTINGS_BASE] = memOf(stale)[SETTINGS_BASE]! ^ 0x01
    const doc = writable.decode(stale)
    const other = [...doc.channels.keys()].sort((a, b) => a - b)[1]!
    doc.channels.set(other, { ...doc.channels.get(other)!, name: 'STALE' })
    const port = radio(RAW.slice())
    await expect(
      writable.writeImage(port, writable.encode(doc, stale), { backup, baseImage: stale, ident }),
    ).rejects.toThrow(/first difference is in the settings, at 0x0e20\)/)
    expect(sentOf(port)).toEqual([])
  })

  it('lets a write through when only the memory channel moved, which it does not own', async () => {
    // CHIRP's `wmchannel` - the channel each display is on - sits at image
    // 0x0E7E, inside the 0x0E40 window the check reads and outside the
    // settings it owns. Turning the channel knob between reading and writing
    // is ordinary use, and refusing for it would teach people to ignore the
    // refusal.
    const held = RAW.slice()
    held[0x0e7e] = held[0x0e7e]! ^ 0x01
    const report = await writable.writeImage(radio(held), edited(), { backup, baseImage: image(), ident })
    expect(report.verified).toBe(true)
  })

  it('names the channel whose name differs', async () => {
    const held = RAW.slice()
    held.set(new TextEncoder().encode('KEYPAD'), nameAddr(2))
    const port = radio(held)
    await expect(writable.writeImage(port, edited(), { backup, baseImage: image(), ident })).rejects.toThrow(
      /first difference is in the name of channel 3,/,
    )
    expect(sentOf(port)).toEqual([])
  })

  it('sends an edit again to a radio that took part of it before the write was cut off', async () => {
    /*
     * A block that landed holds the edit's bytes, and a byte the radio holds
     * as the edit has it is one of the two the check accepts. That is what
     * lets a write that stopped part way be sent again: the radio is part way
     * to the image rather than holding another codeplug.
     */
    const next = edited()
    const held = RAW.slice()
    held[SETTINGS_BASE] = memOf(next)[SETTINGS_BASE]!
    const port = radio(held)
    const report = await writable.writeImage(port, next, { backup, baseImage: image(), ident })
    expect(report.verified).toBe(true)
    for (const [s, e] of ownedRanges()) {
      expect(equalBytes(held.subarray(s, e), memOf(next).subarray(s, e)), `0x${s.toString(16)}`).toBe(true)
    }
  })

  it('refuses a base with no memory in it rather than write as though there were none', async () => {
    // Read as no base, it would become a restore: the whole radio read, and
    // every block that differs from it sent, none of which the diff showed.
    const port = radio(RAW.slice())
    await expect(
      writable.writeImage(port, edited(), { backup, baseImage: { ...image(), regions: [] }, ident }),
    ).rejects.toThrow(/base image has no memory region/)
    expect(wireOf(port)).toEqual([])
  })

  it('restores over a radio whose VFOs and memory channel have moved since the backup', async () => {
    /*
     * The ownership refusal is about the encoder, and a restore's image is a
     * backup. It used to run there anyway, so a VFO tuned or a channel turned
     * since the backup - ordinary use - refused the restore meant to put the
     * radio back, calling it a defect in boofwang. The bench restores never
     * met it because each ran straight after its write. A restore puts back
     * what it owns and leaves the rest as the radio has it.
     */
    const VFO_A = 0x0f10
    const WMCHANNEL = 0x0e7e
    const held = RAW.slice()
    held[VFO_A] = held[VFO_A]! ^ 0x01
    held[WMCHANNEL] = held[WMCHANNEL]! ^ 0x01
    held[SETTINGS_BASE] = 0xaa
    const port = radio(held)
    const report = await writable.writeImage(port, image(), { backup, ident })
    expect(report.verified).toBe(true)
    expect((port as { sent: { addr: number }[] }).sent.map((s) => s.addr)).toEqual([SETTINGS_BASE - IDENT_SIZE])
    expect(held[SETTINGS_BASE]).toBe(RAW[SETTINGS_BASE])
    expect(held[VFO_A]).toBe(RAW[VFO_A]! ^ 0x01)
    expect(held[WMCHANNEL]).toBe(RAW[WMCHANNEL]! ^ 0x01)
  })

  it('still refuses an edit that moves a byte outside the owned ranges', async () => {
    // The other half of that line: with a base, a change outside the owned
    // ranges is the encoder's, and it is refused before anything is read
    // beyond the unit check, as it always was.
    const next = edited()
    memOf(next)[0x0f10] = memOf(next)[0x0f10]! ^ 0x01
    const port = radio(RAW.slice())
    await expect(writable.writeImage(port, next, { backup, baseImage: image(), ident })).rejects.toThrow(
      /outside the ranges this driver claims to understand/,
    )
    expect(sentOf(port)).toEqual([])
  })

  it('still refuses an edit that moves a byte in a window CHIRP skips', async () => {
    const next = edited()
    memOf(next)[0x0cf8] = memOf(next)[0x0cf8]! ^ 0x01
    const port = radio(RAW.slice())
    await expect(writable.writeImage(port, next, { backup, baseImage: image(), ident })).rejects.toThrow(
      /one of the windows CHIRP has always skipped/,
    )
    expect(sentOf(port)).toEqual([])
  })

  it('adds nothing to a restore, which already diffs against what the radio holds', async () => {
    // A restore has no base to check, so this change must leave its
    // conversation as it was: the unit check's four reads, the whole main
    // block, then the blocks that differ. The main block and the write after
    // it are what the bench UV-5G restored through on 2026-08-30.
    const drifted = RAW.slice()
    drifted[SETTINGS_BASE] = 0xaa
    const port = radio(drifted)
    await writable.writeImage(port, image(), { backup, ident })
    const main = Array.from({ length: MAIN_SIZE / 0x40 }, (_, i) => `read ${(i * 0x40).toString(16)}/40`)
    expect(wireOf(port)).toEqual([
      'read 0/40',
      'read 1f00/40',
      'read 1f40/40',
      'read 1f80/40',
      ...main,
      'write e20/10',
      'read e00/40',
    ])
  })
})

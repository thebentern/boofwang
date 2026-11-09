// SPDX-License-Identifier: GPL-3.0-or-later
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'
import { BackupRequiredError, DriverError, RadioChangedError, type BackupRef } from '#core/radio/driver.js'
import { blocksToSend } from '#core/radio/diff.js'
import type { RadioImage } from '#core/radio/image.js'
import { unitHashOf } from '#core/radios/uv82/driver.js'
import { createUv5rDriver } from '#core/radios/uv5r/driver.js'
import { MAGIC_UV5R_291, MAGIC_UV5R_ORIG } from '#core/radios/uv5r/protocol.js'
import { REGIONS, SETTINGS_BASE, channelAddr, nameAddr, ownedRanges } from '#core/radios/uv82/layout.js'
import { AUX_START, IDENT_SIZE, MAIN_SIZE, NEVER_WRITE, WRITE_BLOCK_SIZE } from '#core/radios/uv82/protocol.js'

/**
 * The handshake and the gate, for a radio nobody has plugged in.
 *
 * The bytes are a UV-5G's - see decode.spec.ts for why that is a fair test of
 * this driver's decode and of nothing else - and the fake port below is a
 * script, not a radio. What can honestly be pinned here is the logic this
 * driver adds: two magics tried in order, and every path that decides whether
 * a write may happen. The write machinery underneath is the uv82 module's and
 * is tested there against that radio's own capture.
 */
const RAW = new Uint8Array(
  readFileSync(fileURLToPath(new URL('../../../fixtures/images/uv5g-HN5RV011.bin', import.meta.url))),
)

/** The version window: aux block1[48:62], which is image 0x1838-0x1846. */
const VERSION_AT = IDENT_SIZE + MAIN_SIZE + 48

function withFirmware(version: string): Uint8Array {
  const out = RAW.slice()
  out.fill(0xff, VERSION_AT, VERSION_AT + 14)
  out.set(new TextEncoder().encode(version), VERSION_AT)
  return out
}

function image(): RadioImage {
  return {
    radioId: 'uv5r',
    variant: 'BFB297',
    layout: 'uv5r',
    createdAt: '2026-09-04T00:00:00.000Z',
    regions: REGIONS.map((r) => ({
      start: r.start,
      data: RAW.slice(r.start, r.start + r.length),
      label: r.label,
      readOnly: r.readOnly,
    })),
    meta: {},
    sha256: '',
  }
}

const driver = createUv5rDriver()
/**
 * The build the registry creates, with writing on.
 *
 * This comment used to call the UV-5R read-only and this build a forced one,
 * which stopped being true when the registry enabled writing after the
 * 2026-09-05 bench session. `driver` above is the read-only build a schema
 * ships as before the registry says otherwise.
 */
const writable = createUv5rDriver({ enableWrite: true })

/**
 * A radio that answers exactly one of the family's magics.
 *
 * `answers` is which one, so that a unit that knows only the pre-BFB291 magic
 * can be scripted. Magic bytes are matched before control bytes: the magic
 * contains 0x06 at index five, and a stub that answers every lone 0x06 with an
 * acknowledgment acks its own magic mid-stream.
 */
function radio(contents: Uint8Array, opts: { answers?: Uint8Array } = {}) {
  const answers = opts.answers ?? MAGIC_UV5R_291
  const out: number[] = []
  let magicBuf: number[] = []
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
        if (identified) {
          if (b === 0x02) out.push(...contents.subarray(0, IDENT_SIZE))
          if (b === 0x06) out.push(0x06)
          return
        }
        magicBuf.push(b)
        if (magicBuf.length === answers.length) {
          const ok = magicBuf.every((x, i) => x === answers[i])
          magicBuf = []
          if (!ok) return
          out.push(0x06)
          identified = true
        }
        return
      }
      if (cmd[0] === 0x53) {
        const addr = (cmd[1]! << 8) | cmd[2]!
        const size = cmd[3]!
        wire.push(`read ${addr.toString(16)}/${size.toString(16)}`)
        // The 0x1E80 warm-up block is the only one requested with the leading
        // acknowledgment skipped, so it is the only one that must not send it.
        if (addr !== 0x1e80) out.push(0x06)
        out.push(0x58, cmd[1]!, cmd[2]!, cmd[3]!)
        for (let i = 0; i < size; i++) {
          const a = addr + i
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
    async resync() {
      return Uint8Array.from(out.splice(0, out.length))
    },
  } as never
}

describe('identify, over the wire', () => {
  it('acknowledges the current magic and reads the firmware behind it', async () => {
    const ident = await driver.identify(radio(withFirmware('BFB297')), {})
    expect(ident.radioId).toBe('uv5r')
    expect(ident.variant).toBe('BFB297')
    expect(ident.layout).toBe('uv5r')
    expect(ident.caps.read).toBe(true)
  })

  it('falls back to the original magic when the current one goes unanswered', { timeout: 30_000 }, async () => {
    /*
     * The whole reason `Uv5rFamilyModel` carries a list rather than one magic.
     * A pre-BFB291 radio ignores `UV5R_MODEL_291` entirely; without the second
     * ident it would not answer at all, and its owner would be told there was
     * no radio on the cable rather than being offered the backup that is the
     * one thing this build can usefully do for them.
     */
    const ident = await driver.identify(radio(withFirmware('BFB251'), { answers: MAGIC_UV5R_ORIG }), {})
    expect(ident.variant).toBe('BFB251')
    // Identified, read-only: CHIRP handles these radios' auxiliary area
    // differently on upload and none of that has been exercised here.
    expect(ident.caps.read).toBe(true)
    expect(ident.caps.write).toBe(false)
  })

  it('reports no radio when neither magic is answered', { timeout: 30_000 }, async () => {
    const silent = radio(RAW.slice(), { answers: Uint8Array.from([0xde, 0xad, 0xbe, 0xef, 0x00, 0x11, 0x22]) })
    await expect(driver.identify(silent, {})).rejects.toThrow()
  })
})

describe('what identify will let a write reach', () => {
  it('clears a firmware it can vouch for', async () => {
    const ident = await writable.identify(radio(withFirmware('BFB297')), {})
    expect(ident.caps).toEqual({ read: true, write: true })
  })

  it('lets the ambiguous string through to the write, which checks the radio itself', async () => {
    /*
     * The capture's own firmware is HN5RV011, which contains N5RV - in
     * BASETYPE_UV5R and BASETYPE_F8HP both, and the string a real radio turned
     * out to report. It is claimed as the two-power radio here; the guard that
     * makes that safe is in `writeImage`, which refuses any radio whose bytes
     * do not survive being decoded and re-encoded.
     */
    const ident = await writable.identify(radio(RAW.slice()), {})
    expect(ident.variant).toBe('HN5RV011')
    expect(ident.caps.write).toBe(true)
    expect(ident.caps.read).toBe(true)
    expect(ident.layout).toBe('uv5r')
  })

  it('refuses a tri-power radio by name, and says why', async () => {
    const ident = await writable.identify(radio(withFirmware('BFP3V3 F')), {})
    expect(ident.caps.write).toBe(false)
    expect(ident.caps.reason).toContain('BF-F8HP')
    expect(ident.caps.reason).toContain('three power levels')
    // The layout string is stored in backups, so it must not drift.
    expect(ident.layout).toBe('uv5rhp')
  })

  it('refuses a firmware it does not recognize at all', async () => {
    const ident = await writable.identify(radio(withFirmware('XYZZY123')), {})
    expect(ident.caps.write).toBe(false)
    expect(ident.caps.reason).toContain('XYZZY123')
  })
})

describe('the write gate', () => {
  const backup: BackupRef = { id: 'b', identHash: 'nope', createdAt: '2026-09-04T00:00:00.000Z' }
  const transport = {} as never

  it('refuses because this build does not write this radio, and says which radio', async () => {
    // The read-only build: what a driver built for a test or a file import
    // gets, and what the registry's line is the only way out of.
    await expect(driver.writeImage(transport, image(), { backup })).rejects.toThrow(/UV-5R/)
  })

  it('refuses without a backup', async () => {
    await expect(writable.writeImage(transport, image(), {})).rejects.toThrow(BackupRequiredError)
  })

  it('refuses an image from a different radio before touching the port', async () => {
    await expect(
      writable.writeImage(transport, { ...image(), radioId: 'uv82' }, { backup }),
    ).rejects.toThrow(DriverError)
  })

  it('refuses a backup whose identify hash is another radio\'s', async () => {
    // The firmware-level check. Telling two units on the same firmware apart
    // is the aux-span fingerprint's job, tested in uv5g/write.spec.ts on the
    // code this driver shares.
    const ident = {
      radioId: 'uv5r' as const,
      variant: 'BFB297',
      layout: 'uv5r',
      raw: new Uint8Array(0),
      caps: { read: true, write: true },
      identHash: 'match',
    }
    await expect(
      writable.writeImage(radio(withFirmware('BFB297')), image(), { backup, ident }),
    ).rejects.toThrow(BackupRequiredError)
  })

  it('sweeps the owned ranges even when the radio already holds the image', async () => {
    /*
     * The opposite of every other radio here, and deliberately.
     *
     * On the rest of the family an unchanged image writes nothing, which is
     * the property that keeps a one-channel edit to one block. This radio
     * programs a byte once and will not reprogram it, so a sparse write cannot
     * shorten a name - only a contiguous sweep can, which is what CHIRP has
     * always done. `writesWholeImage` is what asks for that, and the cost is
     * exactly this: no write is ever a no-op.
     */
    const ident = {
      radioId: 'uv5r' as const,
      variant: 'BFB297',
      layout: 'uv5r',
      raw: new Uint8Array(0),
      caps: { read: true, write: true },
      identHash: 'match',
    }
    const report = await writable.writeImage(radio(RAW.slice()), image(), {
      backup: { ...backup, identHash: 'match', unitHash: await unitHashOf(RAW) },
      ident,
    })
    expect(writable.schema.capabilities.writesWholeImage).toBe(true)
    expect(report.blocksWritten).toBeGreaterThan(0)

    // Every block sent is inside the owned ranges and outside the two windows
    // CHIRP skips - the sweep decides what goes on the wire, never what the
    // driver is allowed to touch.
    const owned = ownedRanges()
    for (const op of report.operations) {
      const from = op.addr + IDENT_SIZE
      const to = from + op.length
      expect(owned.some(([s, e]) => from >= s && to <= e), `0x${op.addr.toString(16)} is unowned`).toBe(true)
      expect(NEVER_WRITE.some(([s, e]) => from < e && to > s), `0x${op.addr.toString(16)} is skipped`).toBe(false)
    }

    // And the confirmation counts this sweep rather than the image, which
    // carries an aux block the sweep never sends. `sweptRanges` is the claim
    // that makes the count right, and these frames are what it is held to.
    const sent = report.operations.reduce((n, op) => n + op.length, 0)
    const swept = (writable.sweptRanges?.(0) ?? []).reduce((n, [s, e]) => n + e - s, 0)
    expect(swept).toBe(sent)
    expect(blocksToSend({ diff: null, image: image(), driver: writable, wholeImage: true })).toBe(
      Math.ceil(sent / writable.writeBlockBytes),
    )
  })
})

describe('a sweep built on a codeplug the radio no longer holds', () => {
  /*
   * A sweep cannot leave a mixture of two codeplugs, because every owned
   * block goes. What it did instead, before the check, was revert: an edit
   * built on an old file put the whole file back over everything the radio
   * had been changed to since, and the diff behind the confirmation showed
   * only the edit. These pin the check on the sweeping member, under the
   * same rule as the members that send a diff, and the restore beside it.
   */
  const ident = {
    radioId: 'uv5r' as const,
    variant: 'BFB297',
    layout: 'uv5r',
    raw: new Uint8Array(0),
    caps: { read: true, write: true },
    identHash: 'match',
  }
  let backup: BackupRef
  beforeAll(async () => {
    backup = { id: 'b', identHash: 'match', unitHash: await unitHashOf(RAW), createdAt: '2026-09-04T00:00:00.000Z' }
  })
  const wireOf = (port: unknown) => (port as { wire: string[] }).wire
  const sentOf = (port: unknown) => (port as { sent: unknown[] }).sent
  const memOf = (img: RadioImage) => img.regions[0]!.data
  const UNIT_READS = ['read 0/40', 'read 1f00/40', 'read 1f40/40', 'read 1f80/40']
  const OWNED_WINDOW_READS = [
    ...Array.from({ length: 32 }, (_, i) => i * 0x40),
    0x0e00,
    0x0e40,
    ...Array.from({ length: 32 }, (_, i) => 0x1000 + i * 0x40),
  ].map((a) => `read ${a.toString(16)}/40`)

  /** Squelch moved on by one, which is a single block of the settings range. */
  function edited(): RadioImage {
    const next = image()
    const mem = memOf(next)
    mem[SETTINGS_BASE] = mem[SETTINGS_BASE]! ^ 0x01
    return next
  }

  it('refuses a sweep over a radio that has moved on from its base, and counts what moved', async () => {
    // Slot 1 programmed on the radio since the file was saved, record and
    // name: two blocks. The sweep would have emptied it again.
    const held = RAW.slice()
    held.set(RAW.subarray(channelAddr(1), channelAddr(2)), channelAddr(0))
    held.set(new TextEncoder().encode('KEYPAD'), nameAddr(0))
    const port = radio(held)
    const write = writable.writeImage(port, edited(), { backup, baseImage: image(), ident })
    await expect(write).rejects.toThrow(RadioChangedError)
    await expect(write).rejects.toThrow(/\(2 blocks differ; the first difference is in channel 1, at 0x0000\)/)
    // The edit does not touch those bytes, so there is no edit line.
    await expect(write).rejects.toThrow(/radio holds: 50 62 25 46 50 62 25 46\n {2}base: {8}ff ff ff ff ff ff ff ff$/)
    expect(sentOf(port)).toEqual([])
  })

  it('sends a sweep again to a radio that took part of it before it was cut off', async () => {
    /*
     * The radio holds the edited squelch, as a sweep stopped after the
     * settings block would leave it. A sweep rewrites every owned byte, so a
     * byte already holding the edit has nothing to revert, and the same write
     * goes again. An earlier draft held a sweep to the base exactly, which
     * refused this and protected nothing.
     */
    const next = edited()
    const held = RAW.slice()
    held[SETTINGS_BASE] = memOf(next)[SETTINGS_BASE]!
    const port = radio(held)
    const report = await writable.writeImage(port, next, { backup, baseImage: image(), ident })
    expect(report.verified).toBe(true)
    expect(report.blocksWritten).toBe(259)
    for (const [s, e] of ownedRanges()) {
      expect([...held.subarray(s, e)], `0x${s.toString(16)}`).toEqual([...memOf(next).subarray(s, e)])
    }
  })

  it('restores over a radio whose VFOs and memory channel have moved since the backup', async () => {
    /*
     * A restore has no base, and its image is a backup rather than the
     * encoder's output, so a radio that differs from it outside the owned
     * ranges is expected. Turning to another VFO frequency or channel used to
     * make the restore refuse, calling it a defect in boofwang. It puts back
     * what it owns and leaves those bytes as the radio has them.
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
    const owned = ownedRanges()
    for (const { addr } of (port as { sent: { addr: number }[] }).sent) {
      const from = addr + IDENT_SIZE
      expect(owned.some(([s, e]) => from >= s && from + WRITE_BLOCK_SIZE <= e), `0x${addr.toString(16)}`).toBe(true)
    }
    expect(held[SETTINGS_BASE]).toBe(RAW[SETTINGS_BASE])
    expect(held[VFO_A]).toBe(RAW[VFO_A]! ^ 0x01)
    expect(held[WMCHANNEL]).toBe(RAW[WMCHANNEL]! ^ 0x01)
  })

  it('reads the owned windows, then sweeps, when the radio holds its base', async () => {
    // The restore's shape - main-area reads, then the sweep - which passed on
    // the bench on 2026-09-05, with the unit check's four reads in front and
    // 66 of the restore's 96 main-area reads.
    const port = radio(RAW.slice())
    const report = await writable.writeImage(port, edited(), { backup, baseImage: image(), ident })
    expect(report.verified).toBe(true)
    const sweep: string[] = []
    for (const [s, e] of ownedRanges()) {
      for (let off = s; off < e; off += WRITE_BLOCK_SIZE) sweep.push(`write ${(off - IDENT_SIZE).toString(16)}/10`)
    }
    expect(sweep).toHaveLength(259)
    expect(report.blocksWritten).toBe(259)
    // The read-back after the sweep is the same 66 windows again.
    expect(wireOf(port)).toEqual([...UNIT_READS, ...OWNED_WINDOW_READS, ...sweep, ...OWNED_WINDOW_READS])
  })

  it('adds nothing to a restore, which has no base to check', async () => {
    const drifted = RAW.slice()
    drifted[SETTINGS_BASE] = 0xaa
    const port = radio(drifted)
    await writable.writeImage(port, image(), { backup, ident })
    const main = Array.from({ length: MAIN_SIZE / 0x40 }, (_, i) => `read ${(i * 0x40).toString(16)}/40`)
    expect(wireOf(port).slice(0, UNIT_READS.length + main.length)).toEqual([...UNIT_READS, ...main])
    expect(wireOf(port)[UNIT_READS.length + main.length]).toMatch(/^write /)
  })
})

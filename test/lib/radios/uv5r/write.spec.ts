// SPDX-License-Identifier: GPL-3.0-or-later
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { BackupRequiredError, DriverError, type BackupRef } from '#core/radio/driver.js'
import type { RadioImage } from '#core/radio/image.js'
import { createUv5rDriver } from '#core/radios/uv5r/driver.js'
import { MAGIC_UV5R_291, MAGIC_UV5R_ORIG } from '#core/radios/uv5r/protocol.js'
import { REGIONS, ownedRanges } from '#core/radios/uv82/layout.js'
import { AUX_START, IDENT_SIZE, MAIN_SIZE, NEVER_WRITE } from '#core/radios/uv82/protocol.js'

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
 * A build with writing forced on.
 *
 * The registry does not create one of these - the UV-5R ships read-only. It
 * exists so that the refusals which would guard a future write can be tested
 * now, rather than being written for the first time on the day someone flips
 * the flag with a radio on the bench.
 */
const writable = createUv5rDriver({ enableWrite: true })

/**
 * A radio that answers exactly one of the family's magics.
 *
 * `answers` is which one, so that a unit that knows only the pre-BFB291 magic
 * can be scripted. Magic bytes are matched before control bytes: the magic
 * contains 0x06 at index five, and a stub that answers every lone 0x06 with an
 * acknowledgement acks its own magic mid-stream.
 */
function radio(contents: Uint8Array, opts: { answers?: Uint8Array } = {}) {
  const answers = opts.answers ?? MAGIC_UV5R_291
  const out: number[] = []
  let magicBuf: number[] = []
  let identified = false
  const sent: { addr: number; data: Uint8Array }[] = []
  return {
    sent,
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
        // The 0x1E80 warm-up block is the only one requested with the leading
        // acknowledgement skipped, so it is the only one that must not send it.
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

describe('what identify will let a write reach, if writing is ever enabled', () => {
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
    // The state the UV-5R actually ships in. Not a placeholder: one has been
    // read on a cable now, and nothing has ever been sent to one, so there is
    // still no evidence a write would land correctly.
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

  it('refuses a backup taken from a different unit', async () => {
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
      backup: { ...backup, identHash: 'match' },
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
  })
})

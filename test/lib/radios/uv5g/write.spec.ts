// SPDX-License-Identifier: GPL-3.0-or-later
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { BackupRequiredError, DriverError, type BackupRef } from '#core/radio/driver.js'
import type { RadioImage } from '#core/radio/image.js'
import { createUv5gDriver } from '#core/radios/uv5g/driver.js'
import { MAGIC_UV5G } from '#core/radios/uv5g/protocol.js'
import { REGIONS, SETTINGS_BASE } from '#core/radios/uv82/layout.js'
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
const RAW = new Uint8Array(
  readFileSync(fileURLToPath(new URL('../../../fixtures/images/uv5g-HN5RV011.bin', import.meta.url))),
)

function image(): RadioImage {
  return {
    radioId: 'uv5g',
    variant: 'HN5RV011',
    layout: 'uv5g',
    createdAt: '2026-08-30T00:00:00.000Z',
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

const driver = createUv5gDriver()
const writable = createUv5gDriver({ enableWrite: true })

/**
 * A radio that answers the classic protocol behind the UV-5G's magic.
 *
 * The magic arrives one byte at a time; a full match earns the 0x06. The
 * firmware probe's first block skips the leading acknowledgement - CHIRP's
 * `first_command` - and every read after it takes one, which is exactly the
 * flow a real UV-82 broke when it was got wrong.
 */
function radio(contents: Uint8Array, opts: { refuseFirstMagic?: boolean } = {}) {
  const out: number[] = []
  let magicBuf: number[] = []
  let magicAttempts = 0
  let identified = false
  const sent: { addr: number; data: Uint8Array }[] = []
  return {
    sent,
    async write(cmd: Uint8Array) {
      if (cmd.length === 1) {
        const b = cmd[0]!
        /*
         * Magic bytes first, control bytes after. The magic itself contains
         * 0x06 at index five, so a stub that answers every lone 0x06 with an
         * acknowledgement acks its own magic mid-stream - which is exactly
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
          // The bench unit's first-contact behaviour: 0xfe to the first
          // magic after sitting idle, an acknowledgement to the next.
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
        // The 0x1E80 warm-up block is the only one ever requested with the
        // leading acknowledgement skipped, so it is the only one that must not
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

  it('offers a firmware it does not recognise read-only, with the reason spelled out', async () => {
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

  const ident = {
    radioId: 'uv5g' as const,
    variant: 'HN5RV011',
    layout: 'uv5g',
    raw: new Uint8Array(0),
    caps: { read: true, write: true },
    identHash: 'match',
  }

  it('writes nothing when the radio already holds the image', async () => {
    const report = await writable.writeImage(radio(RAW.slice()), image(), {
      backup: { ...backup, identHash: 'match' },
      ident,
    })
    expect(report.blocksWritten).toBe(0)
  })

  it('restores a drifted byte through the read-first path and verifies it', async () => {
    const drifted = RAW.slice()
    drifted[SETTINGS_BASE] = 0xaa
    const port = radio(drifted)
    const report = await writable.writeImage(port, image(), {
      backup: { ...backup, identHash: 'match' },
      ident,
    })
    expect(report.blocksWritten).toBe(1)
    expect(report.verified).toBe(true)
    expect((port as { sent: { addr: number }[] }).sent.map((s) => s.addr)).toEqual([SETTINGS_BASE - IDENT_SIZE])
  })
})

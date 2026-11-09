// SPDX-License-Identifier: GPL-3.0-or-later
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { sha256Hex } from '#core/codec/checksum.js'
import type { RadioImage } from '#core/radio/image.js'
import { createDm32uvDriver } from '#core/radios/dm32uv/driver.js'
import { logicalAddress } from '#core/radios/dm32uv/image.js'
import { PAGE_SIZE } from '#core/radios/dm32uv/protocol.js'
import { createUv5gDriver } from '#core/radios/uv5g/driver.js'
import { REGIONS, UNIT_AREAS } from '#core/radios/uv82/layout.js'
import { chooseBackup, type BackupWanted } from '#core/storage/choose-backup.js'
import { fromStoredBackup, toStoredBackup, type StoredBackup } from '#core/storage/db.js'

/**
 * Which backup a write is offered, on real UV-5G bytes.
 *
 * The driver is what refuses a backup of another unit, and it is tested for
 * that in uv5g/write.spec.ts. What is pinned here is the other half: that the
 * screens are offered the backup the driver will accept, rather than one it
 * is certain to refuse after the slide.
 */
const RAW = new Uint8Array(
  readFileSync(fileURLToPath(new URL('../../fixtures/images/uv5g-HN5RV011.bin', import.meta.url))),
)
const driver = createUv5gDriver({ enableWrite: true })

/** A second UV-5G, one calibration step away from the bench unit. */
const OTHER = RAW.slice()
const AT = UNIT_AREAS[0]![0]
OTHER[AT] = OTHER[AT]! ^ 0x01

function image(bytes: Uint8Array): RadioImage {
  return {
    radioId: 'uv5g',
    variant: 'HN5RV011',
    layout: 'uv5g',
    createdAt: '2026-08-30T00:00:00.000Z',
    regions: REGIONS.map((r) => ({ start: r.start, data: bytes.slice(r.start, r.start + r.length), label: r.label })),
    meta: {},
    sha256: '',
  }
}

/**
 * A stored backup of `bytes`, with the fingerprint a read stores now, or none
 * when `legacy` says it was taken before there was one.
 */
async function backup(id: string, bytes: Uint8Array, createdAt: string, legacy = false): Promise<StoredBackup> {
  const img = { ...image(bytes), createdAt }
  return toStoredBackup(img, {
    id,
    origin: 'download',
    identHash: 'uv5g-HN5RV011',
    ...(legacy ? {} : { unitHash: await driver.unitFingerprint(img) }),
  })
}

const want = async (bytes: Uint8Array | null, extra: Partial<BackupWanted> = {}): Promise<BackupWanted> => ({
  identHash: 'uv5g-HN5RV011',
  radioId: 'uv5g',
  unit: bytes ? await driver.unitFingerprint(image(bytes)) : null,
  fingerprint: (b) => driver.unitFingerprint(fromStoredBackup(b)),
  ...extra,
})

describe('the backup a write of the open codeplug is offered', () => {
  it('passes over a newer backup of another unit for this one\'s', async () => {
    const mine = await backup('mine', RAW, '2026-09-01T00:00:00.000Z')
    const theirs = await backup('theirs', OTHER, '2026-09-02T00:00:00.000Z')
    const chosen = await chooseBackup([mine, theirs], await want(RAW))
    expect(chosen?.backup.id).toBe('mine')
  })

  it('fingerprints a backup that predates the check from its own bytes', async () => {
    // Every UV-5R family backup stored before the driver could fingerprint
    // looks like this. Its bytes are the whole read, aux area included.
    const old = await backup('old', RAW, '2026-09-01T00:00:00.000Z', true)
    expect(old.unitHash).toBeNull()
    const chosen = await chooseBackup([old], await want(RAW))
    expect(chosen?.backup.id).toBe('old')
    expect(chosen?.unitHash).toBe(await driver.unitFingerprint(image(RAW)))
  })

  it('does not take an old backup of another unit for this one', async () => {
    const old = await backup('old', OTHER, '2026-09-01T00:00:00.000Z', true)
    expect(await chooseBackup([old], await want(RAW))).toBeNull()
  })

  it('says there is none when no backup is of this unit, however recent the others', async () => {
    const theirs = await backup('theirs', OTHER, '2026-09-02T00:00:00.000Z')
    expect(await chooseBackup([theirs], await want(RAW))).toBeNull()
  })

  it('takes the newest when the open image cannot be fingerprinted, as it always did', async () => {
    const older = await backup('older', RAW, '2026-09-01T00:00:00.000Z')
    const newer = await backup('newer', OTHER, '2026-09-02T00:00:00.000Z', true)
    const chosen = await chooseBackup([older, newer], await want(null))
    expect(chosen?.backup.id).toBe('newer')
    // Still computed, so the driver is handed what the backup's bytes say
    // rather than a null it would refuse.
    expect(chosen?.unitHash).toBe(await driver.unitFingerprint(image(OTHER)))
  })

  it('matches on the connected radio, and on the open codeplug\'s radio when none is connected', async () => {
    const mine = await backup('mine', RAW, '2026-09-01T00:00:00.000Z')
    const firmware = await chooseBackup([mine], await want(RAW, { identHash: 'another-firmware' }))
    expect(firmware).toBeNull()
    const offline = await chooseBackup([mine], await want(RAW, { identHash: null }))
    expect(offline?.backup.id).toBe('mine')
    const model = await chooseBackup([mine], await want(RAW, { identHash: null, radioId: 'uv5r' }))
    expect(model).toBeNull()
  })

  it('reads a backup no driver can fingerprint as no fingerprint at all', async () => {
    const old = await backup('old', RAW, '2026-09-01T00:00:00.000Z', true)
    const broken = await want(RAW, {
      fingerprint: () => {
        throw new Error('no driver')
      },
    })
    expect(await chooseBackup([old], broken)).toBeNull()
    const blind = await chooseBackup([old], { ...broken, unit: null })
    expect(blind?.unitHash).toBeNull()
  })
})

describe('a DM-32UV backup stored before that driver checked the unit', () => {
  /*
   * `chooseBackup` serves every radio, so this changed the DM-32UV too. Its
   * driver refused a backup with no fingerprint and asked for a fresh read;
   * the app now computes the fingerprint from the backup's own calibration
   * page before offering it, which the driver then holds to the radio's live
   * page as it always did.
   */
  const fixtureOf = (name: string) => fileURLToPath(new URL(`../../fixtures/images/${name}`, import.meta.url))
  const BLOB = new Uint8Array(readFileSync(fixtureOf('dm32uv-DM32.01.01.040.blocks.bin')))
  const INDEX = JSON.parse(readFileSync(fixtureOf('dm32uv-DM32.01.01.040.index.json'), 'utf8')) as {
    firmware: string
    model: string
    blocks: { id: number; offset: number }[]
  }
  const dm32 = createDm32uvDriver({ enableWrite: true })
  const img: RadioImage = {
    radioId: 'dm32uv',
    variant: INDEX.firmware,
    layout: INDEX.model,
    createdAt: '2026-08-19T22:00:00.000Z',
    regions: INDEX.blocks.map((b) => ({
      start: logicalAddress(b.id),
      data: BLOB.slice(b.offset, b.offset + PAGE_SIZE),
      readOnly: b.id === 0x02,
      label: `block 0x${b.id.toString(16)}`,
    })),
    meta: {},
    sha256: '',
  }

  it('is offered with the hash of its calibration page', async () => {
    const old = toStoredBackup(img, { id: 'old', origin: 'download', identHash: 'dm32' })
    expect(old.unitHash).toBeNull()
    const chosen = await chooseBackup([old], {
      identHash: 'dm32',
      radioId: 'dm32uv',
      unit: await dm32.unitFingerprint(img),
      fingerprint: (b) => dm32.unitFingerprint(fromStoredBackup(b)),
    })
    const cal = INDEX.blocks.find((b) => b.id === 0x02)!
    expect(chosen?.backup.id).toBe('old')
    expect(chosen?.unitHash).toBe(await sha256Hex(BLOB.slice(cal.offset, cal.offset + PAGE_SIZE)))
  })
})

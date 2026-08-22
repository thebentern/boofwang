// SPDX-License-Identifier: GPL-3.0-or-later
import {
  queryBootImageRange,
  writeBootImageRegion,
  BOOT_IMAGE_REGION_START,
} from '#core/radios/dm32uv/boot-image.js'
import { BOOT_IMAGE_BYTES, decodeBootImage } from '#core/io/boot-image.js'
import { enterProgrammingMode, readMemory, PAGE_SIZE } from '#core/radios/dm32uv/protocol.js'
import type { Transport } from '#core/transport/transport.js'
import { acquirePort } from '~/composables/useWebSerial'
import type { PortChoice } from '~/composables/useWebSerial'

/**
 * Reading and writing the DM-32UV's startup picture.
 *
 * Kept out of `useRadioSession` because almost nothing here is shared with it:
 * different region, different addressing, no codeplug, and one rule the
 * codeplug flow does not need.
 *
 * That rule is the whole reason this is careful. The startup image lives at
 * 0x150000, outside the configuration region, so **it is outside every backup
 * boofwang has ever taken** - not a `.bwp`, not a stored backup, not a fixture.
 * A codeplug can be rebuilt from a CSV. The factory splash cannot be rebuilt
 * from anything, and the only copy that will ever exist is the one taken before
 * the first write. So nothing here writes without having read first, in the
 * same session, and the read is handed to the caller to keep.
 */
export function useBootImage() {
  const device = useDeviceStore()
  const transfer = useTransferStore()
  const toast = useToast()

  /** What the radio held when this session started, and the only way back. */
  const backup = shallowRef<Uint8Array | null>(null)
  const backupTakenAt = ref<string | null>(null)
  const busy = ref(false)

  /**
   * The whole region, not only the picture.
   *
   * The picture is 153,600 bytes and the region is 155,648 - exactly 38 pages -
   * and the difference matters twice. It lets the write go out entirely through
   * the 4 KiB form the radio is confirmed to accept, instead of the short frame
   * the specification marks derived. And it means the 2,048 bytes past the
   * picture are backed up too: they sit in the same sector the last write
   * touches, they read as 0xFF on the radio seen so far, and having never read
   * them there would be no way to tell erased-by-us from erased-at-the-factory.
   */
  async function withRadio<T>(
    what: string,
    fn: (t: Transport, range: { start: number; end: number }, signal: AbortSignal) => Promise<T>,
  ): Promise<T | null> {
    if (device.currentDriver().id !== 'dm32uv') {
      toast.add({ title: 'Only the DM-32UV has one', description: 'No other radio here stores a startup picture.', color: 'neutral' })
      return null
    }
    busy.value = true
    const signal = transfer.begin(what)
    try {
      const t = device.currentTransport()
      // V-frames answer before programming mode and not after, so the range is
      // asked for first. Reads and writes then need the mode, which `identify`
      // does not enter.
      const range = await queryBootImageRange(t, { signal })
      await enterProgrammingMode(t, { signal })
      return await fn(t, range, signal)
    } catch (e) {
      toast.add({
        title: `Could not ${what.toLowerCase()}`,
        description: e instanceof Error ? e.message : String(e),
        icon: 'i-lucide-circle-alert',
        color: 'error',
        duration: 0,
      })
      return null
    } finally {
      transfer.end()
      busy.value = false
    }
  }

  /** Connect if nothing is, since the click is the gesture Web Serial wants. */
  async function ensureConnected(): Promise<boolean> {
    if (device.connected) return true
    let choice: PortChoice | null
    try {
      choice = await acquirePort()
    } catch (e) {
      toast.add({
        title: 'Could not open a serial port',
        description: e instanceof Error ? e.message : String(e),
        icon: 'i-lucide-cable',
        color: 'error',
        duration: 0,
      })
      return false
    }
    if (!choice) return false
    try {
      await device.connect(choice.port, 'dm32uv', {
        ...choice.info,
        ...(choice.label === undefined ? {} : { label: choice.label }),
      })
      return true
    } catch (e) {
      toast.add({
        title: 'Could not reach the radio',
        description: e instanceof Error ? e.message : String(e),
        icon: 'i-lucide-circle-alert',
        color: 'error',
        duration: 0,
      })
      return false
    }
  }

  /** Read the picture the radio is holding, and keep it as the way back. */
  async function readFromRadio(): Promise<Uint8Array | null> {
    if (!(await ensureConnected())) return null
    const got = await withRadio('Read the startup picture', async (t, range, signal) => {
      const total = range.end - range.start + 1
      const region = new Uint8Array(total)
      for (let off = 0; off < total; off += PAGE_SIZE) {
        const len = Math.min(PAGE_SIZE, total - off)
        const page = await readMemory(t, range.start + off, len, { signal })
        region.set(page, off)
        transfer.report({ phase: 'read', done: off + len, total, label: 'Startup picture' })
      }
      return region
    })
    if (got) {
      backup.value = got
      backupTakenAt.value = new Date().toISOString()
      toast.add({
        title: 'Startup picture read',
        description: 'Keep the download: this region is in no other backup boofwang takes.',
        icon: 'i-lucide-image-down',
        color: 'success',
        duration: 12_000,
      })
    }
    return got
  }

  /**
   * Send a picture, having read one first.
   *
   * `picture` is the 153,600-byte image. The bytes past it come from the
   * backup, so the region goes out whole and nothing outside the picture is
   * invented.
   */
  async function writeToRadio(picture: Uint8Array): Promise<boolean> {
    if (picture.length !== BOOT_IMAGE_BYTES) {
      toast.add({ title: 'That is not a startup picture', description: `${picture.length} bytes, expected ${BOOT_IMAGE_BYTES}.`, color: 'error' })
      return false
    }
    const held = backup.value
    if (!held) {
      // Not a nag. There is genuinely no other copy of what is about to be
      // overwritten, anywhere.
      toast.add({
        title: 'Read the radio first',
        description:
          'The picture on the radio now exists nowhere else, so it has to be read before it can be replaced. ' +
          'Nothing else boofwang stores contains it.',
        icon: 'i-lucide-shield-alert',
        color: 'warning',
        duration: 0,
      })
      return false
    }
    if (!(await ensureConnected())) return false

    const region = new Uint8Array(held)
    region.set(picture, 0)

    const ok = await withRadio('Write the startup picture', async (t, range, signal) => {
      if (region.length !== range.end - range.start + 1) {
        throw new Error(
          `This radio reports a ${range.end - range.start + 1}-byte region and the backup is ${region.length}.`,
        )
      }
      await writeBootImageRegion(t, range, region, {
        signal,
        progress: (done, total) =>
          transfer.report({ phase: done <= total / 2 ? 'write' : 'verify', done, total, label: 'Startup picture' }),
      })
      return true
    })
    if (ok) {
      toast.add({
        title: 'Startup picture written',
        description: 'Every page was read back and matched. Power-cycle the radio to see it.',
        icon: 'i-lucide-circle-check',
        color: 'success',
        duration: 12_000,
      })
    }
    return ok === true
  }

  /** Put back exactly what was read at the start of this session. */
  async function restore(): Promise<boolean> {
    const held = backup.value
    if (!held) return false
    return writeToRadio(held.subarray(0, BOOT_IMAGE_BYTES))
  }

  /** The picture as RGBA, for showing what the radio is holding. */
  function backupPixels() {
    const held = backup.value
    return held ? decodeBootImage(held.subarray(0, BOOT_IMAGE_BYTES)) : null
  }

  return {
    backup,
    backupTakenAt,
    busy,
    readFromRadio,
    writeToRadio,
    restore,
    backupPixels,
    REGION_START: BOOT_IMAGE_REGION_START,
  }
}

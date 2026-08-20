// SPDX-License-Identifier: GPL-3.0-or-later
import { defineStore } from 'pinia'
import type { Channel } from '#core/model/channel.js'
import type { Codeplug } from '#core/model/codeplug.js'
import { sortedChannels } from '#core/model/codeplug.js'
import type { RadioImage } from '#core/radio/image.js'
import { diffRanges, rangesContain } from '#core/codec/struct.js'
import type { Diagnostic, RadioDriver } from '#core/radio/driver.js'
import type { RadioSchema } from '#core/radio/schema.js'

/**
 * The open codeplug.
 *
 * Reactivity here is deliberately shallow. The image is hundreds of kilobytes
 * of `Uint8Array` and must never become a reactive proxy; the channel list is a
 * frozen array replaced wholesale on edit, so a change to one row changes one
 * row's identity and Vue re-renders exactly that row rather than four thousand.
 */
export const useCodeplugStore = defineStore('codeplug', () => {
  const image = shallowRef<RadioImage | null>(null)
  const doc = shallowRef<Codeplug | null>(null)
  const schema = shallowRef<RadioSchema | null>(null)
  const channels = shallowRef<readonly Channel[]>([])
  const diagnostics = shallowRef<readonly Diagnostic[]>([])
  const revision = ref(0)
  const dirty = ref(false)

  const isOpen = computed(() => doc.value !== null)
  const channelCount = computed(() => channels.value.length)
  const rxOnlyCount = computed(() => channels.value.filter((c) => !c.txAllowed).length)

  const errorCount = computed(() => diagnostics.value.filter((d) => d.severity === 'error').length)
  const warningCount = computed(() => diagnostics.value.filter((d) => d.severity === 'warning').length)

  /** Kept so edits can be re-validated and re-encoded without the caller re-supplying it. */
  const driverRef = shallowRef<RadioDriver | null>(null)

  function load(newImage: RadioImage, driver: RadioDriver) {
    driverRef.value = markRaw(driver)
    // markRaw: a reactive typed array of this size creates a dependency entry
    // per byte and freezes the tab.
    image.value = markRaw(newImage)
    const decoded = driver.decode(newImage)
    doc.value = markRaw(decoded)
    schema.value = markRaw(driver.schema)
    channels.value = Object.freeze(sortedChannels(decoded).map((c) => Object.freeze(c)))
    diagnostics.value = Object.freeze(driver.validate(decoded))
    revision.value++
    dirty.value = false
  }

  function close() {
    driverRef.value = null
    image.value = null
    doc.value = null
    schema.value = null
    channels.value = []
    diagnostics.value = []
    dirty.value = false
    revision.value++
  }

  /** Copy-on-write at one index, so only that row's identity changes. */
  function updateChannel(index: number, patch: Partial<Channel>) {
    const list = channels.value
    const at = list.findIndex((c) => c.index === index)
    if (at < 0) return
    const next = Object.freeze({ ...list[at]!, ...patch })
    const copy = list.slice()
    copy[at] = next
    channels.value = Object.freeze(copy)
    doc.value?.channels.set(index, next)
    revalidate()
    revision.value++
    dirty.value = true
  }

  /** Remove a channel. The slot is erased on the radio when the image is written. */
  function deleteChannel(index: number) {
    if (!doc.value?.channels.delete(index)) return
    channels.value = Object.freeze(channels.value.filter((c) => c.index !== index))
    revalidate()
    revision.value++
    dirty.value = true
  }

  function revalidate() {
    const d = driverRef.value
    const cp = doc.value
    diagnostics.value = d && cp ? Object.freeze(d.validate(cp)) : []
  }

  /**
   * The edited codeplug rendered back onto the image it was read from.
   *
   * A `computed`, so it is evaluated when something asks for it - the diff
   * preview or a write - rather than on every keystroke. Encoding 214 channel
   * records for each character typed into a name field would be pure waste.
   */
  const encoded = computed<RadioImage | null>(() => {
    void revision.value
    const d = driverRef.value
    const cp = doc.value
    const base = image.value
    if (!d || !cp || !base) return null
    try {
      return markRaw(d.encode(cp, base))
    } catch {
      // A codeplug the radio cannot represent (an unsupported tone, a split on
      // a radio without one). The write gate surfaces the reason; here it just
      // means there is nothing to preview.
      return null
    }
  })

  /** Why `encoded` is null, when it is. Surfaced by the write gate. */
  const encodeError = computed<string | null>(() => {
    void revision.value
    const d = driverRef.value
    const cp = doc.value
    const base = image.value
    if (!d || !cp || !base) return null
    try {
      d.encode(cp, base)
      return null
    } catch (e) {
      return e instanceof Error ? e.message : String(e)
    }
  })

  /**
   * Which 128-byte blocks differ from what the radio holds, and what changed.
   *
   * This is what the user is shown before a write. A change landing outside the
   * ranges the driver claims to own is reported as such, because that means the
   * encoder has a bug and the write must not proceed.
   */
  const pendingWrite = computed(() => {
    void revision.value
    const d = driverRef.value
    const base = image.value
    const next = encoded.value
    if (!d || !base || !next) return null

    const baseRegion = base.regions.find((r) => !r.readOnly)
    const nextRegion = next.regions.find((r) => !r.readOnly)
    if (!baseRegion || !nextRegion) return null

    const ranges = diffRanges(baseRegion.data, nextRegion.data)
    const owned = d.ownedRanges(baseRegion.start)
    const unowned = ranges.filter((r) => !rangesContain(owned, r))

    const blocks = new Set<number>()
    let bytes = 0
    for (const [s, e] of ranges) {
      bytes += e - s
      for (let a = Math.floor(s / 0x80) * 0x80; a < e; a += 0x80) blocks.add(a)
    }

    return {
      ranges,
      unowned,
      changedBytes: bytes,
      changedBlocks: [...blocks].sort((a, b) => a - b),
    }
  })

  const diagnosticsByChannel = computed(() => {
    const map = new Map<number, Diagnostic[]>()
    for (const d of diagnostics.value) {
      if (d.channel === undefined) continue
      const list = map.get(d.channel)
      if (list) list.push(d)
      else map.set(d.channel, [d])
    }
    return map
  })

  return {
    image,
    doc,
    schema,
    driverRef,
    encoded,
    encodeError,
    pendingWrite,
    deleteChannel,
    revalidate,
    channels,
    diagnostics,
    diagnosticsByChannel,
    revision,
    dirty,
    isOpen,
    channelCount,
    rxOnlyCount,
    errorCount,
    warningCount,
    load,
    close,
    updateChannel,
  }
})

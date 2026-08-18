// SPDX-License-Identifier: GPL-3.0-or-later
import { defineStore } from 'pinia'
import type { Channel } from '#core/model/channel.js'
import type { Codeplug } from '#core/model/codeplug.js'
import { sortedChannels } from '#core/model/codeplug.js'
import type { RadioImage } from '#core/radio/image.js'
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

  function load(newImage: RadioImage, driver: RadioDriver) {
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
    revision.value++
    dirty.value = true
  }

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

// SPDX-License-Identifier: GPL-3.0-or-later
import { defineStore } from 'pinia'
import type { Channel } from '#core/model/channel.js'
import { hz } from '#core/model/units.js'
import type { Codeplug } from '#core/model/codeplug.js'
import { sortedChannels } from '#core/model/codeplug.js'
import type { RadioImage } from '#core/radio/image.js'
import { diffImages } from '#core/radio/diff.js'
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
  const zones = shallowRef<readonly Codeplug['zones'][number][]>([])
  const talkGroups = shallowRef<readonly Codeplug['talkGroups'][number][]>([])
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
    zones.value = Object.freeze(decoded.zones.map((z) => Object.freeze(z)))
    talkGroups.value = Object.freeze(decoded.talkGroups.map((g) => Object.freeze(g)))
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
    zones.value = []
    talkGroups.value = []
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

  /** Add or replace a key slot. */
  function setEncryptionKey(key: Codeplug['encryptionKeys'][number]) {
    const cp = doc.value
    if (!cp) return
    const at = cp.encryptionKeys.findIndex((k) => k.slot === key.slot)
    if (at >= 0) cp.encryptionKeys[at] = key
    else cp.encryptionKeys.push({ ...key })
    cp.encryptionKeys.sort((a, b) => a.slot - b.slot)
    revalidate()
    revision.value++
    dirty.value = true
  }

  function removeEncryptionKey(slot: number) {
    const cp = doc.value
    if (!cp) return
    const before = cp.encryptionKeys.length
    cp.encryptionKeys = cp.encryptionKeys.filter((k) => k.slot !== slot)
    if (cp.encryptionKeys.length === before) return
    revalidate()
    revision.value++
    dirty.value = true
  }

  /** Remove a channel. The slot is erased on the radio when the image is written. */
  /**
   * Program an empty slot.
   *
   * `updateChannel` deliberately does nothing for a slot that holds no channel,
   * which left the editor able to change and delete but never create - the one
   * missing verb. The defaults come from the schema rather than a constant, so
   * a new channel lands inside a band the radio actually covers and at a power
   * level it actually has.
   *
   * Nothing is written to the radio here. The driver decides what an empty slot
   * becoming programmed means on the wire, which on at least one radio includes
   * clearing bits that read as set in erased flash.
   */
  function createChannel(index: number): Channel | null {
    const cp = doc.value
    const schema = driverRef.value?.schema
    if (!cp || !schema || cp.channels.has(index)) return null

    const band = schema.rf.bands.find((b) => b.txAllowed) ?? schema.rf.bands[0]
    if (!band) return null

    const created: Channel = Object.freeze<Channel>({
      index,
      name: '',
      rxFreq: band.loHz,
      tx: { kind: 'simplex' },
      txAllowed: band.txAllowed,
      ...(band.txAllowed ? {} : { txInhibitReason: `${band.label} is receive-only` }),
      tone: { rx: null, tx: null, rxInverted: false },
      modulation: schema.rf.modulations[0] ?? 'FM',
      bandwidthHz: schema.rf.bandwidths[0] ?? 12_500,
      // The lowest level the radio has, not the highest. A new channel should
      // not arrive at full power by default, and the first entry of a schema
      // carrying more than one variant's table may be a level this radio does
      // not have at all.
      power: (() => {
        const lowest = [...schema.rf.powerLevels].sort((a, b) => a.mW - b.mW)[0]!
        return { mW: lowest.mW, label: lowest.label }
      })(),
      tuningStep: schema.rf.tuningSteps[0] ?? hz(5000),
      skip: 'none',
      comment: '',
      extras: {},
    })

    cp.channels.set(index, created)
    channels.value = Object.freeze(
      [...channels.value, created].sort((a, b) => a.index - b.index),
    )
    revalidate()
    revision.value++
    dirty.value = true
    return created
  }

  /**
   * Rename a zone.
   *
   * The name is the only part of a zone this build writes. A zone's channel
   * list is a set of absolute channel numbers, and what the radio does with one
   * pointing at a slot that has since been emptied has not been established -
   * so membership is shown but not edited, rather than edited and silently
   * dropped at encode time.
   */
  function renameZone(id: string, name: string) {
    const cp = doc.value
    if (!cp) return
    const i = cp.zones.findIndex((z) => z.id === id)
    if (i < 0 || cp.zones[i]!.name === name) return
    cp.zones[i] = { ...cp.zones[i]!, name }
    zones.value = Object.freeze(cp.zones.map((z) => Object.freeze(z)))
    revalidate()
    revision.value++
    dirty.value = true
  }

  /** Rename a talk group. Its number and call type come from the radio. */
  function renameTalkGroup(id: string, name: string) {
    const cp = doc.value
    if (!cp) return
    const i = cp.talkGroups.findIndex((g) => g.id === id)
    if (i < 0 || cp.talkGroups[i]!.name === name) return
    cp.talkGroups[i] = { ...cp.talkGroups[i]!, name }
    talkGroups.value = Object.freeze(cp.talkGroups.map((g) => Object.freeze(g)))
    revalidate()
    revision.value++
    dirty.value = true
  }

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

    return diffImages(base, next, d)
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
    createChannel,
    deleteChannel,
    renameZone,
    renameTalkGroup,
    setEncryptionKey,
    removeEncryptionKey,
    revalidate,
    channels,
    zones,
    talkGroups,
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

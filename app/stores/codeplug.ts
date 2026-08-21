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
  const scanLists = shallowRef<readonly Codeplug['scanLists'][number][]>([])
  const rxGroups = shallowRef<readonly Codeplug['rxGroups'][number][]>([])
  const radioIds = shallowRef<readonly Codeplug['radioIds'][number][]>([])
  const contacts = shallowRef<readonly Codeplug['contacts'][number][]>([])
  const messages = shallowRef<readonly string[]>([])
  const roamChannels = shallowRef<readonly Codeplug['roamChannels'][number][]>([])
  const roamZones = shallowRef<readonly Codeplug['roamZones'][number][]>([])
  const callList = shallowRef<readonly Codeplug['callList'][number][]>([])
  const emergency = shallowRef<readonly Codeplug['emergency'][number][]>([])
  const analog = shallowRef<Codeplug['analog']>(null)
  const settings = shallowRef<Readonly<Record<string, unknown>>>({})
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
    schema.value = markRaw(driver.schema)
    publish(driver.decode(newImage))
    revision.value++
    dirty.value = false
  }

  /**
   * Point every rendered list at a different document.
   *
   * Split out of `load` because a document does not only ever arrive by
   * decoding an image: a codeplug transplanted from another radio of the same
   * model is built from two documents and never had an image of its own. The
   * image the store holds stays the one that was read from *this* radio, which
   * is what `encode(doc, base)` needs to keep the calibration and the
   * undecoded bytes belonging to the unit in front of the user.
   */
  function publish(next: Codeplug) {
    doc.value = markRaw(next)
    channels.value = Object.freeze(sortedChannels(next).map((c) => Object.freeze(c)))
    zones.value = Object.freeze(next.zones.map((z) => Object.freeze(z)))
    talkGroups.value = Object.freeze(next.talkGroups.map((g) => Object.freeze(g)))
    scanLists.value = Object.freeze(next.scanLists.map((l) => Object.freeze(l)))
    rxGroups.value = Object.freeze(next.rxGroups.map((g) => Object.freeze(g)))
    radioIds.value = Object.freeze(next.radioIds.map((r) => Object.freeze(r)))
    contacts.value = Object.freeze(next.contacts.map((c) => Object.freeze(c)))
    messages.value = Object.freeze([...next.messages])
    roamChannels.value = Object.freeze(next.roamChannels.map((c) => Object.freeze(c)))
    roamZones.value = Object.freeze(next.roamZones.map((z) => Object.freeze(z)))
    callList.value = Object.freeze(next.callList.map((c) => Object.freeze(c)))
    emergency.value = Object.freeze(next.emergency.map((e) => Object.freeze(e)))
    analog.value = next.analog ? Object.freeze(next.analog) : null
    settings.value = Object.freeze({ ...next.settings })
    revalidate()
  }

  /**
   * Adopt a document built elsewhere as an unsaved edit.
   *
   * Deliberately marked dirty rather than treated as a fresh read: the radio
   * has not been told any of this yet, so the write gate must still see a
   * pending change and the write page must still show the diff and ask for the
   * word. Refused when nothing is open, because there would be no base image to
   * render it onto and no way to write it.
   */
  function replaceDocument(next: Codeplug) {
    if (!doc.value || !driverRef.value) return
    publish(next)
    revision.value++
    dirty.value = true
  }

  function close() {
    driverRef.value = null
    image.value = null
    doc.value = null
    schema.value = null
    channels.value = []
    zones.value = []
    talkGroups.value = []
    scanLists.value = []
    rxGroups.value = []
    radioIds.value = []
    contacts.value = []
    messages.value = []
    roamChannels.value = []
    roamZones.value = []
    callList.value = []
    emergency.value = []
    analog.value = null
    settings.value = {}
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

  /**
   * Re-publish one list after mutating the document behind it.
   *
   * The document holds plain arrays that the driver encodes from; the store
   * holds frozen copies that Vue renders from. Every mutation below changes the
   * first and then republishes the second, so a component never sees a
   * half-updated list and `:key` identity changes for exactly the rows that
   * moved.
   */
  function republish() {
    const cp = doc.value
    if (!cp) return
    zones.value = Object.freeze(cp.zones.map((z) => Object.freeze(z)))
    talkGroups.value = Object.freeze(cp.talkGroups.map((g) => Object.freeze(g)))
    scanLists.value = Object.freeze(cp.scanLists.map((l) => Object.freeze(l)))
    rxGroups.value = Object.freeze(cp.rxGroups.map((g) => Object.freeze(g)))
    radioIds.value = Object.freeze(cp.radioIds.map((r) => Object.freeze(r)))
    contacts.value = Object.freeze(cp.contacts.map((c) => Object.freeze(c)))
    messages.value = Object.freeze([...cp.messages])
    roamChannels.value = Object.freeze(cp.roamChannels.map((c) => Object.freeze(c)))
    roamZones.value = Object.freeze(cp.roamZones.map((z) => Object.freeze(z)))
    callList.value = Object.freeze(cp.callList.map((c) => Object.freeze(c)))
    settings.value = Object.freeze({ ...cp.settings })
    revalidate()
    revision.value++
    dirty.value = true
  }

  /**
   * Only the channels that are actually there.
   *
   * The encoder drops a member it cannot resolve, so keeping one in the
   * document would show a list the radio will not receive - "3 channels:
   * 1-2, 9999" for a write that stores two.
   */
  function liveChannels(cp: Codeplug, wanted: number[]): number[] {
    return wanted.filter((c) => cp.channels.has(c))
  }

  /** Replace which channels a zone contains. Numbers are absolute channel slots. */
  function setZoneChannels(id: string, channels: number[]) {
    const cp = doc.value
    if (!cp) return
    const i = cp.zones.findIndex((z) => z.id === id)
    if (i < 0) return
    cp.zones[i] = { ...cp.zones[i]!, channels: liveChannels(cp, channels) }
    republish()
  }

  function renameScanList(id: string, name: string) {
    const cp = doc.value
    if (!cp) return
    const i = cp.scanLists.findIndex((l) => l.id === id)
    if (i < 0 || cp.scanLists[i]!.name === name) return
    cp.scanLists[i] = { ...cp.scanLists[i]!, name }
    republish()
  }

  function setScanListChannels(id: string, channels: number[]) {
    const cp = doc.value
    if (!cp) return
    const i = cp.scanLists.findIndex((l) => l.id === id)
    if (i < 0) return
    cp.scanLists[i] = { ...cp.scanLists[i]!, channels: liveChannels(cp, channels) }
    republish()
  }

  function renameRxGroup(id: string, name: string) {
    const cp = doc.value
    if (!cp) return
    const i = cp.rxGroups.findIndex((g) => g.id === id)
    if (i < 0 || cp.rxGroups[i]!.name === name) return
    cp.rxGroups[i] = { ...cp.rxGroups[i]!, name }
    republish()
  }

  function setRxGroupIds(id: string, dmrIds: number[]) {
    const cp = doc.value
    if (!cp) return
    const i = cp.rxGroups.findIndex((g) => g.id === id)
    if (i < 0) return
    cp.rxGroups[i] = { ...cp.rxGroups[i]!, dmrIds: [...dmrIds] }
    republish()
  }

  function updateRadioId(id: string, patch: { name?: string; dmrId?: number }) {
    const cp = doc.value
    if (!cp) return
    const i = cp.radioIds.findIndex((r) => r.id === id)
    if (i < 0) return
    cp.radioIds[i] = { ...cp.radioIds[i]!, ...patch }
    republish()
  }

  function addRadioId() {
    const cp = doc.value
    if (!cp) return
    cp.radioIds.push({ id: `rid-new-${crypto.randomUUID()}`, name: '', dmrId: 0 })
    republish()
  }

  function removeRadioId(id: string) {
    const cp = doc.value
    if (!cp) return
    const i = cp.radioIds.findIndex((r) => r.id === id)
    if (i < 0) return
    cp.radioIds.splice(i, 1)
    republish()
  }

  function updateContact(id: string, patch: Partial<Codeplug['contacts'][number]>) {
    const cp = doc.value
    if (!cp) return
    const i = cp.contacts.findIndex((c) => c.id === id)
    if (i < 0) return
    cp.contacts[i] = { ...cp.contacts[i]!, ...patch }
    republish()
  }

  function addContact() {
    const cp = doc.value
    if (!cp) return
    // Not derived from the length: removing one and adding another would reuse
    // the id, and every edit keys on it.
    cp.contacts.push({
      id: `contact-new-${crypto.randomUUID()}`,
      name: '',
      dmrId: 0,
      callsign: '',
      city: '',
      province: '',
      country: '',
      remark: '',
    })
    republish()
  }

  function removeContact(id: string) {
    const cp = doc.value
    if (!cp) return
    const i = cp.contacts.findIndex((c) => c.id === id)
    if (i < 0) return
    cp.contacts.splice(i, 1)
    republish()
  }

  function setMessage(index: number, text: string) {
    const cp = doc.value
    if (!cp || cp.messages[index] === text) return
    cp.messages[index] = text
    republish()
  }

  function addMessage() {
    const cp = doc.value
    const limit = schema.value?.features.messages
    // Refuse at the radio's own limit rather than letting the encoder throw:
    // a DriverError surfaces as a write blocker, which is a dead end reached by
    // clicking a button the interface offered.
    if (!cp || !limit || cp.messages.length >= limit.max) return
    cp.messages.push('')
    republish()
  }

  function removeMessage(index: number) {
    const cp = doc.value
    if (!cp || index < 0 || index >= cp.messages.length) return
    cp.messages.splice(index, 1)
    republish()
  }

  function updateRoamZone(id: string, patch: Partial<Codeplug['roamZones'][number]>) {
    const cp = doc.value
    if (!cp) return
    const i = cp.roamZones.findIndex((z) => z.id === id)
    if (i < 0) return
    cp.roamZones[i] = { ...cp.roamZones[i]!, ...patch }
    republish()
  }

  function updateCallListEntry(id: string, patch: Partial<Codeplug['callList'][number]>) {
    const cp = doc.value
    if (!cp) return
    const i = cp.callList.findIndex((c) => c.id === id)
    if (i < 0) return
    cp.callList[i] = { ...cp.callList[i]!, ...patch }
    republish()
  }

  function updateRoamChannel(id: string, patch: Partial<Codeplug['roamChannels'][number]>) {
    const cp = doc.value
    if (!cp) return
    const i = cp.roamChannels.findIndex((c) => c.id === id)
    if (i < 0) return
    cp.roamChannels[i] = { ...cp.roamChannels[i]!, ...patch }
    republish()
  }

  function addZone() {
    const cp = doc.value
    const limit = schema.value?.features.zones
    if (!cp || !limit || cp.zones.length >= limit.max) return
    cp.zones.push({ id: `zone-new-${cp.zones.length + 1}`, name: '', channels: [] })
    republish()
  }

  function removeZone(id: string) {
    const cp = doc.value
    if (!cp) return
    const i = cp.zones.findIndex((z) => z.id === id)
    if (i < 0) return
    cp.zones.splice(i, 1)
    republish()
  }

  function addTalkGroup() {
    const cp = doc.value
    const limit = schema.value?.features.talkGroups
    if (!cp || !limit || cp.talkGroups.length >= limit.max) return
    cp.talkGroups.push({ id: `tg-new-${cp.talkGroups.length + 1}`, name: '', number: 0, callType: 'group' })
    republish()
  }

  function removeTalkGroup(id: string) {
    const cp = doc.value
    if (!cp) return
    const i = cp.talkGroups.findIndex((g) => g.id === id)
    if (i < 0) return
    cp.talkGroups.splice(i, 1)
    republish()
  }

  /** A talk group's number and call type, which the radio stores beside its name. */
  function updateTalkGroup(id: string, patch: { number?: number; callType?: Codeplug['talkGroups'][number]['callType'] }) {
    const cp = doc.value
    if (!cp) return
    const i = cp.talkGroups.findIndex((g) => g.id === id)
    if (i < 0) return
    cp.talkGroups[i] = { ...cp.talkGroups[i]!, ...patch }
    republish()
  }

  /** Change one radio setting. The key is the one the schema's FieldSpec names. */
  function setSetting(key: string, value: unknown) {
    const cp = doc.value
    if (!cp || cp.settings[key] === value) return
    cp.settings[key] = value
    republish()
  }

  function deleteChannel(index: number) {
    const cp = doc.value
    if (!cp?.channels.delete(index)) return
    channels.value = Object.freeze(channels.value.filter((c) => c.index !== index))

    // Take it out of everything that points at it, in the same edit.
    //
    // Channel numbers are absolute and deleting one deliberately does not
    // renumber the rest, so every other membership entry stays valid. But a
    // zone still pointing at the emptied slot is the one case this radio's
    // bytes could not settle, and the cheapest way to never rely on the answer
    // is to never create it.
    cp.zones = cp.zones.map((z) =>
      z.channels.includes(index) ? { ...z, channels: z.channels.filter((c) => c !== index) } : z,
    )
    cp.scanLists = cp.scanLists.map((l) =>
      l.channels.includes(index) ? { ...l, channels: l.channels.filter((c) => c !== index) } : l,
    )
    republish()
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
    addZone,
    removeZone,
    addTalkGroup,
    removeTalkGroup,
    updateTalkGroup,
    setZoneChannels,
    renameScanList,
    setScanListChannels,
    renameRxGroup,
    setRxGroupIds,
    updateRadioId,
    addRadioId,
    removeRadioId,
    updateContact,
    addContact,
    removeContact,
    setMessage,
    addMessage,
    removeMessage,
    updateRoamChannel,
    updateRoamZone,
    updateCallListEntry,
    setSetting,
    setEncryptionKey,
    removeEncryptionKey,
    revalidate,
    channels,
    zones,
    talkGroups,
    scanLists,
    rxGroups,
    radioIds,
    contacts,
    messages,
    roamChannels,
    roamZones,
    callList,
    emergency,
    analog,
    settings,
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
    replaceDocument,
    close,
    updateChannel,
  }
})

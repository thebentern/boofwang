// SPDX-License-Identifier: GPL-3.0-or-later
// Vue's reactivity is imported rather than left to Nuxt's auto-imports, unlike
// the other two stores: the undo history is exercised by a spec that mounts
// this store under a bare Pinia, and outside the Nuxt build there is nothing to
// supply `ref` and `computed`. Nuxt takes an explicit import in preference to
// its own, so nothing changes for the app.
import { computed, markRaw, ref, shallowRef } from 'vue'
import { defineStore } from 'pinia'
import type { Channel } from '#core/model/channel.js'
import { hz } from '#core/model/units.js'
import type { Codeplug, ScanList, Zone } from '#core/model/codeplug.js'
import { sortedChannels } from '#core/model/codeplug.js'
import type { RadioImage } from '#core/radio/image.js'
import { diffImages } from '#core/radio/diff.js'
import type { Diagnostic, RadioDriver } from '#core/radio/driver.js'
import type { RadioSchema } from '#core/radio/schema.js'
import type { ChannelOrder, RenumberPlan } from '#core/radio/renumber.js'
import { applyRenumber, planChangesSomething, planFitsDocument, planRenumber } from '#core/radio/renumber.js'

/** How many user-visible actions the history remembers. */
const HISTORY_LIMIT = 50

/** What the undo affordance calls each ordering. */
const RENUMBER_LABEL: Record<ChannelOrder, string> = {
  slot: 'close the gaps',
  name: 'sort by name',
  frequency: 'sort by frequency',
}

/** The two lists that name channels by number, and so have to be patched alongside them. */
type MemberList = 'zones' | 'scanLists'

/**
 * One memory slot as it stood before an action.
 *
 * `null` means the slot held nothing, which is what lets a create, a delete and
 * an edit all be the same shape of patch: creating undoes to `null`, deleting
 * undoes to the record that was there.
 */
interface SlotPatch {
  readonly slot: number
  readonly record: Channel | null
}

/**
 * One channel's place in one zone or scan list, as it stood before an action.
 *
 * Deleting a channel takes it out of everything that points at it, and an undo
 * that brought the channel back without its memberships would leave the user
 * looking at a codeplug they never made. `at` is the position it held rather
 * than merely the fact of it, so a restore puts it back in order.
 */
interface MemberPatch {
  readonly list: MemberList
  readonly id: string
  readonly channel: number
  readonly at: number | null
}

/**
 * The lists outside the channel bank, whole, as they stood before an action.
 *
 * A positional `MemberPatch` says "channel 12 was third in this zone", which is
 * the cheap way to take back a delete. It cannot express a renumber: that
 * changes which *numbers* a list holds rather than where they sit, and every
 * entry of every list at once. Recording it as patches would be one per entry
 * with an ordering to get right, and getting it wrong leaves a zone holding the
 * right channels in the wrong order - which on the radio is a zone somebody
 * has to fix by hand.
 *
 * So a renumber records a copy instead. It is absolute, like a slot patch, so
 * it goes back in any order; the arrays are small objects rather than anything
 * holding a `Uint8Array`; and it is captured only by the action that needs it.
 *
 * Settings are in here because on the DM-32UV eight of them hold channel
 * numbers, and an undo that moved the channels back while leaving those
 * pointing at the new numbers would be the same "codeplug nobody made" that
 * `replaceDocument` refuses to create.
 */
interface DocPatch {
  readonly zones: readonly Zone[]
  readonly scanLists: readonly ScanList[]
  readonly settings: Readonly<Record<string, unknown>>
}

/**
 * One user-visible action, stored as what it changed things *from*.
 *
 * This is what makes the history affordable. An entry is a handful of slot
 * numbers and the records that were in them, so taking back a preset stage of
 * twenty channels costs twenty small objects rather than a copy of four
 * thousand - and nothing here is ever a `Uint8Array`.
 */
interface HistoryEntry {
  readonly label: string
  readonly slots: readonly SlotPatch[]
  readonly members: readonly MemberPatch[]
  /** Present only for an action that rewrote the lists wholesale. See `DocPatch`. */
  readonly doc: DocPatch | null
  /**
   * `dirty` as it stood before the action.
   *
   * Carried so that undoing back to what the radio holds says so, rather than
   * leaving the status bar claiming unwritten edits that no longer exist.
   */
  readonly dirtyBefore: boolean
  /** The `foreignEdits` count when the action started. See that field. */
  readonly foreignEdits: number
}

/**
 * The action currently being recorded.
 *
 * `depth` is what makes grouping nest: an inner `transact` joins the group
 * already open instead of starting its own, so `deleteChannel` is written the
 * same way whether it is called on its own or from inside a bulk edit.
 */
interface Batch {
  depth: number
  readonly label: string
  /** Keyed by slot, because only the first value seen in an action is the one to undo to. */
  readonly slots: Map<number, SlotPatch>
  readonly members: MemberPatch[]
  doc: DocPatch | null
  readonly lists: Set<MemberList>
  readonly dirtyBefore: boolean
  readonly foreignEdits: number
  /** False while undo or redo is replaying: those push the inverse onto the opposite stack themselves. */
  readonly record: boolean
}

/** Where a channel sits in a membership list, or null when it is not in it. */
function positionOf(channels: readonly number[], channel: number): number | null {
  const at = channels.indexOf(channel)
  return at === -1 ? null : at
}

/** That list with the channel moved to `at`, or taken out when `at` is null. */
function withMember(channels: readonly number[], channel: number, at: number | null): number[] {
  const next = channels.filter((c) => c !== channel)
  if (at !== null) next.splice(at, 0, channel)
  return next
}

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

  // ----------------------------------------------------------------- history

  /*
   * The two stacks, and the action being recorded into one of them.
   *
   * Plain closure state rather than refs, and never returned. Pinia wraps what
   * a setup store returns in `reactive()`, so an exposed array of entries would
   * become a deep proxy over every frozen `Channel` it holds - which is exactly
   * the cost the frozen copy-on-write list exists to avoid, paid a second time
   * and per edit. Components read `canUndo`, `canRedo` and the labels instead,
   * and those are driven by the four small refs below.
   */
  const undoStack: HistoryEntry[] = []
  const redoStack: HistoryEntry[] = []
  let batch: Batch | null = null

  /**
   * Edits this history does not record: settings, zones, contacts, messages, keys.
   *
   * Counted rather than flagged so an undo can tell "nothing else has changed
   * since this action" from "something has". Without it, undoing the first
   * channel edit would clear `dirty` and re-lock the write gate while a
   * settings change was still sitting unwritten.
   *
   * Every one of those edits goes through `markEdited`, which is the only place
   * outside the transaction machinery that marks the codeplug unwritten. Having
   * the count and the flag move together is what stops a mutation being added
   * later that marks it dirty without telling the history about it - the one
   * way an undo can end up claiming there is nothing to write when there is.
   */
  let foreignEdits = 0

  /**
   * Close an edit the history does not record.
   *
   * The common tail of every mutation below that is not a channel: count it,
   * re-run the diagnostics, move the revision so `encoded` and the diff
   * recompute, and mark the codeplug unwritten. It exists as one function
   * rather than four repeated lines because the count is easy to leave out and
   * leaving it out is silent - the zone rename still shows, it is still
   * encoded, and the only symptom is an undo two edits later deciding the
   * codeplug is clean and the write gate refusing to send it.
   */
  function markEdited() {
    foreignEdits++
    revalidate()
    revision.value++
    dirty.value = true
  }

  const undoDepth = ref(0)
  const redoDepth = ref(0)
  const undoLabel = ref('')
  const redoLabel = ref('')

  const canUndo = computed(() => undoDepth.value > 0)
  const canRedo = computed(() => redoDepth.value > 0)

  /** Mirror the stacks into the refs components watch. The stacks themselves stay unreactive. */
  function syncHistory() {
    undoDepth.value = undoStack.length
    redoDepth.value = redoStack.length
    undoLabel.value = undoStack[undoStack.length - 1]?.label ?? ''
    redoLabel.value = redoStack[redoStack.length - 1]?.label ?? ''
  }

  /** Forget every recorded action. Undoing across a different codeplug would be incoherent. */
  function clearHistory() {
    undoStack.length = 0
    redoStack.length = 0
    batch = null
    foreignEdits = 0
    syncHistory()
  }

  function openBatch(label: string, record: boolean) {
    if (batch) {
      batch.depth++
      return
    }
    batch = {
      depth: 1,
      label,
      slots: new Map(),
      members: [],
      doc: null,
      lists: new Set(),
      dirtyBefore: dirty.value,
      foreignEdits,
      record,
    }
  }

  /**
   * Publish what the action touched, and hand back the patch that would undo it.
   *
   * Returns null while an enclosing group is still open, and for an action that
   * touched no slot at all - a transmit fix over channels that were already
   * receive-only, an edit aimed at a slot that holds nothing. Recording those
   * would put steps in the history that visibly do nothing when taken back.
   *
   * An action that wrote the same value back is still recorded, because telling
   * that apart means comparing two channel records field by field on every
   * keystroke. The callers that can cheaply tell - the cell editor comparing
   * its draft, the fix skipping channels already inhibited - do so instead, and
   * they are the ones a user can trigger by accident.
   */
  function closeBatch(): HistoryEntry | null {
    const b = batch
    if (!b || --b.depth > 0) return null
    batch = null
    if (b.slots.size === 0 && b.members.length === 0 && !b.doc) return null

    const cp = doc.value
    if (cp) {
      if (b.slots.size > 0) publishChannels(b.slots.keys())
      if (b.doc || b.lists.has('zones')) zones.value = Object.freeze(cp.zones.map((z) => Object.freeze(z)))
      if (b.doc || b.lists.has('scanLists')) {
        scanLists.value = Object.freeze(cp.scanLists.map((l) => Object.freeze(l)))
      }
      if (b.doc) settings.value = Object.freeze({ ...cp.settings })
    }
    revalidate()
    revision.value++
    if (b.record) dirty.value = true

    const inverse: HistoryEntry = {
      label: b.label,
      slots: [...b.slots.values()],
      members: b.members,
      doc: b.doc,
      dirtyBefore: b.dirtyBefore,
      foreignEdits: b.foreignEdits,
    }
    if (b.record) {
      undoStack.push(inverse)
      // The oldest entry falls off rather than the newest being refused: the
      // edit someone wants back is almost always the one they just made.
      if (undoStack.length > HISTORY_LIMIT) undoStack.shift()
      redoStack.length = 0
      syncHistory()
    }
    return inverse
  }

  /**
   * Note what a slot held before this action, once per action.
   *
   * First write wins. A preset stage shifts a channel out of slot 22 and then
   * puts another one in, and undoing that has to arrive at what was in 22
   * before the stage - not at the value it passed through halfway.
   */
  function noteSlot(slot: number) {
    const cp = doc.value
    if (!batch || !cp || batch.slots.has(slot)) return
    batch.slots.set(slot, { slot, record: cp.channels.get(slot) ?? null })
  }

  function noteMember(list: MemberList, id: string, channel: number, at: number | null) {
    if (!batch) return
    batch.members.push({ list, id, channel, at })
    batch.lists.add(list)
  }

  /**
   * Note the lists outside the channel bank, once per action.
   *
   * Call it *before* changing any of them: first write wins, so a snapshot
   * taken afterwards would record the half-changed state as the thing to undo
   * to. That ordering is also what makes it safe alongside the positional
   * member patches - a replay restores this first, and each member patch then
   * finds the channel already where it says it was and does nothing.
   */
  function noteDoc() {
    const cp = doc.value
    if (!batch || !cp || batch.doc) return
    batch.doc = {
      zones: cp.zones.map((z) => ({ ...z, channels: [...z.channels] })),
      scanLists: cp.scanLists.map((l) => ({ ...l, channels: [...l.channels] })),
      settings: { ...cp.settings },
    }
  }

  /** Put those lists back, recording what they held now so redo can return. */
  function restoreDoc(cp: Codeplug, patch: DocPatch) {
    noteDoc()
    cp.zones = patch.zones.map((z) => ({ ...z, channels: [...z.channels] }))
    cp.scanLists = patch.scanLists.map((l) => ({ ...l, channels: [...l.channels] }))
    cp.settings = { ...patch.settings }
  }

  /**
   * Put a record into a slot, or empty it, as part of the open action.
   *
   * The one place the channel bank changes. An inline edit, a new channel, a
   * delete and a preset stage all funnel through here, so the history cannot
   * miss a change and the frozen list is republished exactly once per action
   * rather than once per slot.
   */
  function writeSlot(slot: number, record: Channel | null) {
    const cp = doc.value
    if (!cp) return
    noteSlot(slot)
    if (record === null) cp.channels.delete(slot)
    else cp.channels.set(slot, record)
  }

  /**
   * Re-publish the frozen channel list after an action.
   *
   * The table's whole performance story rests on this staying copy-on-write. A
   * slice with only the touched positions replaced changes exactly those rows'
   * identity, so one edit re-renders one row of four thousand. Only an action
   * that adds or removes a slot needs the list rebuilt, because that is the
   * only case in which the other rows actually move.
   */
  function publishChannels(touched: Iterable<number>) {
    const cp = doc.value
    if (!cp) return
    const list = channels.value
    const positions = new Map<number, number>()
    for (let i = 0; i < list.length; i++) positions.set(list[i]!.index, i)

    const slots = [...touched]
    for (const slot of slots) {
      if (positions.has(slot) !== cp.channels.has(slot)) {
        channels.value = Object.freeze(sortedChannels(cp).map((c) => Object.freeze(c)))
        return
      }
    }

    const copy = list.slice()
    for (const slot of slots) {
      const at = positions.get(slot)
      // Both sides agreed above, so a slot missing here is one that was empty
      // before the action and is empty after it - a write of null over nothing.
      // There is no position to replace, and indexing by `undefined` would put
      // a stray key on the array the table then renders.
      if (at === undefined) continue
      copy[at] = Object.freeze(cp.channels.get(slot)!)
    }
    channels.value = Object.freeze(copy)
  }

  /** Put a channel back where it sat in a zone or scan list, or take it out again. */
  function applyMember(cp: Codeplug, m: MemberPatch) {
    const list: (Zone | ScanList)[] = m.list === 'zones' ? cp.zones : cp.scanLists
    const i = list.findIndex((e) => e.id === m.id)
    const entry = list[i]
    if (!entry) return
    const now = positionOf(entry.channels, m.channel)
    if (now === m.at) return
    noteMember(m.list, m.id, m.channel, now)
    list[i] = { ...entry, channels: withMember(entry.channels, m.channel, m.at) }
  }

  /**
   * Group a burst of mutations into one undo step.
   *
   * Staging twenty preset channels is one thing the user did, so it has to be
   * one thing they can take back; twenty steps to undo one decision is not a
   * history, it is a chore. Nesting joins the group already open, which is what
   * lets the mutations below be written once and used both ways.
   */
  function transact<T>(label: string, fn: () => T): T {
    openBatch(label, true)
    try {
      return fn()
    } finally {
      closeBatch()
    }
  }

  /**
   * Put the codeplug back the way one recorded patch says it was.
   *
   * The inverse falls out of doing it: applying a patch notes what was there
   * first, so what `closeBatch` hands back is precisely the patch that would
   * restore things as they are now. Undo and redo are therefore the same code
   * moving an entry between the two stacks.
   *
   * Slots and memberships are replayed differently, and the difference is not
   * cosmetic. A slot patch is absolute - `batch.slots` is keyed by slot and
   * first write wins - so those can go back in any order. A membership patch
   * is a *position* in a list, recorded against the list as it stood when that
   * patch was made, so the patches only make sense played back the way they
   * were laid down: last one first. Forwards, deleting channels 2 and 4 from a
   * zone holding 1,2,3,4 undid to 1,2,4,3 - every channel present, the order
   * silently wrong, which on the radio is a zone whose entries have moved.
   * This never showed while the table deleted one channel at a time; the bulk
   * delete is what made two positional edits in one action ordinary.
   */
  function replay(entry: HistoryEntry): HistoryEntry | null {
    const cp = doc.value
    if (!cp) return null
    openBatch(entry.label, false)
    for (const p of entry.slots) writeSlot(p.slot, p.record)
    // The wholesale copy before the positional patches, never after: it is
    // absolute, and putting it back first is what leaves each member patch
    // looking at a list that already agrees with it.
    if (entry.doc) restoreDoc(cp, entry.doc)
    for (let i = entry.members.length - 1; i >= 0; i--) applyMember(cp, entry.members[i]!)
    const inverse = closeBatch()

    // `dirty` walks back with the edits, but only as far as the edits explain.
    // Undoing everything this history knows about really does leave a codeplug
    // the encoder renders byte-for-byte back to what the radio holds, and the
    // write gate should say so rather than offering a write that sends nothing.
    // Anything the history does not record is still unwritten, and the count of
    // those is what keeps this from lying in the other direction.
    dirty.value = entry.dirtyBefore || foreignEdits !== entry.foreignEdits
    return inverse
  }

  function undo() {
    if (!doc.value || undoStack.length === 0) return
    const inverse = replay(undoStack.pop()!)
    if (inverse) redoStack.push(inverse)
    syncHistory()
  }

  function redo() {
    if (!doc.value || redoStack.length === 0) return
    const inverse = replay(redoStack.pop()!)
    if (inverse) undoStack.push(inverse)
    syncHistory()
  }

  function load(newImage: RadioImage, driver: RadioDriver) {
    driverRef.value = markRaw(driver)
    // markRaw: a reactive typed array of this size creates a dependency entry
    // per byte and freezes the tab.
    image.value = markRaw(newImage)
    schema.value = markRaw(driver.schema)
    publish(driver.decode(newImage))
    // Every recorded patch names slots in the codeplug that is being replaced.
    // Applying one to the next radio's channel bank would not fail, which is
    // precisely why it must not be possible.
    clearHistory()
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
   *
   * The history goes, for the same reason it goes on `load`, and it is the same
   * hazard rather than a similar one: every recorded patch names slots in the
   * codeplug being replaced. Cloning a club codeplug over your own and then
   * pressing undo would apply one of those patches to the club's channel bank -
   * it would not fail, it would put one of your old channels back in among
   * theirs. The other half is `dirty`: an entry carries the flag as it stood
   * before its action, so undoing past the merge would clear it and re-lock the
   * write gate with an unwritten clone sitting in the document.
   *
   * So the merge cannot be taken back with undo. That is a real cost and the
   * dialog says so plainly. It is not worth buying back by teaching this
   * history to hold a whole document: the entries are channel slots, a
   * transplant also moves zones, talk groups and contacts, and an undo that
   * restored the channels while leaving the donor's zones pointing at them
   * would be a codeplug nobody made. Nothing has been sent to the radio at this
   * point either way - the write page still shows the diff and still asks for
   * the word.
   */
  function replaceDocument(next: Codeplug) {
    if (!doc.value || !driverRef.value) return
    publish(next)
    clearHistory()
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
    clearHistory()
    dirty.value = false
    revision.value++
  }

  /** Copy-on-write at one index, so only that row's identity changes. */
  function updateChannel(index: number, patch: Partial<Channel>) {
    const current = doc.value?.channels.get(index)
    if (!current) return
    transact('channel edit', () => writeSlot(index, Object.freeze({ ...current, ...patch })))
  }

  /**
   * Put an exact record into a slot, or empty it.
   *
   * The verb bulk placement needs and `updateChannel` cannot express: that one
   * patches a channel that is already there and refuses an empty slot, while
   * staging a preset both moves channels between slots and programmes slots
   * that held nothing. Wrap a run of these in `transact` and they take back as
   * the single action they were.
   */
  function setChannelRecord(index: number, record: Channel | null) {
    if (!doc.value) return
    transact('placement', () => writeSlot(index, record))
  }

  /** Add or replace a key slot. */
  function setEncryptionKey(key: Codeplug['encryptionKeys'][number]) {
    const cp = doc.value
    if (!cp) return
    const at = cp.encryptionKeys.findIndex((k) => k.slot === key.slot)
    if (at >= 0) cp.encryptionKeys[at] = key
    else cp.encryptionKeys.push({ ...key })
    cp.encryptionKeys.sort((a, b) => a.slot - b.slot)
    markEdited()
  }

  function removeEncryptionKey(slot: number) {
    const cp = doc.value
    if (!cp) return
    const before = cp.encryptionKeys.length
    cp.encryptionKeys = cp.encryptionKeys.filter((k) => k.slot !== slot)
    if (cp.encryptionKeys.length === before) return
    markEdited()
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

    transact('new channel', () => writeSlot(index, created))
    return created
  }

  /** Rename a zone. Its membership is edited separately, by `setZoneChannels`. */
  function renameZone(id: string, name: string) {
    const cp = doc.value
    if (!cp) return
    const i = cp.zones.findIndex((z) => z.id === id)
    if (i < 0 || cp.zones[i]!.name === name) return
    cp.zones[i] = { ...cp.zones[i]!, name }
    zones.value = Object.freeze(cp.zones.map((z) => Object.freeze(z)))
    markEdited()
  }

  /** Rename a talk group. Its number and call type come from the radio. */
  function renameTalkGroup(id: string, name: string) {
    const cp = doc.value
    if (!cp) return
    const i = cp.talkGroups.findIndex((g) => g.id === id)
    if (i < 0 || cp.talkGroups[i]!.name === name) return
    cp.talkGroups[i] = { ...cp.talkGroups[i]!, name }
    talkGroups.value = Object.freeze(cp.talkGroups.map((g) => Object.freeze(g)))
    markEdited()
  }

  /**
   * Re-publish one list after mutating the document behind it.
   *
   * The document holds plain arrays that the driver encodes from; the store
   * holds frozen copies that Vue renders from. Every mutation below changes the
   * first and then republishes the second, so a component never sees a
   * half-updated list and `:key` identity changes for exactly the rows that
   * moved.
   *
   * None of these is recorded in the undo history, which is about channels;
   * they announce themselves through `markEdited` instead so that undoing a
   * channel edit cannot claim the codeplug is clean while one of them stands.
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
    markEdited()
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

  /**
   * Add many talk groups at once, from a directory.
   *
   * Not wrapped in `transact`, deliberately, and this is worth stating because
   * wrapping it looks obviously right. The undo history records channel slots
   * and list membership; talk groups, contacts, radio IDs and messages have
   * never been on it, so `transact` here would produce an entry with nothing in
   * it and `closeBatch` would discard it - an import that appeared undoable and
   * was not. Consistent with `addTalkGroup` beside it. Making list entities
   * undoable is a change to the history model, not to this function.
   *
   * The cap is a real constraint here and not an edge case: BrandMeister
   * publishes about 1,800 talk groups and the DM-32UV holds 800, so a bulk
   * import is impossible by construction. What is refused is reported back with
   * a count rather than silently truncated, because a list that stops at 800
   * without saying so looks exactly like a list that fitted.
   *
   * Existing numbers are left alone rather than updated. Someone who renamed a
   * talk group did it deliberately, and an import is not the moment to overrule
   * them.
   */
  function importTalkGroups(
    entries: readonly { number: number; name: string }[],
  ): { added: number; alreadyPresent: number; noRoom: number } {
    const cp = doc.value
    const limit = schema.value?.features.talkGroups
    if (!cp || !limit) return { added: 0, alreadyPresent: 0, noRoom: entries.length }

    const nameLength = limit.nameLength
    const present = new Set(cp.talkGroups.map((g) => g.number))
    let added = 0
    let alreadyPresent = 0
    let noRoom = 0

    for (const e of entries) {
      if (present.has(e.number)) {
        alreadyPresent++
        continue
      }
      if (cp.talkGroups.length >= limit.max) {
        noRoom++
        continue
      }
      cp.talkGroups.push({
        id: `tg-import-${crypto.randomUUID()}`,
        name: e.name.slice(0, nameLength),
        number: e.number,
        callType: 'group',
      })
      present.add(e.number)
      added++
    }
    // Once, after the whole import, rather than per row: republish rebuilds
    // every frozen list, and doing that eight hundred times is eight hundred
    // rebuilds of lists nothing touched.
    republish()

    return { added, alreadyPresent, noRoom }
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
    if (!cp?.channels.has(index)) return

    // Take it out of everything that points at it, in the same edit.
    //
    // Channel numbers are absolute and deleting one deliberately does not
    // renumber the rest, so every other membership entry stays valid. But a
    // zone still pointing at the emptied slot is the one case this radio's
    // bytes could not settle, and the cheapest way to never rely on the answer
    // is to never create it.
    //
    // One transaction, so the channel and its memberships come back together.
    transact('delete', () => {
      writeSlot(index, null)
      for (const zone of cp.zones) applyMember(cp, { list: 'zones', id: zone.id, channel: index, at: null })
      for (const l of cp.scanLists) applyMember(cp, { list: 'scanLists', id: l.id, channel: index, at: null })
    })
  }

  /**
   * Where every channel would go if the bank were laid out in `order`.
   *
   * Built here rather than in the component because it needs the driver: only
   * the driver knows which slot numbers the radio in front of the user actually
   * has memory for, and a plan that picked one it does not have would produce a
   * codeplug the encoder refuses at the moment of writing.
   */
  function renumberPlan(order: ChannelOrder): RenumberPlan | null {
    const cp = doc.value
    const s = schema.value
    const d = driverRef.value
    const img = image.value
    if (!cp || !s) return null
    const storesSlot = d?.storesSlot
    return planRenumber(s, cp, {
      order,
      usable: storesSlot && img ? (slot: number) => storesSlot.call(d, img, slot) : undefined,
    })
  }

  /**
   * Lay the bank out the way a plan says, taking every reference with it.
   *
   * One transaction, because a renumber is one decision. The channel records
   * and the lists that name them by number have to come back together: an undo
   * that moved the channels and left the zones would be a codeplug nobody made,
   * which is exactly what `DocPatch` is for.
   *
   * The plan is passed in rather than rebuilt from the order, so what a person
   * agreed to in the preview is what happens - a channel edited between opening
   * the dialog and confirming it cannot quietly change the destination of every
   * other one.
   *
   * Refused outright when the plan could not place a channel, and when the
   * channel bank has moved since the plan was made - undo and redo keep working
   * while a dialog is open, so it can. `applyRenumber` throws on both; this
   * returns false instead, because there is nothing for a person to fix and an
   * exception out of a click handler is not an explanation.
   */
  function renumberChannels(plan: RenumberPlan): boolean {
    const cp = doc.value
    if (!cp || plan.unplaced.length > 0 || !planChangesSomething(plan)) return false
    if (!planFitsDocument(cp, plan)) return false

    const next = applyRenumber(cp, plan)
    transact(RENUMBER_LABEL[plan.order], () => {
      noteDoc()
      // Both ends of every move: the slot a channel leaves has to be emptied in
      // the same action, or the table shows it in two places at once.
      const touched = new Set<number>([...plan.mapping.keys(), ...plan.mapping.values()])
      for (const slot of touched) writeSlot(slot, next.channels.get(slot) ?? null)
      cp.zones = next.zones
      cp.scanLists = next.scanLists
      cp.settings = next.settings
    })
    return true
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

  /**
   * The RF profile that applies to what is open, not what the schema declares.
   *
   * One radio can have more than one firmware: an egzumer UV-K5 receives where
   * stock does not, has single sideband, and has twenty-four tuning steps
   * against stock's six. The driver knew that already - `validate` used it -
   * but the editor read `schema.rf` and so refused to save a channel this build
   * decodes perfectly well. Same shape as `settingsForLayout`: ask what applies
   * rather than what is declared.
   */
  const rf = computed(() => {
    const d = driverRef.value
    const cp = doc.value
    if (d && cp && d.rfFor) return d.rfFor(cp)
    return schema.value?.rf ?? null
  })

  return {
    image,
    doc,
    schema,
    rf,
    driverRef,
    encoded,
    encodeError,
    pendingWrite,
    transact,
    undo,
    redo,
    canUndo,
    canRedo,
    undoLabel,
    redoLabel,
    createChannel,
    setChannelRecord,
    deleteChannel,
    renumberPlan,
    renumberChannels,
    renameZone,
    renameTalkGroup,
    addZone,
    removeZone,
    addTalkGroup,
    importTalkGroups,
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

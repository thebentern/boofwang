<script setup lang="ts">
/**
 * Zones and talk groups.
 *
 * Names and membership are both written. Membership is a list of absolute
 * channel numbers, so the rule that keeps it honest is that a number here only
 * ever names a channel that is actually there: the editor drops anything the
 * codeplug has no channel for, deleting a channel takes it out of every list
 * that named it, and renumbering the bank moves the entries with it. What the
 * radio does with an in-count entry pointing at a blank record is still open -
 * see `docs/protocols/dm32uv.md` - and none of those paths can create one.
 */
useSeoMeta({ title: 'Zones and DMR lists' })

const codeplug = useCodeplugStore()

const features = computed(() => codeplug.schema?.features ?? null)
const hasZones = computed(() => !!features.value?.zones)
const hasTalkGroups = computed(() => !!features.value?.talkGroups)
const hasScanLists = computed(() => !!features.value?.scanLists)
const hasRxGroups = computed(() => !!features.value?.rxGroups)
const hasRadioIds = computed(() => !!features.value?.radioIds)

/**
 * The two limits the radio ID inputs enforce, from the schema rather than typed
 * into the markup.
 *
 * They were literals - 12 and 16777215 - which is the DM-32UV's answer and
 * nothing else's. The fleet roster needs the same two facts to say whether a
 * club's spreadsheet fits before anyone plugs in a radio, and a third copy is
 * how one of them ends up disagreeing with the encoder.
 */
const radioIdLimits = computed(() => {
  const f = features.value?.radioIds
  return f ? { nameLength: f.nameLength, maxId: f.maxId } : { nameLength: 16, maxId: 0xff_ffff }
})
const hasContacts = computed(() => !!features.value?.contacts)
const hasMessages = computed(() => !!features.value?.messages)
const hasRoaming = computed(() => codeplug.roamChannels.length > 0 || codeplug.roamZones.length > 0)
const hasReadOnlyExtras = computed(() => codeplug.emergency.length > 0 || codeplug.analog !== null)
const hasVfos = computed(() => !!codeplug.doc?.vfo.a || !!codeplug.doc?.vfo.b)

/** What the radio can hold, so Add stops rather than the encoder throwing. */
const messageLimit = computed(() =>
  features.value?.messages ? features.value.messages.max : 0,
)
const messagesFull = computed(() => codeplug.messages.length >= messageLimit.value)

const MHZ = (hz: number) => (hz / 1_000_000).toFixed(5)

/**
 * The VFO's talk group, named rather than numbered.
 *
 * The stored value is a physical slot in the talk group bank, not a position in
 * the list - this radio's bank has gaps at slots 2, 5, 8 and 9 - so the lookup
 * goes through the id, which carries the slot, exactly as the channel editor
 * does. A slot the bank has no record for is shown as the number: a dangling
 * reference is worth seeing rather than hiding behind a blank.
 */
function vfoTalkGroup(ch: { extras: { vendor?: Record<string, unknown> } }): string {
  const raw = ch.extras.vendor?.txContact
  if (raw === undefined) return 'no talk group'
  const slot = Number(raw)
  const tg = codeplug.talkGroups.find((g) => {
    const m = /^tg-[0-9a-fx]+-(\d+)$/.exec(g.id)
    return m ? Number(m[1]) === slot : false
  })
  return tg ? `TG ${tg.name || tg.number}` : `talk group slot ${slot}`
}
const supported = computed(
  () =>
    hasZones.value ||
    hasTalkGroups.value ||
    hasScanLists.value ||
    hasRxGroups.value ||
    hasRadioIds.value ||
    hasContacts.value,
)

const zoneNameLength = computed(() =>
  features.value?.zones ? features.value.zones.nameLength : 16,
)
const tgNameLength = computed(() =>
  features.value?.talkGroups ? features.value.talkGroups.nameLength : 16,
)

const toast = useToast()

/**
 * Take what the import panel chose and put it in the codeplug.
 *
 * The store decides what actually fits and reports back, rather than this
 * handler pre-trimming the list: the cap is the store's to enforce, and the
 * counts it returns are what the toast says. Anything refused is named, because
 * an import that silently stopped at the cap reads as one that succeeded.
 */
function onImportTalkGroups(entries: readonly { number: number; name: string }[]) {
  const { added, alreadyPresent, noRoom } = codeplug.importTalkGroups(entries)
  const notes = [
    alreadyPresent ? `${alreadyPresent} already in this codeplug.` : '',
    noRoom ? `${noRoom} would not fit and were left out.` : '',
  ].filter(Boolean).join(' ')
  toast.add({
    title: `Added ${added} talk group${added === 1 ? '' : 's'}`,
    description: notes || 'Nothing reaches the radio until you write.',
    icon: noRoom ? 'i-lucide-triangle-alert' : 'i-lucide-circle-check',
    color: noRoom ? 'warning' : 'success',
    duration: 10_000,
  })
}

type Editing = { kind: 'zone' | 'talkgroup' | 'scanlist' | 'rxgroup'; id: string; field: 'name' | 'members' }
const editing = ref<Editing | null>(null)
const draft = ref('')

const isEditing = (kind: Editing['kind'], id: string, field: Editing['field'] = 'name') =>
  editing.value?.kind === kind && editing.value.id === id && editing.value.field === field

function start(kind: Editing['kind'], id: string, field: Editing['field'], value: string) {
  editing.value = { kind, id, field }
  draft.value = value
}

/**
 * Parse "1-5, 9, 12-14" back into a list of numbers.
 *
 * The same shape the lists are displayed in, so what a user edits is what they
 * were shown. Anything unparseable is dropped here and anything out of range is
 * dropped by the encoder, which is the layer that knows the bank size.
 */
function parseRuns(text: string): { channels: number[]; bad: string[] } {
  const out: number[] = []
  const bad: string[] = []
  for (const part of text.split(',')) {
    const piece = part.trim()
    if (!piece) continue

    const dash = /^(\d+)\s*-\s*(\d+)$/.exec(piece)
    if (dash) {
      // A range typed backwards is what someone meant, not a mistake to throw
      // away. Silently dropping it emptied the whole list and said nothing.
      const a = Number(dash[1])
      const b = Number(dash[2])
      const from = Math.min(a, b)
      const to = Math.max(a, b)
      if (from < 1) {
        bad.push(piece)
        continue
      }
      for (let n = from; n <= to && out.length <= 4000; n++) out.push(n)
      continue
    }

    // Deliberately strict. Bare Number() reads "1e3" as 1000 and "0x10" as 16,
    // which is not what anyone typing a channel list means.
    if (!/^\d+$/.test(piece) || Number(piece) < 1) {
      bad.push(piece)
      continue
    }
    out.push(Number(piece))
  }
  // The radio stores a plain list; a duplicate is legal but pointless.
  return { channels: [...new Set(out)], bad }
}

/** Parse a comma-separated list of DMR numbers. */
const parseIds = (text: string) => {
  const out: number[] = []
  const bad: string[] = []
  for (const part of text.split(',')) {
    const piece = part.trim()
    if (!piece) continue
    if (!/^\d+$/.test(piece) || Number(piece) < 1) bad.push(piece)
    else out.push(Number(piece))
  }
  return { ids: [...new Set(out)], bad }
}

/** Shown under the editor when part of what was typed could not be read. */
const problem = ref('')

/**
 * The address book can hold 50,000 entries, so it is filtered rather than
 * listed. Matching on name, callsign and number together is what someone
 * actually wants: they know one of the three.
 */
const contactQuery = ref('')
const CONTACTS_SHOWN = 100

const matchingContacts = computed(() => {
  const q = contactQuery.value.trim().toLowerCase()
  if (!q) return codeplug.contacts
  return codeplug.contacts.filter(
    (c) =>
      c.name.toLowerCase().includes(q) ||
      c.callsign.toLowerCase().includes(q) ||
      String(c.dmrId).includes(q) ||
      c.city.toLowerCase().includes(q),
  )
})

const editingContact = ref<string | null>(null)

/** The first hundred matches, plus whichever one is open if it is past them. */
const shownContacts = computed(() => {
  const head = matchingContacts.value.slice(0, CONTACTS_SHOWN)
  const open = editingContact.value
  if (!open || head.some((c) => c.id === open)) return head
  const found = matchingContacts.value.find((c) => c.id === open)
  return found ? [...head, found] : head
})

/**
 * Add, then show what was added.
 *
 * The list is capped and filtered, so a new contact appended to 147 existing
 * ones landed past both and the button looked like it had done nothing.
 */
function onAddContact() {
  contactQuery.value = ''
  codeplug.addContact()
  editingContact.value = codeplug.contacts.at(-1)?.id ?? null
}

function commitEdit() {
  const e = editing.value
  if (!e) return
  const text = draft.value.trim()
  problem.value = ''

  if (e.field === 'name') {
    if (e.kind === 'zone') codeplug.renameZone(e.id, text)
    else if (e.kind === 'talkgroup') codeplug.renameTalkGroup(e.id, text)
    else if (e.kind === 'scanlist') codeplug.renameScanList(e.id, text)
    else codeplug.renameRxGroup(e.id, text)
    cancel()
    return
  }

  const parsed = e.kind === 'rxgroup' ? parseIds(text) : parseRuns(text)
  const bad = parsed.bad
  const values = 'ids' in parsed ? parsed.ids : parsed.channels

  // Refuse rather than commit a list the user did not ask for. Typing something
  // unreadable used to clear the list and say nothing at all.
  if (bad.length > 0) {
    problem.value = `Could not read ${bad.map((b) => `"${b}"`).join(', ')}.`
    return
  }
  if (text !== '' && values.length === 0) {
    problem.value = 'Nothing in that list could be used.'
    return
  }

  if (e.kind === 'zone') codeplug.setZoneChannels(e.id, values)
  else if (e.kind === 'scanlist') codeplug.setScanListChannels(e.id, values)
  else codeplug.setRxGroupIds(e.id, values)
  cancel()
}

function cancel() {
  editing.value = null
  draft.value = ''
  problem.value = ''
}

/**
 * Widths are the struct's, not one less.
 *
 * There is no terminator to reserve: a full-width field simply fills its bytes,
 * which is what the radio itself does - 39 of this radio's 147 contacts already
 * use all sixteen, "North Little Roc" among them. Capping at fifteen quietly
 * shortened every one of them the moment it was opened for editing.
 */
const CONTACT_FIELDS = [
  { key: 'name', label: 'Name', max: 16 },
  { key: 'dmrId', label: 'DMR ID', max: 8 },
  { key: 'callsign', label: 'Callsign', max: 8 },
  { key: 'city', label: 'City', max: 16 },
  { key: 'province', label: 'State', max: 16 },
  { key: 'country', label: 'Country', max: 16 },
  { key: 'remark', label: 'Note', max: 16 },
] as const

const CALL_TYPE: Record<string, string> = {
  group: 'Group call',
  private: 'Private call',
  allCall: 'All call',
}


/** "1-5, 9, 12-14" rather than sixty-four numbers in a row. */
function runs(numbers: readonly number[]): string {
  if (numbers.length === 0) return 'no channels'
  const sorted = [...numbers].sort((a, b) => a - b)
  const out: string[] = []
  let start = sorted[0]!
  let prev = start
  for (const n of sorted.slice(1)) {
    if (n === prev + 1) {
      prev = n
      continue
    }
    out.push(start === prev ? `${start}` : `${start}-${prev}`)
    start = prev = n
  }
  out.push(start === prev ? `${start}` : `${start}-${prev}`)
  return out.join(', ')
}

const nameOf = (index: number) => codeplug.channels.find((c) => c.index === index)?.name ?? ''
</script>


<template>
  <div class="mx-auto" style="max-width: 900px; padding: 22px 16px 48px">
    <div class="flex items-center gap-2.5 flex-wrap" style="margin-bottom: 11px">
      <UIcon name="i-lucide-folder-tree" class="shrink-0" style="width: 17px; height: 17px; color: var(--cn)" />
      <h1 style="font-size: 19px; font-weight: 600; letter-spacing: -0.02em; color: var(--tx)">
        Zones and DMR lists
      </h1>
      <span v-if="codeplug.isOpen && supported" class="ms-auto" style="font-size: 13.5px; color: var(--mu)">
        {{ codeplug.zones.length }} zones · {{ codeplug.talkGroups.length }} talk groups ·
        {{ codeplug.scanLists.length }} scan lists · {{ codeplug.rxGroups.length }} RX groups<template
          v-if="codeplug.contacts.length"
        > · {{ codeplug.contacts.length.toLocaleString() }} contacts</template>
      </span>
    </div>

    <div
      v-if="!codeplug.isOpen"
      style="border: 1px solid var(--ln); background: var(--pn); border-radius: 7px; padding: 22px"
    >
      <h2 style="font-size: 14.5px; font-weight: 600; color: var(--tx); margin-bottom: 5px">No codeplug open</h2>
      <p style="font-size: 14px; line-height: 1.6; color: var(--mu); max-width: 74ch; margin-bottom: 13px">
        Zones and DMR lists belong to a codeplug. Read a radio that has them, or open a codeplug file you
        saved earlier.
      </p>
      <div class="flex flex-wrap items-center gap-2.5">
        <RiskAction risk="neutral" icon="i-lucide-radio" label="Choose a radio" @click="navigateTo('/')" />
        <OpenCodeplugButton />
      </div>
    </div>

    <div
      v-else-if="!supported"
      style="border: 1px solid var(--ln); background: var(--pn); border-radius: 7px; padding: 22px"
    >
      <h2 style="font-size: 14.5px; font-weight: 600; color: var(--tx); margin-bottom: 5px">
        The {{ codeplug.schema?.vendor }} {{ codeplug.schema?.model }} has no zones or DMR lists
      </h2>
      <p style="font-size: 14px; line-height: 1.6; color: var(--mu); max-width: 74ch">
        These are DMR features. Of the radios boofwang supports, only the Baofeng DM-32UV has them.
      </p>
    </div>

    <template v-else>
      <!-- Zones -->
      <section v-if="hasZones" style="margin-bottom: 18px">
        <div class="flex items-center gap-2" style="margin-bottom: 7px">
          <h2 class="sec" style="margin: 0">Zones</h2>
          <RiskAction
            risk="neutral" ghost size="sm" icon="i-lucide-plus" label="Add"
            class="ms-auto" @click="codeplug.addZone()"
          />
        </div>
        <div class="card">
          <p v-if="codeplug.zones.length === 0" class="empty">This codeplug has no zones.</p>
          <div
            v-for="(zone, i) in codeplug.zones"
            v-else
            :key="zone.id"
            class="flex items-start gap-3"
            :style="`padding: 17px 19px; ${i ? 'border-top: 1px solid var(--ln);' : ''}`"
          >
            <span class="idx">{{ i + 1 }}</span>
            <div class="min-w-0 flex-1 grid" style="gap: 6px">
              <InlineEdit
                v-model:draft="draft"
                :editing="isEditing('zone', zone.id)"
                :value="zone.name"
                :maxlength="zoneNameLength"
                :hint="`Up to ${zoneNameLength} characters.`"
                @edit="start('zone', zone.id, 'name', zone.name)"
                @save="commitEdit"
                @cancel="cancel"
              />
              <InlineEdit
                v-model:draft="draft"
                :editing="isEditing('zone', zone.id, 'members')"
                :value="runs(zone.channels)"
                label="Edit channels"
                placeholder="1-22, 30, 42-45"
                hint="Channel numbers, as ranges or singly. Anything this radio has no channel for is dropped."
                :problem="problem"
                @edit="start('zone', zone.id, 'members', runs(zone.channels))"
                @save="commitEdit"
                @cancel="cancel"
              >
                <span class="meta">
                  {{ zone.channels.length }} channel{{ zone.channels.length === 1 ? '' : 's' }}:
                  {{ runs(zone.channels) }}
                  <span v-if="zone.channels.length" style="color: var(--fn)"> · {{ nameOf(zone.channels[0]!) }}…</span>
                </span>
              </InlineEdit>
            </div>
            <RiskAction
              risk="caution"
              ghost
              size="sm"
              icon="i-lucide-trash-2"
              label="Remove"
              class="shrink-0"
              @click="codeplug.removeZone(zone.id)"
            />
          </div>
        </div>
      </section>

      <!-- Talk groups -->
      <section v-if="hasTalkGroups" style="margin-bottom: 18px">
        <div class="flex items-center gap-2" style="margin-bottom: 7px">
          <h2 class="sec" style="margin: 0">Talk groups</h2>
          <div class="ms-auto flex items-start gap-2">
            <DmrTalkGroupImport
              :max="features?.talkGroups ? features.talkGroups.max : 0"
              :used="codeplug.talkGroups.length"
              @import="onImportTalkGroups"
            />
            <RiskAction
              risk="neutral" ghost size="sm" icon="i-lucide-plus" label="Add"
              @click="codeplug.addTalkGroup()"
            />
          </div>
        </div>
        <div class="card">
          <p v-if="codeplug.talkGroups.length === 0" class="empty">This codeplug has no talk groups.</p>
          <div
            v-for="(group, i) in codeplug.talkGroups"
            v-else
            :key="group.id"
            class="flex items-center gap-3"
            :style="`padding: 13px 16px; ${i ? 'border-top: 1px solid var(--ln);' : ''}`"
          >
            <span class="idx">{{ i + 1 }}</span>
            <InlineEdit
              v-model:draft="draft"
              :editing="isEditing('talkgroup', group.id)"
              :value="group.name"
              :maxlength="tgNameLength"
              @edit="start('talkgroup', group.id, 'name', group.name)"
              @save="commitEdit"
              @cancel="cancel"
            />
            <template v-if="!isEditing('talkgroup', group.id)">
              <input
                type="number"
                :value="group.number"
                min="0"
                max="16777215"
                class="ms-auto rounded-[6px] px-2 outline-none font-mono shrink-0"
                style="height: 29px; width: 120px; background: var(--pn); border: 1px solid var(--ln2); color: var(--tx); font-size: 13.5px"
                @change="codeplug.updateTalkGroup(group.id, { number: Number(($event.target as HTMLInputElement).value) })"
              >
              <select
                :value="group.callType"
                class="rounded-[6px] px-2 outline-none shrink-0"
                style="height: 29px; background: var(--pn); border: 1px solid var(--ln2); color: var(--tx); font-size: 13.5px"
                @change="codeplug.updateTalkGroup(group.id, { callType: ($event.target as HTMLSelectElement).value as 'group' | 'private' | 'allCall' })"
              >
                <option v-for="(label, value) in CALL_TYPE" :key="value" :value="value">{{ label }}</option>
              </select>
              <RiskAction
                risk="caution" ghost size="sm" icon="i-lucide-trash-2" label="Remove"
                class="shrink-0" @click="codeplug.removeTalkGroup(group.id)"
              />
            </template>
          </div>
        </div>
        <p class="note">A talk group's number and call type come from the radio and are written back unchanged.</p>
      </section>

      <!-- Scan lists -->
      <section v-if="hasScanLists" style="margin-bottom: 18px">
        <h2 class="sec">Scan lists</h2>
        <div class="card">
          <p v-if="codeplug.scanLists.length === 0" class="empty">This codeplug has no scan lists.</p>
          <div
            v-for="(list, i) in codeplug.scanLists"
            v-else
            :key="list.id"
            class="flex items-start gap-3"
            :style="`padding: 17px 19px; ${i ? 'border-top: 1px solid var(--ln);' : ''}`"
          >
            <span class="idx">{{ i + 1 }}</span>
            <div class="min-w-0 flex-1 grid" style="gap: 6px">
              <InlineEdit
                v-model:draft="draft"
                :editing="isEditing('scanlist', list.id)"
                :value="list.name"
                :maxlength="11"
                :hint="'Up to 11 characters.'"
                @edit="start('scanlist', list.id, 'name', list.name)"
                @save="commitEdit"
                @cancel="cancel"
              />
              <InlineEdit
                v-model:draft="draft"
                :editing="isEditing('scanlist', list.id, 'members')"
                :value="runs(list.channels)"
                label="Edit channels"
                placeholder="1-9"
                hint="This radio scans at most 16 channels per list; anything past that is dropped."
                :problem="problem"
                @edit="start('scanlist', list.id, 'members', runs(list.channels))"
                @save="commitEdit"
                @cancel="cancel"
              >
                <span class="meta">
                  {{ list.channels.length }} channel{{ list.channels.length === 1 ? '' : 's' }}:
                  {{ runs(list.channels) }}
                </span>
              </InlineEdit>
            </div>
          </div>
        </div>
        <p class="note">
          A scan list holds at most 16 channels. Anything past that, or that this radio has no channel
          for, is dropped rather than stored.
        </p>
      </section>

      <!-- RX groups -->
      <section v-if="hasRxGroups" style="margin-bottom: 18px">
        <h2 class="sec">RX groups</h2>
        <div class="card">
          <p v-if="codeplug.rxGroups.length === 0" class="empty">This codeplug has no RX groups.</p>
          <div
            v-for="(group, i) in codeplug.rxGroups"
            v-else
            :key="group.id"
            class="flex items-start gap-3"
            :style="`padding: 17px 19px; ${i ? 'border-top: 1px solid var(--ln);' : ''}`"
          >
            <span class="idx">{{ i + 1 }}</span>
            <div class="min-w-0 flex-1 grid" style="gap: 6px">
              <InlineEdit
                v-model:draft="draft"
                :editing="isEditing('rxgroup', group.id)"
                :value="group.name"
                :maxlength="11"
                @edit="start('rxgroup', group.id, 'name', group.name)"
                @save="commitEdit"
                @cancel="cancel"
              />
              <InlineEdit
                v-model:draft="draft"
                :editing="isEditing('rxgroup', group.id, 'members')"
                :value="group.dmrIds.join(', ')"
                label="Edit members"
                placeholder="3105, 310501"
                hint="DMR talk group numbers, not slot numbers. Up to 32."
                :problem="problem"
                @edit="start('rxgroup', group.id, 'members', group.dmrIds.join(', '))"
                @save="commitEdit"
                @cancel="cancel"
              >
                <span class="meta">
                  <template v-if="group.dmrIds.length">{{ group.dmrIds.join(', ') }}</template>
                  <template v-else>no members</template>
                </span>
              </InlineEdit>
            </div>
          </div>
        </div>
        <p class="note">
          An RX group holds DMR talk group numbers directly, not references to the talk group list above.
        </p>
      </section>

      <!-- Radio IDs -->
      <section v-if="hasRadioIds">
        <div class="flex items-center gap-2" style="margin-bottom: 7px">
          <h2 class="sec" style="margin: 0">Radio IDs</h2>
          <RiskAction
            risk="neutral"
            ghost
            size="sm"
            icon="i-lucide-plus"
            label="Add"
            class="ms-auto"
            @click="codeplug.addRadioId()"
          />
        </div>
        <div class="card">
          <p v-if="codeplug.radioIds.length === 0" class="empty">This codeplug has no radio IDs.</p>
          <div
            v-for="(entry, i) in codeplug.radioIds"
            v-else
            :key="entry.id"
            class="flex items-center gap-3 flex-wrap"
            :style="`padding: 13px 16px; ${i ? 'border-top: 1px solid var(--ln);' : ''}`"
          >
            <span class="idx">{{ i + 1 }}</span>
            <label class="grid gap-1" style="min-width: 120px">
              <span class="label-xs">Name</span>
              <input
                type="text"
                :value="entry.name"
                :maxlength="radioIdLimits.nameLength"
                class="rounded-[6px] px-2.5 outline-none"
                style="height: 31px; background: var(--pn); border: 1px solid var(--ln2); color: var(--tx); font-size: 14px"
                autocomplete="off"
                spellcheck="false"
                @change="codeplug.updateRadioId(entry.id, { name: ($event.target as HTMLInputElement).value })"
              >
            </label>
            <label class="grid gap-1" style="min-width: 130px">
              <span class="label-xs">DMR ID</span>
              <input
                type="number"
                :value="entry.dmrId"
                min="0"
                :max="radioIdLimits.maxId"
                class="rounded-[6px] px-2.5 outline-none font-mono"
                style="height: 31px; background: var(--pn); border: 1px solid var(--ln2); color: var(--tx); font-size: 14px"
                @change="codeplug.updateRadioId(entry.id, { dmrId: Number(($event.target as HTMLInputElement).value) })"
              >
            </label>
            <RiskAction
              risk="caution"
              ghost
              size="sm"
              icon="i-lucide-trash-2"
              label="Remove"
              class="ms-auto"
              @click="codeplug.removeRadioId(entry.id)"
            />
          </div>
        </div>
        <p class="note">
          The largest DMR ID this radio can store is {{ radioIdLimits.maxId.toLocaleString() }}. Channels point
          at these by position, so removing one renumbers the ones after it.
        </p>
      </section>

      <!-- Contacts -->
      <section v-if="hasContacts" style="margin-top: 18px">
        <div class="flex items-center gap-2 flex-wrap" style="margin-bottom: 7px">
          <h2 class="sec" style="margin: 0">Contacts</h2>
          <span v-if="codeplug.contacts.length" style="font-size: 13px; color: var(--mu)">
            {{ codeplug.contacts.length.toLocaleString() }}
          </span>
          <input
            v-if="codeplug.contacts.length > 12"
            v-model="contactQuery"
            type="search"
            placeholder="Search name, callsign, number or city"
            class="rounded-[6px] px-2.5 outline-none"
            style="height: 31px; min-width: 250px; background: var(--pn); border: 1px solid var(--ln2); color: var(--tx); font-size: 14px; margin-inline-start: auto"
          >
          <RiskAction
            risk="neutral"
            ghost
            size="sm"
            icon="i-lucide-plus"
            label="Add"
            :class="codeplug.contacts.length > 12 ? '' : 'ms-auto'"
            @click="onAddContact"
          />
        </div>

        <div class="card">
          <p v-if="codeplug.contacts.length === 0" class="empty">
            This radio's address book is empty. It lives in a memory region of its own, so reading it costs
            nothing when there is nothing in it.
          </p>
          <p v-else-if="matchingContacts.length === 0" class="empty">
            Nothing matches “{{ contactQuery }}”.
          </p>
          <template v-else>
            <div
              v-for="(contact, i) in shownContacts"
              :key="contact.id"
              :style="`padding: 11px 16px; ${i ? 'border-top: 1px solid var(--ln);' : ''}`"
            >
              <div v-if="editingContact === contact.id" class="grid sm:grid-cols-2 lg:grid-cols-4" style="gap: 11px">
                <label v-for="f in CONTACT_FIELDS" :key="f.key" class="grid gap-1">
                  <span class="label-xs">{{ f.label }}</span>
                  <input
                    :type="f.key === 'dmrId' ? 'number' : 'text'"
                    :value="contact[f.key]"
                    :maxlength="f.max"
                    :min="f.key === 'dmrId' ? 0 : undefined"
                    :max="f.key === 'dmrId' ? 16777215 : undefined"
                    class="rounded-[6px] px-2.5 outline-none"
                    style="height: 31px; background: var(--pn); border: 1px solid var(--ln2); color: var(--tx); font-size: 14px"
                    autocomplete="off"
                    spellcheck="false"
                    @change="codeplug.updateContact(contact.id, { [f.key]: f.key === 'dmrId' ? Number(($event.target as HTMLInputElement).value) : ($event.target as HTMLInputElement).value })"
                  >
                </label>
                <div class="flex items-end gap-2">
                  <RiskAction risk="neutral" size="sm" icon="i-lucide-check" label="Done" @click="editingContact = null" />
                  <RiskAction risk="caution" ghost size="sm" icon="i-lucide-trash-2" label="Remove" @click="codeplug.removeContact(contact.id); editingContact = null" />
                </div>
              </div>

              <div v-else class="flex items-center gap-3 flex-wrap">
                <span style="font-size: 14.5px; font-weight: 600; color: var(--tx)">
                  {{ contact.name || '(unnamed)' }}
                </span>
                <span v-if="contact.callsign" class="chip" style="border: 1px solid var(--ln2); background: transparent; color: var(--mu)">
                  {{ contact.callsign }}
                </span>
                <span v-if="contact.city" class="meta">{{ contact.city }}<template v-if="contact.province">, {{ contact.province }}</template></span>
                <span class="ms-auto font-mono shrink-0" style="font-size: 13.5px; color: var(--tx)">{{ contact.dmrId }}</span>
                <button
                  type="button"
                  class="chip"
                  style="border: 1px solid var(--ln2); background: transparent; color: var(--mu); cursor: pointer"
                  @click="editingContact = contact.id"
                >Edit</button>
              </div>
            </div>
            <p
              v-if="matchingContacts.length > shownContacts.length"
              style="font-size: 13px; color: var(--mu); padding: 13px 16px; border-top: 1px solid var(--ln)"
            >
              Showing {{ CONTACTS_SHOWN }} of {{ matchingContacts.length.toLocaleString() }}. Search to narrow it
              down; all of them are in the codeplug either way.
            </p>
          </template>
        </div>
        <p class="note">
          The address book lives in a memory region of its own, outside the codeplug the rest of this page
          comes from. It is written back only when you change something in it, and a restore puts it back.
        </p>
      </section>

      <!-- Text messages -->
      <section v-if="hasMessages" style="margin-top: 18px">
        <div class="flex items-center gap-2" style="margin-bottom: 7px">
          <h2 class="sec" style="margin: 0">Text messages</h2>
          <RiskAction
            risk="neutral"
            ghost
            size="sm"
            icon="i-lucide-plus"
            :label="messagesFull ? `Full (${messageLimit})` : 'Add'"
            :disabled="messagesFull"
            class="ms-auto"
            @click="codeplug.addMessage()"
          />
        </div>
        <div class="card">
          <p v-if="codeplug.messages.length === 0" class="empty">
            This radio has no canned messages stored.
          </p>
          <div
            v-for="(text, i) in codeplug.messages"
            v-else
            :key="i"
            class="flex items-center gap-3"
            :style="`padding: 11px 16px; ${i ? 'border-top: 1px solid var(--ln);' : ''}`"
          >
            <span class="idx">{{ i + 1 }}</span>
            <input
              type="text"
              :value="text"
              maxlength="127"
              class="rounded-[6px] px-2.5 outline-none flex-1 min-w-0"
              style="height: 31px; background: var(--pn); border: 1px solid var(--ln2); color: var(--tx); font-size: 14px"
              autocomplete="off"
              @change="codeplug.setMessage(i, ($event.target as HTMLInputElement).value)"
            >
            <span class="meta shrink-0">{{ text.length }}/127</span>
            <RiskAction
              risk="caution"
              ghost
              size="sm"
              icon="i-lucide-trash-2"
              label="Remove"
              @click="codeplug.removeMessage(i)"
            />
          </div>
        </div>
      </section>

      <!-- Roaming -->
      <section v-if="hasRoaming" style="margin-top: 18px">
        <h2 class="sec">Roaming channels</h2>
        <div class="card">
          <div
            v-for="(chan, i) in codeplug.roamChannels"
            :key="chan.id"
            class="flex items-center gap-3 flex-wrap"
            :style="`padding: 11px 16px; ${i ? 'border-top: 1px solid var(--ln);' : ''}`"
          >
            <span class="idx">{{ i + 1 }}</span>
            <input
              type="text"
              :value="chan.name"
              maxlength="16"
              class="rounded-[6px] px-2.5 outline-none"
              style="height: 31px; width: 170px; background: var(--pn); border: 1px solid var(--ln2); color: var(--tx); font-size: 14px"
              autocomplete="off"
              @change="codeplug.updateRoamChannel(chan.id, { name: ($event.target as HTMLInputElement).value })"
            >
            <span class="meta">{{ MHZ(chan.rxFreq) }} / {{ MHZ(chan.txFreq) }} MHz</span>
            <span class="chip" style="border: 1px solid var(--ln2); background: transparent; color: var(--mu)">
              CC {{ chan.colorCode }}
            </span>
            <span class="chip" style="border: 1px solid var(--ln2); background: transparent; color: var(--mu)">
              TS {{ chan.timeSlot }}
            </span>
          </div>
        </div>

        <template v-if="codeplug.roamZones.length">
          <h2 class="sec" style="margin-top: 14px">Roaming zones</h2>
          <div class="card">
            <div
              v-for="(zone, i) in codeplug.roamZones"
              :key="zone.id"
              class="flex items-center gap-3"
              :style="`padding: 10px 16px; ${i ? 'border-top: 1px solid var(--ln);' : ''}`"
            >
              <span class="idx">{{ i + 1 }}</span>
              <input
                type="text"
                :value="zone.name"
                maxlength="16"
                class="rounded-[6px] px-2.5 outline-none"
                style="height: 31px; width: 200px; background: var(--pn); border: 1px solid var(--ln2); color: var(--tx); font-size: 14px"
                autocomplete="off"
                @change="codeplug.updateRoamZone(zone.id, { name: ($event.target as HTMLInputElement).value })"
              >
              <span class="meta ms-auto">{{ zone.enabled ? 'Enabled' : 'Disabled' }}</span>
            </div>
          </div>
          <p class="note">
            Names are written; membership is not. Flags, the name and one count byte account for all 33 bytes
            of a roaming zone record, so the channel list is somewhere outside it that nobody has found, and
            an editor that pretended otherwise would be writing into bytes that mean something else.
          </p>
        </template>
      </section>

      <!-- Call list, block 0x03 -->
      <section v-if="codeplug.callList.length" class="mt-7">
        <h2 class="sec">Call list</h2>
        <div class="card">
          <div
            v-for="(entry, i) in codeplug.callList"
            :key="entry.id"
            class="flex items-center gap-3"
            :style="`padding: 10px 16px; ${i ? 'border-top: 1px solid var(--ln);' : ''}`"
          >
            <span class="idx">{{ i + 1 }}</span>
            <input
              type="text"
              :value="entry.name"
              maxlength="16"
              class="rounded-[6px] px-2.5 outline-none"
              style="height: 31px; width: 200px; background: var(--pn); border: 1px solid var(--ln2); color: var(--tx); font-size: 14px"
              autocomplete="off"
              @change="codeplug.updateCallListEntry(entry.id, { name: ($event.target as HTMLInputElement).value })"
            >
            <span
              v-if="entry.referenceA !== 0xffff"
              class="chip"
              style="border: 1px solid var(--ln2); background: transparent; color: var(--mu)"
            >
              refs {{ entry.referenceA }}, {{ entry.referenceB }}
            </span>
            <span class="meta ms-auto">{{ entry.inUse ? 'In use' : 'Free' }}</span>
          </div>
        </div>
        <p class="note">
          Block 0x03, which the OEM software reads and writes but which nobody has explained. The names are
          real and editable. This is the one block on the radio that stores them as UTF-16. The two reference
          numbers point at something unidentified, so they are shown and left alone; on a factory radio they
          hold five pairs drawn from four values that match nothing else in the codeplug.
        </p>
      </section>

      <!-- VFOs -->
      <section v-if="hasVfos" style="margin-top: 18px">
        <h2 class="sec">VFO</h2>
        <div class="card">
          <div
            v-for="(vfo, i) in [
              { label: 'VFO A', ch: codeplug.doc?.vfo.a },
              { label: 'VFO B', ch: codeplug.doc?.vfo.b },
            ]"
            :key="vfo.label"
            class="flex items-center gap-3 flex-wrap"
            :style="`padding: 11px 16px; ${i ? 'border-top: 1px solid var(--ln);' : ''}`"
          >
            <span style="font-size: 14.5px; font-weight: 600; color: var(--tx); width: 60px">{{ vfo.label }}</span>
            <template v-if="vfo.ch">
              <span class="meta">{{ MHZ(vfo.ch.rxFreq) }} MHz</span>
              <span class="chip" style="border: 1px solid var(--ln2); background: transparent; color: var(--mu)">
                {{ vfo.ch.modulation }}
              </span>
              <span class="chip" style="border: 1px solid var(--ln2); background: transparent; color: var(--mu)">
                {{ vfo.ch.power.label }}
              </span>
              <span v-if="vfo.ch.modulation === 'DMR'" class="chip" style="border: 1px solid var(--ln2); background: transparent; color: var(--mu)">
                CC {{ vfo.ch.extras.vendor?.colorCode }} · TS {{ vfo.ch.extras.vendor?.timeSlot }}
              </span>
              <span class="meta ms-auto">
                {{ vfoTalkGroup(vfo.ch) }}
              </span>
            </template>
            <span v-else class="meta">not programmed</span>
          </div>
        </div>
        <p class="note">
          The two VFOs are ordinary channel records at fixed offsets in the last channel block, outside the
          channel list: nothing counts them and no zone or scan list can point at one. Their talk group is
          the exception: it lives four bytes from the end of a different block entirely, which is why the
          reference implementation reads it and does not write it. boofwang writes it.
        </p>
      </section>

      <!-- Read only -->
      <section v-if="hasReadOnlyExtras" style="margin-top: 18px">
        <h2 class="sec">Read from the radio, never written</h2>
        <div class="card" style="padding: 16px">
          <div v-if="codeplug.emergency.length" style="margin-bottom: 14px">
            <span class="label-xs">Emergency systems</span>
            <p class="meta" style="margin-top: 4px">
              {{ codeplug.emergency.map((e) => e.name).join(', ') }}
            </p>
          </div>
          <div v-if="codeplug.analog" class="grid sm:grid-cols-2" style="gap: 13px">
            <div v-if="codeplug.analog.dtmfCodes.length">
              <span class="label-xs">DTMF codes</span>
              <p class="meta" style="margin-top: 4px">{{ codeplug.analog.dtmfCodes.join(', ') }}</p>
            </div>
            <div v-if="codeplug.analog.dtmfSpecialCodes.length">
              <span class="label-xs">DTMF special codes</span>
              <p class="meta" style="margin-top: 4px">{{ codeplug.analog.dtmfSpecialCodes.join(', ') }}</p>
            </div>
            <div v-if="codeplug.analog.contacts.length">
              <span class="label-xs">Analog contacts</span>
              <p class="meta" style="margin-top: 4px">{{ codeplug.analog.contacts.join(', ') }}</p>
            </div>
            <div v-if="codeplug.analog.bdcContacts.length">
              <span class="label-xs">MDC1200 contacts</span>
              <p class="meta" style="margin-top: 4px">
                {{ codeplug.analog.bdcContacts.map((c) => `${c.name} (${c.number})`).join(', ') }}
              </p>
            </div>
          </div>
        </div>
        <p class="note">
          These are decoded so a backup is complete and so you can see what the radio holds. They are written
          back exactly as they were found. Their fields are documented as derived rather than confirmed, and
          a control for a byte whose meaning is a guess is worse than none.
        </p>
      </section>
    </template>
  </div>
</template>

<style scoped>
.sec {
  font-size: 14.5px;
  font-weight: 600;
  color: var(--tx);
  margin-bottom: 7px;
}
.card {
  border: 1px solid var(--ln);
  background: var(--pn);
  border-radius: 7px;
  overflow: hidden;
}
.empty {
  font-size: 14px;
  color: var(--mu);
  padding: 19px 17px;
}
.idx {
  font-family: var(--font-mono, ui-monospace), monospace;
  font-size: 13px;
  color: var(--mu);
  width: 22px;
  flex-shrink: 0;
  padding-top: 2px;
}
.meta {
  font-family: var(--font-mono, ui-monospace), monospace;
  font-size: 13px;
  color: var(--mu);
  line-height: 1.55;
}
.note {
  font-size: 13px;
  color: var(--mu);
  margin-top: 6px;
  line-height: 1.6;
  max-width: 74ch;
}
</style>

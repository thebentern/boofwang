<script setup lang="ts">
/**
 * Zones and talk groups.
 *
 * Both are decoded from the radio and both can be written, but only their
 * names: a zone's membership is a list of absolute channel numbers, and what
 * the radio does with one pointing at a slot that has since been emptied has
 * not been established. Membership is therefore shown - it is the thing that
 * tells you which zone is which - and marked as coming from the radio, rather
 * than made editable and silently dropped when the codeplug is encoded.
 */
useSeoMeta({ title: 'Zones and DMR lists' })

const codeplug = useCodeplugStore()

const features = computed(() => codeplug.schema?.features ?? null)
const hasZones = computed(() => !!features.value?.zones)
const hasTalkGroups = computed(() => !!features.value?.talkGroups)
const hasScanLists = computed(() => !!features.value?.scanLists)
const hasRxGroups = computed(() => !!features.value?.rxGroups)
const hasRadioIds = computed(() => !!features.value?.radioIds)
const hasContacts = computed(() => !!features.value?.contacts)
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
function parseRuns(text: string): number[] {
  const out: number[] = []
  for (const part of text.split(',')) {
    const piece = part.trim()
    if (!piece) continue
    const dash = piece.match(/^(\d+)\s*-\s*(\d+)$/)
    if (dash) {
      const from = Number(dash[1])
      const to = Number(dash[2])
      if (from <= to && to - from < 1000) for (let n = from; n <= to; n++) out.push(n)
      continue
    }
    const one = Number(piece)
    if (Number.isInteger(one) && one > 0) out.push(one)
  }
  // The radio stores a plain list; a duplicate is legal but pointless.
  return [...new Set(out)]
}

/** Parse a comma-separated list of DMR numbers. */
const parseIds = (text: string) =>
  [...new Set(text.split(',').map((v) => Number(v.trim())).filter((v) => Number.isInteger(v) && v > 0))]

function commitEdit() {
  const e = editing.value
  if (!e) return
  const text = draft.value.trim()
  if (e.kind === 'zone') {
    if (e.field === 'name') codeplug.renameZone(e.id, text)
    else codeplug.setZoneChannels(e.id, parseRuns(text))
  } else if (e.kind === 'talkgroup') {
    codeplug.renameTalkGroup(e.id, text)
  } else if (e.kind === 'scanlist') {
    if (e.field === 'name') codeplug.renameScanList(e.id, text)
    else codeplug.setScanListChannels(e.id, parseRuns(text))
  } else {
    if (e.field === 'name') codeplug.renameRxGroup(e.id, text)
    else codeplug.setRxGroupIds(e.id, parseIds(text))
  }
  cancel()
}

function cancel() {
  editing.value = null
  draft.value = ''
}

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
      <h1 style="font-size: 17px; font-weight: 600; letter-spacing: -0.02em; color: var(--tx)">
        Zones and DMR lists
      </h1>
      <span v-if="codeplug.isOpen && supported" class="ms-auto" style="font-size: 12px; color: var(--mu)">
        {{ codeplug.zones.length }} zones · {{ codeplug.talkGroups.length }} talk groups ·
        {{ codeplug.scanLists.length }} scan lists · {{ codeplug.rxGroups.length }} RX groups<template
          v-if="codeplug.contacts.length"
        > · {{ codeplug.contacts.length.toLocaleString() }} contacts</template>
      </span>
    </div>

    <div
      v-if="!codeplug.isOpen"
      style="border: 1px solid var(--ln); background: var(--pn); border-radius: 7px; padding: 18px"
    >
      <h2 style="font-size: 13px; font-weight: 600; color: var(--tx); margin-bottom: 5px">No codeplug open</h2>
      <p style="font-size: 12.5px; line-height: 1.6; color: var(--mu); max-width: 74ch; margin-bottom: 13px">
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
      style="border: 1px solid var(--ln); background: var(--pn); border-radius: 7px; padding: 18px"
    >
      <h2 style="font-size: 13px; font-weight: 600; color: var(--tx); margin-bottom: 5px">
        The {{ codeplug.schema?.vendor }} {{ codeplug.schema?.model }} has no zones or DMR lists
      </h2>
      <p style="font-size: 12.5px; line-height: 1.6; color: var(--mu); max-width: 74ch">
        These are DMR features. Of the radios boofwang supports, only the Baofeng DM-32UV has them.
      </p>
    </div>

    <template v-else>
      <!-- Zones -->
      <section v-if="hasZones" style="margin-bottom: 18px">
        <h2 class="sec">Zones</h2>
        <div class="card">
          <p v-if="codeplug.zones.length === 0" class="empty">This codeplug has no zones.</p>
          <div
            v-for="(zone, i) in codeplug.zones"
            v-else
            :key="zone.id"
            class="flex items-start gap-3"
            :style="`padding: 11px 13px; ${i ? 'border-top: 1px solid var(--ln);' : ''}`"
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
                @edit="start('zone', zone.id, 'members', runs(zone.channels))"
                @save="commitEdit"
                @cancel="cancel"
              >
                <span class="meta">
                  {{ zone.channels.length }} channel{{ zone.channels.length === 1 ? '' : 's' }}:
                  {{ runs(zone.channels) }}
                  <span v-if="zone.channels.length" style="color: var(--fn)"> — {{ nameOf(zone.channels[0]!) }}…</span>
                </span>
              </InlineEdit>
            </div>
          </div>
        </div>
      </section>

      <!-- Talk groups -->
      <section v-if="hasTalkGroups" style="margin-bottom: 18px">
        <h2 class="sec">Talk groups</h2>
        <div class="card">
          <p v-if="codeplug.talkGroups.length === 0" class="empty">This codeplug has no talk groups.</p>
          <div
            v-for="(group, i) in codeplug.talkGroups"
            v-else
            :key="group.id"
            class="flex items-center gap-3"
            :style="`padding: 10px 13px; ${i ? 'border-top: 1px solid var(--ln);' : ''}`"
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
              <span class="ms-auto font-mono shrink-0" style="font-size: 12px; color: var(--tx)">{{ group.number }}</span>
              <span class="chip shrink-0" style="border: 1px solid var(--ln2); background: transparent; color: var(--mu)">
                {{ CALL_TYPE[group.callType] ?? group.callType }}
              </span>
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
            :style="`padding: 11px 13px; ${i ? 'border-top: 1px solid var(--ln);' : ''}`"
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
            :style="`padding: 11px 13px; ${i ? 'border-top: 1px solid var(--ln);' : ''}`"
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
            :style="`padding: 10px 13px; ${i ? 'border-top: 1px solid var(--ln);' : ''}`"
          >
            <span class="idx">{{ i + 1 }}</span>
            <label class="grid gap-1" style="min-width: 120px">
              <span class="label-xs">Name</span>
              <input
                type="text"
                :value="entry.name"
                maxlength="12"
                class="rounded-[6px] px-2.5 outline-none"
                style="height: 27px; background: var(--pn); border: 1px solid var(--ln2); color: var(--tx); font-size: 12.5px"
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
                max="16777215"
                class="rounded-[6px] px-2.5 outline-none font-mono"
                style="height: 27px; background: var(--pn); border: 1px solid var(--ln2); color: var(--tx); font-size: 12.5px"
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
          A DMR ID is 24 bits, so the largest this radio can store is 16,777,215. Channels point at these by
          position, so removing one renumbers the ones after it.
        </p>
      </section>

      <!-- Contacts -->
      <section v-if="hasContacts" style="margin-top: 18px">
        <h2 class="sec">Contacts</h2>
        <div class="card">
          <p v-if="codeplug.contacts.length === 0" class="empty">
            This radio's address book is empty. It lives in a memory region of its own, so reading it costs
            nothing when there is nothing in it.
          </p>
          <template v-else>
            <div
              v-for="(contact, i) in codeplug.contacts.slice(0, 200)"
              :key="contact.id"
              class="flex items-center gap-3 flex-wrap"
              :style="`padding: 9px 13px; ${i ? 'border-top: 1px solid var(--ln);' : ''}`"
            >
              <span class="idx">{{ i + 1 }}</span>
              <span style="font-size: 13px; font-weight: 600; color: var(--tx)">{{ contact.name || '(unnamed)' }}</span>
              <span v-if="contact.callsign" class="chip" style="border: 1px solid var(--ln2); background: transparent; color: var(--mu)">
                {{ contact.callsign }}
              </span>
              <span class="ms-auto font-mono shrink-0" style="font-size: 12px; color: var(--tx)">{{ contact.dmrId }}</span>
            </div>
            <p
              v-if="codeplug.contacts.length > 200"
              style="font-size: 11.5px; color: var(--mu); padding: 10px 13px; border-top: 1px solid var(--ln)"
            >
              …and {{ (codeplug.contacts.length - 200).toLocaleString() }} more. All of them are in the
              backup; only the first 200 are listed here.
            </p>
          </template>
        </div>
        <p class="note">
          Read from the radio and never written back. The address book has no memory-block id and no
          hardware capture with more than one entry in it, so boofwang can show you what is there but will
          not write over 4 MB of somebody's contacts on the strength of that.
        </p>
      </section>
    </template>
  </div>
</template>

<style scoped>
.sec {
  font-size: 13px;
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
  font-size: 12.5px;
  color: var(--mu);
  padding: 16px 14px;
}
.idx {
  font-family: var(--font-mono, ui-monospace), monospace;
  font-size: 11.5px;
  color: var(--mu);
  width: 22px;
  flex-shrink: 0;
  padding-top: 2px;
}
.meta {
  font-family: var(--font-mono, ui-monospace), monospace;
  font-size: 11.5px;
  color: var(--mu);
  line-height: 1.55;
}
.note {
  font-size: 11.5px;
  color: var(--mu);
  margin-top: 6px;
  line-height: 1.6;
  max-width: 74ch;
}
</style>

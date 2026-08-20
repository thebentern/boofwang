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
useSeoMeta({ title: 'Zones and talk groups' })

const codeplug = useCodeplugStore()

const features = computed(() => codeplug.schema?.features ?? null)
const hasZones = computed(() => !!features.value?.zones)
const hasTalkGroups = computed(() => !!features.value?.talkGroups)
const supported = computed(() => hasZones.value || hasTalkGroups.value)

const zoneNameLength = computed(() =>
  features.value?.zones ? features.value.zones.nameLength : 16,
)
const tgNameLength = computed(() =>
  features.value?.talkGroups ? features.value.talkGroups.nameLength : 16,
)

const editingZone = ref<string | null>(null)
const editingGroup = ref<string | null>(null)
const draft = ref('')

function startZone(id: string, name: string) {
  editingGroup.value = null
  editingZone.value = id
  draft.value = name
}

function startGroup(id: string, name: string) {
  editingZone.value = null
  editingGroup.value = id
  draft.value = name
}

function commit() {
  if (editingZone.value) codeplug.renameZone(editingZone.value, draft.value.trim())
  else if (editingGroup.value) codeplug.renameTalkGroup(editingGroup.value, draft.value.trim())
  cancel()
}

function cancel() {
  editingZone.value = null
  editingGroup.value = null
  draft.value = ''
}

const CALL_TYPE: Record<string, string> = {
  group: 'Group call',
  private: 'Private call',
  allCall: 'All call',
}

const INPUT_STYLE =
  'height: 29px; background: var(--pn); border: 1px solid var(--ln2); color: var(--tx); font-size: 12.5px'

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
  <div class="mx-auto" style="max-width: 840px; padding: 22px 16px 48px">
    <div class="flex items-center gap-2.5 flex-wrap" style="margin-bottom: 11px">
      <UIcon name="i-lucide-folder-tree" class="shrink-0" style="width: 17px; height: 17px; color: var(--cn)" />
      <h1 style="font-size: 17px; font-weight: 600; letter-spacing: -0.02em; color: var(--tx)">
        Zones and talk groups
      </h1>
      <span v-if="codeplug.isOpen && supported" class="ms-auto" style="font-size: 12px; color: var(--mu)">
        {{ codeplug.zones.length }} zone{{ codeplug.zones.length === 1 ? '' : 's' }},
        {{ codeplug.talkGroups.length }} talk group{{ codeplug.talkGroups.length === 1 ? '' : 's' }}
      </span>
    </div>

    <div
      v-if="!codeplug.isOpen"
      style="border: 1px solid var(--ln); background: var(--pn); border-radius: 7px; padding: 18px"
    >
      <h2 style="font-size: 13px; font-weight: 600; color: var(--tx); margin-bottom: 5px">No codeplug open</h2>
      <p style="font-size: 12.5px; line-height: 1.6; color: var(--mu); max-width: 74ch; margin-bottom: 13px">
        Zones and talk groups belong to a codeplug. Read a radio that has them, or open a codeplug file you
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
        The {{ codeplug.schema?.vendor }} {{ codeplug.schema?.model }} has no zones or talk groups
      </h2>
      <p style="font-size: 12.5px; line-height: 1.6; color: var(--mu); max-width: 74ch">
        These are DMR features. Of the radios boofwang supports, only the Baofeng DM-32UV has them.
      </p>
    </div>

    <template v-else>
      <!-- Zones -->
      <section v-if="hasZones" style="margin-bottom: 18px">
        <h2 style="font-size: 13px; font-weight: 600; color: var(--tx); margin-bottom: 7px">Zones</h2>
        <div style="border: 1px solid var(--ln); background: var(--pn); border-radius: 7px; overflow: hidden">
          <p
            v-if="codeplug.zones.length === 0"
            style="font-size: 12.5px; color: var(--mu); padding: 16px 14px"
          >
            This codeplug has no zones.
          </p>
          <template v-else>
            <div v-for="(zone, i) in codeplug.zones" :key="zone.id">
              <div
                class="flex items-start gap-3"
                :style="`padding: 11px 13px; ${i ? 'border-top: 1px solid var(--ln);' : ''}`"
              >
                <span
                  class="font-mono shrink-0"
                  style="font-size: 11.5px; color: var(--mu); width: 22px; padding-top: 2px"
                >{{ i + 1 }}</span>

                <div class="min-w-0 flex-1">
                  <template v-if="editingZone === zone.id">
                    <div class="flex items-center gap-2">
                      <input
                        v-model="draft"
                        type="text"
                        class="rounded-[6px] px-2.5 outline-none w-full"
                        :style="INPUT_STYLE"
                        :maxlength="zoneNameLength"
                        autocomplete="off"
                        spellcheck="false"
                        @keyup.enter="commit"
                        @keyup.escape="cancel"
                      >
                      <RiskAction risk="neutral" size="sm" icon="i-lucide-check" label="Save" @click="commit" />
                      <RiskAction risk="neutral" ghost size="sm" label="Cancel" @click="cancel" />
                    </div>
                    <p style="font-size: 11.5px; color: var(--mu); margin-top: 5px">
                      Up to {{ zoneNameLength }} characters.
                    </p>
                  </template>

                  <template v-else>
                    <div class="flex items-center gap-2 flex-wrap">
                      <span style="font-size: 13px; font-weight: 600; color: var(--tx)">
                        {{ zone.name || '(unnamed)' }}
                      </span>
                      <button
                        type="button"
                        class="chip"
                        style="border: 1px solid var(--ln2); background: transparent; color: var(--mu); cursor: pointer"
                        @click="startZone(zone.id, zone.name)"
                      >Rename</button>
                    </div>
                    <p
                      class="font-mono"
                      style="font-size: 11.5px; color: var(--mu); margin-top: 4px; line-height: 1.55"
                    >
                      {{ zone.channels.length }} channel{{ zone.channels.length === 1 ? '' : 's' }}:
                      {{ runs(zone.channels) }}
                      <template v-if="zone.channels.length">
                        <span style="color: var(--fn)"> — {{ nameOf(zone.channels[0]!) }}…</span>
                      </template>
                    </p>
                  </template>
                </div>
              </div>
            </div>
          </template>
        </div>
        <p style="font-size: 11.5px; color: var(--mu); margin-top: 6px; line-height: 1.6; max-width: 74ch">
          Which channels a zone contains is read from the radio and written back unchanged. A zone holds
          absolute channel numbers, so changing the list here would need to account for what the radio does
          when one points at an emptied slot — which is not yet established.
        </p>
      </section>

      <!-- Talk groups -->
      <section v-if="hasTalkGroups">
        <h2 style="font-size: 13px; font-weight: 600; color: var(--tx); margin-bottom: 7px">Talk groups</h2>
        <div style="border: 1px solid var(--ln); background: var(--pn); border-radius: 7px; overflow: hidden">
          <p
            v-if="codeplug.talkGroups.length === 0"
            style="font-size: 12.5px; color: var(--mu); padding: 16px 14px"
          >
            This codeplug has no talk groups.
          </p>
          <template v-else>
            <div
              v-for="(group, i) in codeplug.talkGroups"
              :key="group.id"
              class="flex items-center gap-3"
              :style="`padding: 10px 13px; ${i ? 'border-top: 1px solid var(--ln);' : ''}`"
            >
              <span
                class="font-mono shrink-0"
                style="font-size: 11.5px; color: var(--mu); width: 22px"
              >{{ i + 1 }}</span>

              <div class="min-w-0 flex-1">
                <div v-if="editingGroup === group.id" class="flex items-center gap-2">
                  <input
                    v-model="draft"
                    type="text"
                    class="rounded-[6px] px-2.5 outline-none w-full"
                    :style="INPUT_STYLE"
                    :maxlength="tgNameLength"
                    autocomplete="off"
                    spellcheck="false"
                    @keyup.enter="commit"
                    @keyup.escape="cancel"
                  >
                  <RiskAction risk="neutral" size="sm" icon="i-lucide-check" label="Save" @click="commit" />
                  <RiskAction risk="neutral" ghost size="sm" label="Cancel" @click="cancel" />
                </div>
                <div v-else class="flex items-center gap-2 flex-wrap">
                  <span style="font-size: 13px; font-weight: 600; color: var(--tx)">
                    {{ group.name || '(unnamed)' }}
                  </span>
                  <button
                    type="button"
                    class="chip"
                    style="border: 1px solid var(--ln2); background: transparent; color: var(--mu); cursor: pointer"
                    @click="startGroup(group.id, group.name)"
                  >Rename</button>
                </div>
              </div>

              <span class="font-mono shrink-0" style="font-size: 12px; color: var(--tx)">{{ group.number }}</span>
              <span class="chip shrink-0" style="border: 1px solid var(--ln2); background: transparent; color: var(--mu)">
                {{ CALL_TYPE[group.callType] ?? group.callType }}
              </span>
            </div>
          </template>
        </div>
        <p style="font-size: 11.5px; color: var(--mu); margin-top: 6px; line-height: 1.6; max-width: 74ch">
          A talk group's number and call type come from the radio and are written back unchanged.
        </p>
      </section>
    </template>
  </div>
</template>

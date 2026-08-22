<script setup lang="ts">
import type { TalkGroupRecord } from '#core/data/source.js'
import { sourceById } from '#core/data/registry.js'

const source = sourceById('brandmeister')

/**
 * Bringing talk groups in from a directory.
 *
 * Before this, the only way to fill an eight-hundred-entry list was to type it
 * one row at a time.
 *
 * The whole design turns on one number: BrandMeister publishes about 1,800 talk
 * groups and the DM-32UV holds 800. There is no "import all" here because there
 * cannot be one, and a list that quietly stopped at 800 would look exactly like
 * a list that fitted. So the choosing is explicit, the room left is always on
 * screen, and anything that would not fit is reported by count.
 */

const props = defineProps<{
  /** Slots the radio has for talk groups. */
  max: number
  /** How many are already used. */
  used: number
}>()

const emit = defineEmits<{ import: [entries: readonly { number: number; name: string }[]] }>()

const sources = useDataSources()
const toast = useToast()

/** The list is long enough that rendering it whole is wasted work. Same cap the contacts list uses. */
const SHOWN = 100

const open = ref(false)
const loading = ref(false)
const fetched = ref<readonly TalkGroupRecord[]>([])
const query = ref('')
const picked = ref(new Set<number>())

const roomLeft = computed(() => Math.max(0, props.max - props.used))
const overflow = computed(() => Math.max(0, picked.value.size - roomLeft.value))

const matching = computed(() => {
  const q = query.value.trim().toLowerCase()
  if (q === '') return fetched.value
  return fetched.value.filter(
    (t) => t.name.toLowerCase().includes(q) || String(t.number).startsWith(q),
  )
})

const shown = computed(() => matching.value.slice(0, SHOWN))

async function fetchAll() {
  loading.value = true
  try {
    const { talkGroups, issues } = await sources.fetchTalkGroups('brandmeister')
    fetched.value = talkGroups
    open.value = true
    const errors = issues.filter((i) => i.severity === 'error').length
    if (errors > 0) {
      toast.add({
        title: `${talkGroups.length} talk groups`,
        description: `${errors} entr${errors === 1 ? 'y' : 'ies'} could not be read and were left out.`,
        icon: 'i-lucide-triangle-alert',
        color: 'warning',
        duration: 8000,
      })
    }
  } catch (e) {
    toast.add({
      title: 'Could not reach BrandMeister',
      description: e instanceof Error ? e.message : String(e),
      icon: 'i-lucide-circle-alert',
      color: 'error',
      duration: 0,
    })
  } finally {
    loading.value = false
  }
}

function toggle(number: number) {
  const next = new Set(picked.value)
  if (next.has(number)) next.delete(number)
  else next.add(number)
  picked.value = next
}

/** Select what is on screen, never the whole directory: it does not fit and never will. */
function pickShown() {
  const next = new Set(picked.value)
  for (const t of shown.value) next.add(t.number)
  picked.value = next
}

function clearPicked() {
  picked.value = new Set()
}

function apply() {
  const chosen = fetched.value.filter((t) => picked.value.has(t.number))
  emit('import', chosen.map((t) => ({ number: t.number, name: t.name })))
  picked.value = new Set()
  open.value = false
}
</script>

<template>
  <div>
    <RiskAction
      risk="neutral" ghost size="sm"
      :icon="loading ? 'i-lucide-loader-circle' : 'i-lucide-download'"
      :label="loading ? 'Fetching from BrandMeister' : 'Import from BrandMeister'"
      :disabled="loading"
      @click="open ? (open = false) : fetchAll()"
    />

    <div
      v-if="open"
      style="margin-top: 9px; border: 1px solid var(--ln); border-radius: 7px; background: var(--pn2)"
    >
      <div
        class="flex items-center gap-2 flex-wrap"
        style="padding: 10px 12px; border-bottom: 1px solid var(--ln)"
      >
        <UIcon name="i-lucide-search" style="width: 14px; height: 14px; color: var(--fn)" />
        <input
          v-model="query"
          type="search"
          placeholder="Filter by name or number"
          class="rounded-[6px] px-2 outline-none"
          style="height: 28px; flex: 1 1 180px; background: var(--pn); border: 1px solid var(--ln2); color: var(--tx); font-size: 13px"
        >
        <span class="label-xs" style="color: var(--mu)">
          {{ matching.length }} of {{ fetched.length }}
        </span>
      </div>

      <!--
        Said where the data is, as the repeaters page does. `lib/data/source.ts`
        promises attribution "wherever data from this source is displayed", and
        this list named BrandMeister only in its failure toast.
      -->
      <p v-if="source" style="margin: 0 0 6px; font-size: 12.5px; line-height: 1.5; color: var(--mu)">
        <span class="label-xs" style="color: var(--fn)">Source</span>
        {{ source.attribution }} · {{ source.licence }}
      </p>

      <div style="max-height: 260px; overflow-y: auto">
        <label
          v-for="(t, i) in shown"
          :key="t.number"
          class="flex items-center gap-3"
          :style="`padding: 8px 12px; cursor: pointer; ${i ? 'border-top: 1px solid var(--ln);' : ''}`"
        >
          <input
            type="checkbox"
            :checked="picked.has(t.number)"
            style="width: 14px; height: 14px"
            @change="toggle(t.number)"
          >
          <span class="font-mono" style="font-size: 13px; color: var(--mu); width: 74px">{{ t.number }}</span>
          <span style="font-size: 13.5px; color: var(--tx)">{{ t.name }}</span>
        </label>
        <p
          v-if="matching.length > SHOWN"
          style="margin: 0; padding: 9px 12px; font-size: 12.5px; color: var(--mu); border-top: 1px solid var(--ln)"
        >
          {{ matching.length - SHOWN }} more match. Narrow the filter to see them.
        </p>
        <p v-if="matching.length === 0" class="empty">Nothing matches that.</p>
      </div>

      <div
        class="flex items-center gap-2 flex-wrap"
        style="padding: 10px 12px; border-top: 1px solid var(--ln)"
      >
        <RiskAction
          risk="neutral" ghost size="sm" icon="i-lucide-check" label="Select these"
          :disabled="shown.length === 0" @click="pickShown"
        />
        <RiskAction
          risk="neutral" ghost size="sm" icon="i-lucide-x" label="Clear"
          :disabled="picked.size === 0" @click="clearPicked"
        />

        <!--
          The room left, always visible. This is the number that decides whether
          the import is possible at all, so it does not hide behind a warning
          that only appears once it is too late.
        -->
        <span class="ms-auto label-xs" :style="`color: ${overflow ? 'var(--cau)' : 'var(--mu)'}`">
          {{ picked.size }} chosen · room for {{ roomLeft }}
        </span>
        <RiskAction
          risk="neutral" size="sm" icon="i-lucide-plus"
          :label="`Add ${Math.min(picked.size, roomLeft)}`"
          :disabled="picked.size === 0 || roomLeft === 0"
          @click="apply"
        />
      </div>

      <p
        v-if="overflow"
        style="margin: 0; padding: 0 12px 11px; font-size: 12.5px; line-height: 1.5; color: var(--cau)"
      >
        {{ overflow }} more {{ overflow === 1 ? 'is' : 'are' }} chosen than this radio has room for.
        {{ overflow === 1 ? 'It' : 'They' }} will not be added.
      </p>
    </div>
  </div>
</template>

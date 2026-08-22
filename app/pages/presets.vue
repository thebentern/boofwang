<script setup lang="ts">
import type { Channel } from '#core/model/channel.js'
import { formatPower } from '#core/model/units.js'
import {
  PRESET_GROUPS,
  PRESET_SETS,
  presetLine,
  presetToChannel,
  presetToClampedChannel,
  type PresetChannel,
  type PresetSet,
} from '#core/io/preset-data.js'

/**
 * The complete route to a programmed radio for someone who never opens the
 * channel table.
 *
 * The screen is three columns because the question has three parts, and they
 * have to stay on screen together: which set, what is in it, and where it
 * lands. The plan on the right is the whole point - it recomputes on every
 * keystroke and every policy change, so the consequence of a collision is
 * visible before anything is committed rather than discovered afterwards in
 * the channel table.
 *
 * Nothing here reaches the radio. Staging writes into the open codeplug and
 * marks it dirty, which puts the write flow's backup-diff-confirm sequence
 * between these channels and any hardware.
 */
useSeoMeta({ title: 'Presets' })

const codeplug = useCodeplugStore()

type Policy = 'shift' | 'over' | 'gaps'
type Tone = 'ok' | 'cn' | 'dg' | 'in' | 'neutral'

const CONTENT_COLUMNS = '26px 26px minmax(90px,1fr) 90px 56px 56px'

const TONES: Record<Tone, { color: string, bg: string, border: string }> = {
  ok: { color: 'var(--ok)', bg: 'var(--okB)', border: 'var(--okL)' },
  cn: { color: 'var(--cn)', bg: 'var(--cnB)', border: 'var(--cnL)' },
  dg: { color: 'var(--dg)', bg: 'var(--dgB)', border: 'var(--dgL)' },
  in: { color: 'var(--in)', bg: 'var(--inB)', border: 'var(--inL)' },
  neutral: { color: 'var(--mu)', bg: 'var(--pn2)', border: 'var(--ln)' },
}

function chipStyle(tone: Tone) {
  const t = TONES[tone]
  return { color: t.color, background: t.bg, border: `1px solid ${t.border}` }
}

const PLAN_KIND = {
  add: { label: 'add', icon: 'i-lucide-plus', tone: 'in' },
  move: { label: 'move', icon: 'i-lucide-arrow-up-down', tone: 'cn' },
  over: { label: 'over', icon: 'i-lucide-trash-2', tone: 'dg' },
} as const

type PlanKind = keyof typeof PLAN_KIND

const POLICIES: readonly { id: Policy, label: string, sub: string, icon: string }[] = [
  {
    id: 'shift',
    label: 'Keep and shift',
    sub: 'Existing channels move down. Nothing is lost.',
    icon: 'i-lucide-arrow-up-down',
  },
  { id: 'over', label: 'Overwrite', sub: 'Existing channels in range are replaced.', icon: 'i-lucide-trash-2' },
  { id: 'gaps', label: 'Fill empty slots only', sub: 'Skips anything already programmed.', icon: 'i-lucide-circle-minus' },
]

const { imported, load: loadImported, importCsv } = useImportedPresets()
const toast = useToast()
const fileInput = useTemplateRef<HTMLInputElement>('fileInput')

// Sets live in IndexedDB, so they arrive a tick after the page does. The
// bundled sets render immediately either way.
onMounted(() => void loadImported())

/** Bundled sets first, then whatever the user has brought in. */
const allSets = computed<PresetSet[]>(() => [...PRESET_SETS, ...imported.value])

const selectedId = ref(PRESET_SETS[0]!.id)
const selectedSet = computed<PresetSet>(() => allSets.value.find((s) => s.id === selectedId.value) ?? PRESET_SETS[0]!)

/** A set nobody may transmit on gets the caution icon in the library, NOAA included. */
function isListenOnlySet(set: PresetSet): boolean {
  return set.channels.every((c) => !c.txAllowed)
}

const setsByGroup = computed(() =>
  PRESET_GROUPS.map((g) => ({ ...g, items: allSets.value.filter((s) => s.group === g.id) })),
)

/**
 * Read a channel list the user exported from somewhere else.
 *
 * RepeaterBook, RadioReference and CHIRP all export the same CHIRP CSV, so one
 * reader covers all three - and none of them needs a network call, an API key,
 * or somebody's password for another site. RepeaterBook's terms forbid
 * redistributing its data anyway, so a file the user downloaded themselves is
 * the only honest route.
 */
async function onFilePicked(event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0]
  if (!file) return
  try {
    const { set, issues, unknownColumns } = await importCsv(file.name, await file.text())
    if (!set) {
      toast.add({
        title: 'Nothing to import',
        description: issues[0]?.message ?? 'No channels were found in that file.',
        icon: 'i-lucide-circle-alert',
        color: 'error',
        duration: 0,
      })
      return
    }
    selectedId.value = set.id
    const problems = issues.filter((i) => i.severity === 'error').length
    toast.add({
      title: `Imported ${set.channels.length} channel${set.channels.length === 1 ? '' : 's'}`,
      description: [
        problems ? `${problems} row${problems === 1 ? '' : 's'} could not be read and were skipped.` : '',
        unknownColumns.length ? `Columns ignored: ${unknownColumns.join(', ')}.` : '',
      ].filter(Boolean).join(' ') || 'Staged nowhere yet. Place it below when you are ready.',
      icon: problems ? 'i-lucide-triangle-alert' : 'i-lucide-circle-check',
      color: problems ? 'warning' : 'success',
      duration: 10_000,
    })
  } catch (e) {
    // Running out of room and failing to parse are different problems with
    // different fixes, and telling someone the file was unreadable when their
    // disk is full sends them to correct the wrong thing.
    const quota = isQuotaError(e)
    toast.add({
      title: quota ? 'No room to keep that set' : 'Could not read that file',
      description: quota
        ? 'The browser is out of storage for this site. Delete a backup or a saved set and try again.'
        : e instanceof Error ? e.message : String(e),
      icon: 'i-lucide-circle-alert',
      color: 'error',
      duration: 0,
    })
  } finally {
    if (fileInput.value) fileInput.value.value = ''
  }
}

/**
 * Rows the user has turned off, by position in the set.
 *
 * Held as exclusions rather than inclusions so the default is "all of it":
 * a band plan is a set, and staging half of one is the exception.
 */
const excluded = ref(new Set<number>())
watch(selectedId, () => { excluded.value = new Set() })

function toggleRow(at: number) {
  const next = new Set(excluded.value)
  if (!next.delete(at)) next.add(at)
  excluded.value = next
}

const picked = computed<readonly PresetChannel[]>(() =>
  selectedSet.value.channels.filter((_, i) => !excluded.value.has(i)),
)

/**
 * The last usable slot.
 *
 * `channelCount` and not the special channels past it: the UV-K5's 200-213 are
 * VFO presets with no name storage, and a band plan must never spill into them.
 */
const firstIndex = computed(() => codeplug.schema?.memory.firstIndex ?? 1)
const capacity = computed(() => firstIndex.value + (codeplug.schema?.memory.channelCount ?? 0) - 1)

const occupied = computed(() => new Map(codeplug.channels.map((c) => [c.index, c] as const)))

const startSlot = ref('1')

/**
 * Default to the first free slot of whichever codeplug is open.
 *
 * Watching `doc` rather than `revision`: the document identity changes when a
 * different radio is read, which is when the default is stale. An edit inside
 * the same codeplug must not move the cursor out from under someone.
 */
watch(
  () => codeplug.doc,
  () => {
    let slot = firstIndex.value
    while (slot <= capacity.value && occupied.value.has(slot)) slot++
    startSlot.value = String(Math.min(slot, Math.max(capacity.value, firstIndex.value)))
  },
  { immediate: true },
)

function onStartInput(event: Event) {
  const el = event.target as HTMLInputElement
  const cleaned = el.value.replace(/\D/g, '').slice(0, 3)
  el.value = cleaned
  startSlot.value = cleaned
}

const startNum = computed(() => {
  const n = Number.parseInt(startSlot.value, 10)
  return Number.isFinite(n) && n >= firstIndex.value ? n : firstIndex.value
})

const policy = ref<Policy>('shift')

interface PlanRow {
  readonly key: string
  readonly slot: number
  readonly kind: PlanKind
  readonly text: string
}

/** `Slot 12` · `Slots 12 and 13` · `Slots 12, 13 and 14` · `Slots 12, 13, 14 and 5 more`. */
function slotList(slots: readonly number[]): string {
  const head = slots.slice(0, 3)
  const rest = slots.length - head.length
  const noun = slots.length === 1 ? 'Slot' : 'Slots'
  if (rest > 0) return `${noun} ${head.join(', ')} and ${rest} more`
  if (head.length === 1) return `${noun} ${head[0]}`
  return `${noun} ${head.slice(0, -1).join(', ')} and ${head[head.length - 1]}`
}

function channelLabel(c: Channel): string {
  return c.name.trim() || `slot ${c.index}`
}

/**
 * What staging would do, recomputed from the start slot and the policy.
 *
 * It produces the moves and placements the stage action replays, not just the
 * sentences shown - so the list on screen cannot describe one thing while the
 * button does another.
 */
const plan = computed(() => {
  const set = selectedSet.value
  const picks = picked.value
  const n = picks.length
  const cap = capacity.value
  const start = startNum.value
  const held = occupied.value
  const mode = policy.value

  const placements: { slot: number, source: PresetChannel }[] = []
  const moves: { from: number, to: number }[] = []
  const lostSlots: number[] = []
  const replacedSlots: number[] = []
  let skipped = 0

  if (mode === 'gaps') {
    let slot = start
    while (placements.length < n && slot <= cap) {
      if (held.has(slot)) skipped++
      else placements.push({ slot, source: picks[placements.length]! })
      slot++
    }
  }
  else {
    if (mode === 'shift') {
      /*
       * Only what is in the way moves, and whatever that lands on moves too.
       *
       * Shifting every channel at or after the start slot would renumber
       * memories nothing was going to touch - a set placed at 12 has no
       * business moving a channel at 150 that nothing collides with.
       */
      const moving = new Set<number>()
      const queue: number[] = []
      for (let i = 0; i < n; i++) {
        const slot = start + i
        if (slot <= cap && held.has(slot)) queue.push(slot)
      }
      while (queue.length > 0) {
        const from = queue.shift()!
        if (moving.has(from)) continue
        moving.add(from)
        const to = from + n
        if (held.has(to) && !moving.has(to)) queue.push(to)
      }
      for (const from of [...moving].sort((a, b) => a - b)) {
        if (from + n > cap) lostSlots.push(from)
        else moves.push({ from, to: from + n })
      }
    }
    for (let i = 0; i < n; i++) {
      const slot = start + i
      if (slot > cap) break
      if (mode === 'over' && held.has(slot)) replacedSlots.push(slot)
      placements.push({ slot, source: picks[i]! })
    }
  }

  const rows: PlanRow[] = []
  for (const p of placements) {
    const replaced = mode === 'over' ? held.get(p.slot) : undefined
    rows.push(
      replaced
        ? { key: `p${p.slot}`, slot: p.slot, kind: 'over', text: `replaces ${channelLabel(replaced)} (existing)` }
        : { key: `p${p.slot}`, slot: p.slot, kind: 'add', text: presetLine(p.source) },
    )
  }
  for (const m of moves) {
    const c = held.get(m.from)
    rows.push({
      key: `m${m.from}`,
      slot: m.from,
      kind: 'move',
      text: `${c ? channelLabel(c) : 'existing channel'} shifts to slot ${m.to}`,
    })
  }
  for (const slot of lostSlots) {
    const c = held.get(slot)
    rows.push({
      key: `l${slot}`,
      slot,
      kind: 'over',
      text: `${c ? channelLabel(c) : 'existing channel'} would be pushed past slot ${cap}`,
    })
  }
  rows.sort((a, b) => a.slot - b.slot || a.kind.localeCompare(b.kind))

  let chipText = 'no conflicts'
  let chipTone: Tone = 'ok'
  let borderColor = 'var(--ln)'
  let note = ''
  let noteTone: Tone = 'cn'

  if (n === 0) {
    chipText = 'nothing selected'
    chipTone = 'cn'
    borderColor = 'var(--cnL)'
  }
  else if (lostSlots.length > 0) {
    chipText = `${lostSlots.length} would be lost`
    chipTone = 'dg'
    borderColor = 'var(--dgL)'
  }
  else if (replacedSlots.length > 0) {
    chipText = `${replacedSlots.length} overwritten`
    chipTone = 'dg'
    borderColor = 'var(--dgL)'
  }
  else if (moves.length > 0) {
    chipText = `${moves.length} shifted`
    chipTone = 'cn'
    borderColor = 'var(--cnL)'
  }
  else if (placements.length < n) {
    chipText = `${placements.length} of ${n} fit`
    chipTone = 'cn'
    borderColor = 'var(--cnL)'
  }

  if (n === 0) {
    note = 'Nothing is selected. Tick at least one channel in the set.'
  }
  else if (lostSlots.length > 0) {
    note = `${slotList(lostSlots)} would be pushed past slot ${cap} and lost. `
      + 'Start lower, or choose Overwrite and see exactly what goes.'
    noteTone = 'dg'
  }
  else if (placements.length === 0) {
    note = `No slot at or after ${start} can take this set. This radio ends at slot ${cap}.`
    noteTone = 'dg'
  }
  else if (placements.length < n) {
    note = `Only ${placements.length} of ${n} channels fit from slot ${start}. The rest are not staged.`
  }
  else if (replacedSlots.length > 0) {
    note = `${slotList(replacedSlots)} already hold channels and will be replaced. `
      + 'Nothing recovers them but a backup.'
  }
  else if (moves.length > 0) {
    note = `${slotList(moves.map((m) => m.from))} already hold channels, so they shift down by ${n}. `
      + 'Slot numbers change; nothing is lost.'
  }
  else if (skipped > 0) {
    note = `${skipped} programmed slot${skipped === 1 ? '' : 's'} skipped. Nothing already in the codeplug is touched.`
  }

  return {
    set,
    rows,
    placements,
    moves,
    lost: lostSlots.length,
    chipText,
    chipTone,
    borderColor,
    note,
    noteTone,
    canStage: codeplug.isOpen && placements.length > 0 && lostSlots.length === 0,
  }
})

const rangeLabel = computed(() => {
  const p = plan.value.placements
  if (picked.value.length === 0) return `nothing selected · ${capacity.value} slots`
  if (p.length === 0) return `nothing fits · ${capacity.value} slots`
  const lo = p[0]!.slot
  const hi = p[p.length - 1]!.slot
  return lo === hi ? `slot ${lo} of ${capacity.value}` : `slots ${lo}–${hi} of ${capacity.value}`
})

const stageLabel = computed(() => {
  const n = plan.value.placements.length
  return `Stage ${n} channel${n === 1 ? '' : 's'}`
})

/**
 * Write the plan into the open codeplug.
 *
 * A bulk slot rewrite is not something `updateChannel` can express - it patches
 * one existing index and refuses an empty slot - so this goes through
 * `setChannelRecord`, which places an exact record into any slot at all.
 *
 * All of it inside one `transact`, because staging a preset is one decision.
 * The plan is shown before it commits and the user agreed to that plan, not to
 * twenty separate placements they would then have to take back one at a time.
 * The store publishes the frozen list, re-runs the diagnostics and bumps the
 * revision once, when the transaction closes.
 */
function stage() {
  const cp = codeplug.doc
  const p = plan.value
  if (!cp || !p.canStage) return

  const stagedAt = new Date().toISOString()

  const refused: string[] = []
  codeplug.transact('preset stage', () => {
    // Highest slot first: a channel moving from 12 to 22 must not land on 22
    // before whatever is already at 22 has itself moved out.
    for (const m of [...p.moves].sort((a, b) => b.from - a.from)) {
      const existing = cp.channels.get(m.from)
      if (!existing) continue
      codeplug.setChannelRecord(m.from, null)
      codeplug.setChannelRecord(m.to, Object.freeze({ ...existing, index: m.to }))
    }

    for (const place of p.placements) {
      // Through the shared clamp pipeline when there is a radio to clamp to.
      // Power and name length were checked before; bands were not, and staging
      // a preset the radio cannot receive is not a clamp - it is a slot
      // programmed with something that does nothing.
      if (!codeplug.schema) {
        codeplug.setChannelRecord(
          place.slot,
          Object.freeze(presetToChannel(place.source, p.set, place.slot, null, stagedAt)),
        )
        continue
      }
      // `codeplug.rf` rather than the schema's: an egzumer UV-K5 reaches
      // frequencies the stock table does not list, and the clamp would
      // otherwise refuse presets the channel editor accepts on the same radio.
      const out = presetToClampedChannel(
        place.source,
        p.set,
        place.slot,
        codeplug.schema,
        stagedAt,
        codeplug.rf ?? undefined,
      )
      if (out.channel === null) {
        refused.push(`${place.source.name}: ${out.refusal?.why ?? 'this radio cannot hold it'}`)
        continue
      }
      codeplug.setChannelRecord(place.slot, Object.freeze(out.channel))
    }
  })

  if (refused.length > 0) {
    toast.add({
      title: `${refused.length} preset(s) were left out`,
      description: refused.slice(0, 3).join('; ') + (refused.length > 3 ? `; and ${refused.length - 3} more.` : ''),
      icon: 'i-lucide-triangle-alert',
      color: 'warning',
      duration: 14_000,
    })
  }

  void navigateTo('/channels')
}
</script>

<template>
  <div class="mx-auto max-w-[1400px]" style="padding: 19px 17px 30px">
    <div class="flex items-center gap-2.5 flex-wrap" style="margin-bottom: 12px">
      <UIcon name="i-lucide-layers" class="shrink-0" style="width: 15px; height: 15px; color: var(--mu)" />
      <h1 style="font-size: 19px; font-weight: 600; letter-spacing: -0.02em; color: var(--tx)">Presets</h1>
      <span style="font-size: 13.5px; color: var(--fn)">
        Bundled channel sets, placed into slots you choose. Nothing commits until you have seen the plan.
      </span>
    </div>

    <div class="grid gap-3 items-start grid-cols-1 lg:grid-cols-[214px_minmax(0,1fr)_298px]">
      <!-- Library -->
      <div style="border: 1px solid var(--ln); background: var(--pn); border-radius: 7px; overflow: hidden">
        <div
          class="flex items-center gap-[7px]"
          style="padding: 12px 15px; border-bottom: 1px solid var(--ln)"
        >
          <UIcon name="i-lucide-layers" style="width: 12px; height: 12px; color: var(--fn)" />
          <span class="label-xs" style="letter-spacing: 0.07em">Library</span>
        </div>

        <div v-for="group in setsByGroup.filter((g) => g.items.length > 0)" :key="group.id">
          <div class="label-xs" style="padding: 8px 12px 4px; font-weight: 400">{{ group.label }}</div>

          <button
            v-for="set in group.items"
            :key="set.id"
            type="button"
            class="w-full flex items-center justify-between gap-2 text-left"
            style="padding: 6px 12px; font-size: 14px; cursor: pointer"
            :style="{
              borderLeft: `2px solid ${selectedId === set.id ? 'var(--tx)' : 'transparent'}`,
              background: selectedId === set.id ? 'var(--pn2)' : 'transparent',
              color: selectedId === set.id ? 'var(--tx)' : 'var(--mu)',
              fontWeight: selectedId === set.id ? 600 : 400,
            }"
            :aria-pressed="selectedId === set.id"
            @click="selectedId = set.id"
          >
            <span class="flex items-center gap-[7px] min-w-0">
              <UIcon
                :name="set.icon"
                class="shrink-0"
                style="width: 13px; height: 13px"
                :style="{
                  color: isListenOnlySet(set)
                    ? 'var(--cn)'
                    : selectedId === set.id ? 'var(--tx)' : 'var(--fn)',
                }"
              />
              <span class="truncate">{{ set.shortName }}</span>
            </span>
            <span class="font-mono tabular shrink-0" style="font-size: 12.5px; color: var(--fn)">
              {{ set.channels.length }}
            </span>
          </button>
        </div>

        <div style="border-top: 1px solid var(--ln); padding: 12px 15px" class="grid gap-2">
          <input
            ref="fileInput"
            type="file"
            accept=".csv,text/csv,text/plain"
            class="hidden"
            @change="onFilePicked"
          >
          <RiskAction
            risk="neutral"
            icon="i-lucide-file-down"
            label="Import a CHIRP CSV…"
            size="sm"
            @click="fileInput?.click()"
          />
          <p style="font-size: 12.5px; line-height: 1.5; color: var(--fn); margin: 0">
            Export a list from
            <a
              href="https://www.repeaterbook.com/"
              target="_blank"
              rel="noopener"
              style="color: var(--in)"
            >RepeaterBook</a>
            or
            <a
              href="https://www.radioreference.com/db/browse/"
              target="_blank"
              rel="noopener"
              style="color: var(--in)"
            >RadioReference</a>
            and open it here.
          </p>
        </div>

      </div>

      <!-- Contents -->
      <div style="border: 1px solid var(--ln); background: var(--pn); border-radius: 7px; overflow: hidden">
        <div style="padding: 15px 17px; border-bottom: 1px solid var(--ln)">
          <div class="flex items-baseline gap-2.5 flex-wrap" style="margin-bottom: 4px">
            <span style="font-size: 15px; font-weight: 600; color: var(--tx)">{{ selectedSet.name }}</span>
            <span class="chip" :style="chipStyle(selectedSet.source === 'Bundled' ? 'neutral' : 'in')">
              {{ selectedSet.source }}
            </span>
          </div>
          <p style="margin: 0; font-size: 13.5px; line-height: 1.55; color: var(--mu); max-width: 72ch">
            {{ selectedSet.description }}
          </p>

          <!--
            What it takes to be allowed to transmit here, stated once and not
            enforced. A per-row "allowed" chip said nothing useful - it was
            "allowed" on every row of every set - while the thing that actually
            varies is the licence, and that is not something a codeplug editor
            can check or should pretend to police.
          -->
          <div
            class="flex items-start gap-2"
            style="margin-top: 11px; padding: 9px 11px; border-radius: 6px; background: var(--pn2); border: 1px solid var(--ln)"
          >
            <UIcon
              name="i-lucide-badge-check"
              class="shrink-0"
              style="width: 14px; height: 14px; color: var(--fn); margin-top: 1px"
            />
            <p style="margin: 0; font-size: 13px; line-height: 1.55; color: var(--mu); max-width: 72ch">
              {{ selectedSet.licence }}
              <span style="color: var(--fn)"> You are responsible for what you transmit.</span>
            </p>
          </div>

          <!--
            Where the frequencies came from.

            Written onto every staged channel as `provenance.attribution` since
            the model existed, and shown nowhere until now. For the bundled sets
            that was a small omission. For a fetched set it is not: credit is
            what boofwang offers in place of a licence it does not have, and
            credit nobody can see is not credit. See docs/provenance.md.
          -->
          <p
            style="margin: 9px 0 0; font-size: 12.5px; line-height: 1.5; color: var(--mu)"
          >
            <span class="label-xs" style="color: var(--fn)">Source</span>
            {{ selectedSet.attribution }}
          </p>
        </div>

        <div
          class="label-xs grid items-center"
          style="
            gap: 8px;
            padding: 6px 12px;
            background: var(--pn2);
            border-bottom: 1px solid var(--ln);
            letter-spacing: 0.04em;
          "
          :style="{ gridTemplateColumns: CONTENT_COLUMNS }"
        >
          <span />
          <span class="text-right">#</span>
          <span>Name</span>
          <span class="text-right">Receive</span>
          <span>Tone</span>
          <span class="text-right">Power</span>
        </div>

        <div style="max-height: 396px; overflow: auto">
          <div
            v-for="(channel, at) in selectedSet.channels"
            :key="`${selectedSet.id}-${at}`"
            class="grid items-center"
            style="gap: 8px; padding: 0 12px; height: 30px"
            :style="{
              gridTemplateColumns: CONTENT_COLUMNS,
              borderBottom: '1px solid var(--ln)',
              background: channel.txAllowed ? 'transparent' : 'var(--cnB)',
            }"
          >
            <button
              type="button"
              class="flex items-center justify-center"
              :aria-label="`${excluded.has(at) ? 'Include' : 'Exclude'} ${channel.name}`"
              :aria-pressed="!excluded.has(at)"
              @click="toggleRow(at)"
            >
              <UIcon
                :name="excluded.has(at) ? 'i-lucide-square' : 'i-lucide-check'"
                style="width: 11px; height: 11px"
                :style="{ color: excluded.has(at) ? 'var(--ln2)' : 'var(--in)' }"
              />
            </button>
            <span
              class="font-mono tabular text-right"
              style="font-size: 13px; color: var(--fn)"
            >{{ at + 1 }}</span>
            <span
              class="truncate"
              style="font-size: 14px; font-weight: 500"
              :style="{ color: excluded.has(at) ? 'var(--fn)' : 'var(--tx)' }"
            >{{ channel.name }}</span>
            <span class="font-mono tabular text-right" style="font-size: 13.5px; color: var(--tx)">
              {{ (channel.rxFreq / 1e6).toFixed(5) }}
            </span>
            <span class="font-mono tabular" style="font-size: 13.5px; color: var(--mu)">
              {{ channel.tone.tx?.kind === 'ctcss' ? (channel.tone.tx.deciHz / 10).toFixed(1) : '—' }}
            </span>
            <span class="font-mono tabular text-right" style="font-size: 13.5px; color: var(--fn)">
              <!--
                A set that states no power gets a dash, not a number. A
                repeater directory records where the repeater listens and knows
                nothing about what power you should use; printing one here would
                read as though somebody had decided it. The radio's own maximum
                is what gets staged, and the clamp reports that when it happens.
              -->
              {{ channel.txAllowed && channel.powerMW !== undefined ? formatPower(channel.powerMW) : '—' }}
            </span>
          </div>
        </div>
      </div>

      <!-- Placement and plan -->
      <div class="grid gap-2.5">
        <template v-if="codeplug.isOpen">
          <div style="border: 1px solid var(--ln); background: var(--pn); border-radius: 7px; overflow: hidden">
            <div
              class="flex items-center gap-[7px]"
              style="padding: 12px 16px; border-bottom: 1px solid var(--ln)"
            >
              <UIcon name="i-lucide-hash" style="width: 12px; height: 12px; color: var(--fn)" />
              <span class="label-xs" style="letter-spacing: 0.07em">Placement</span>
            </div>

            <div style="padding: 13px">
              <label
                for="preset-start-slot"
                class="block"
                style="font-size: 13px; color: var(--mu); margin-bottom: 7px"
              >Start at slot</label>
              <div class="flex items-center gap-2" style="margin-bottom: 13px">
                <input
                  id="preset-start-slot"
                  class="font-mono tabular text-right"
                  inputmode="numeric"
                  autocomplete="off"
                  maxlength="3"
                  :value="startSlot"
                  style="
                    height: 33px;
                    width: 64px;
                    border: 1px solid var(--ln2);
                    background: var(--bg);
                    color: var(--tx);
                    border-radius: 5px;
                    font-size: 14.5px;
                    padding: 0 9px;
                    outline: none;
                  "
                  @input="onStartInput"
                >
                <UIcon name="i-lucide-arrow-right" style="width: 12px; height: 12px; color: var(--fn)" />
                <span class="tabular" style="font-size: 13px; color: var(--fn)">{{ rangeLabel }}</span>
              </div>

              <div class="grid gap-1.5">
                <button
                  v-for="option in POLICIES"
                  :key="option.id"
                  type="button"
                  class="flex items-start gap-[9px] text-left"
                  style="padding: 8px 10px; border-radius: 6px; cursor: pointer; color: var(--tx)"
                  :style="{
                    border: `1px solid ${policy === option.id ? 'var(--ln2)' : 'var(--ln)'}`,
                    background: policy === option.id ? 'var(--pn2)' : 'var(--pn)',
                  }"
                  :aria-pressed="policy === option.id"
                  @click="policy = option.id"
                >
                  <span
                    class="shrink-0"
                    style="margin-top: 3px; width: 11px; height: 11px; border-radius: 50%"
                    :style="{
                      border: `1px solid ${policy === option.id ? 'var(--tx)' : 'var(--ln2)'}`,
                      background: policy === option.id ? 'var(--tx)' : 'transparent',
                      boxShadow: policy === option.id ? 'inset 0 0 0 2.5px var(--pn)' : 'none',
                    }"
                  />
                  <span class="min-w-0">
                    <span class="flex items-center gap-1.5" style="font-size: 13.5px; font-weight: 500">
                      <UIcon
                        :name="option.icon"
                        class="shrink-0"
                        style="width: 12px; height: 12px"
                        :style="{
                          color: policy !== option.id
                            ? 'var(--fn)'
                            : option.id === 'over' ? 'var(--dg)' : 'var(--tx)',
                        }"
                      />
                      {{ option.label }}
                    </span>
                    <span
                      class="block"
                      style="font-size: 12.5px; color: var(--fn); line-height: 1.4; margin-top: 2px"
                    >{{ option.sub }}</span>
                  </span>
                </button>
              </div>
            </div>
          </div>

          <div
            style="background: var(--pn); border-radius: 7px; overflow: hidden"
            :style="{ border: `1px solid ${plan.borderColor}` }"
          >
            <div
              class="flex items-center gap-[7px]"
              style="padding: 12px 16px; border-bottom: 1px solid var(--ln)"
            >
              <UIcon name="i-lucide-scale" style="width: 12px; height: 12px; color: var(--fn)" />
              <span class="label-xs" style="letter-spacing: 0.07em">What will change</span>
              <span class="chip ms-auto" :style="chipStyle(plan.chipTone)">{{ plan.chipText }}</span>
            </div>

            <div style="max-height: 212px; overflow: auto">
              <div
                v-for="row in plan.rows"
                :key="row.key"
                class="flex items-center gap-2"
                style="padding: 6px 13px; border-bottom: 1px solid var(--ln)"
              >
                <span
                  class="font-mono tabular text-right shrink-0"
                  style="font-size: 13px; color: var(--fn); width: 22px"
                >{{ row.slot }}</span>
                <span
                  class="chip shrink-0 justify-center"
                  style="width: 56px"
                  :style="chipStyle(PLAN_KIND[row.kind].tone)"
                >
                  <UIcon :name="PLAN_KIND[row.kind].icon" style="width: 11px; height: 11px" />
                  {{ PLAN_KIND[row.kind].label }}
                </span>
                <span class="truncate" style="font-size: 13.5px; color: var(--tx)">{{ row.text }}</span>
              </div>
            </div>

            <div style="border-top: 1px solid var(--ln); padding: 17px 19px" class="grid gap-2">
              <div v-if="plan.note" class="flex items-start gap-[7px]">
                <UIcon
                  name="i-lucide-triangle-alert"
                  class="shrink-0"
                  style="width: 13px; height: 13px; margin-top: 1px"
                  :style="{ color: TONES[plan.noteTone].color }"
                />
                <p
                  style="margin: 0; font-size: 13px; line-height: 1.5"
                  :style="{ color: TONES[plan.noteTone].color }"
                >{{ plan.note }}</p>
              </div>

              <RiskAction
                risk="neutral"
                icon="i-lucide-layers"
                :label="stageLabel"
                :disabled="!plan.canStage"
                @click="stage"
              />

              <span style="font-size: 12.5px; color: var(--fn); line-height: 1.5">
                Staged into the open codeplug only. Nothing reaches the radio until you write.
              </span>
            </div>
          </div>
        </template>

        <div
          v-else
          style="border: 1px solid var(--ln); background: var(--pn); border-radius: 7px; overflow: hidden"
        >
          <div
            class="flex items-center gap-[7px]"
            style="padding: 12px 16px; border-bottom: 1px solid var(--ln)"
          >
            <UIcon name="i-lucide-hash" style="width: 12px; height: 12px; color: var(--fn)" />
            <span class="label-xs" style="letter-spacing: 0.07em">Placement</span>
          </div>
          <div style="padding: 13px">
            <h2 style="font-size: 14.5px; font-weight: 600; color: var(--tx); margin-bottom: 5px">
              No codeplug open
            </h2>
            <p style="margin: 0 0 13px; font-size: 13.5px; line-height: 1.55; color: var(--mu)">
              A preset is placed into slots, and there are no slots without a codeplug. Read a radio, or open a
              codeplug file you saved earlier. The sets stay readable meanwhile.
            </p>
            <div class="flex flex-wrap items-center gap-2.5">
              <RiskAction risk="neutral" icon="i-lucide-usb" label="Connect a radio" @click="navigateTo('/')" />
              <OpenCodeplugButton />
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

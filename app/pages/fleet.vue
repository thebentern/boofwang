<script setup lang="ts">
import { diffChannels } from '#core/radio/channel-diff.js'
import { evaluateWriteGate } from '#core/radio/write-gate.js'
import { exportFleetRecord, exportFleetRoster, parseFleetRoster } from '#core/io/fleet-roster.js'
import type { FleetUnit } from '#core/radio/fleet.js'

/**
 * One codeplug onto a room full of radios.
 *
 * A club buys twenty DM-32UVs and one person builds the channel plan. What
 * every handset needs is that plan; what none of them may share is a DMR ID.
 * So the roster is the spine of this page: a row per radio, carrying the two
 * things that are its own, checked for duplicates before a single radio is
 * plugged in.
 *
 * The run itself is deliberately unremarkable. Each radio is read, which is
 * what stores its backup; the roster row is applied to the master; the diff is
 * shown; the word is typed. That is the ordinary write flow, once per handset,
 * and this page adds a record of which radios have been done rather than a
 * faster way to write to one. There is no bulk send and there is no fleet
 * exception to the typed confirmation.
 */
useSeoMeta({ title: 'Fleet programming' })

const codeplug = useCodeplugStore()
const device = useDeviceStore()
const transfer = useTransferStore()
const fleet = useFleetStore()
const run = useFleetSession()
const session = useRadioSession()
const toast = useToast()

/**
 * Which radio the roster is for.
 *
 * Kept in sync while nothing is running, because the duplicate-ID check needs a
 * schema and its whole value is firing before a radio is plugged in. Once the
 * run starts the store holds its own: the editor's document is replaced by each
 * handset that gets read, and the run must not follow it.
 */
watch(
  () => codeplug.doc?.radio ?? null,
  (id) => fleet.setRadio(id),
  { immediate: true },
)

const model = computed(() => fleet.schema?.model ?? 'radio')

/**
 * Whether this radio has a DMR identity to vary at all.
 *
 * Schema-driven, so an analog radio simply loses the two columns rather than
 * being offered fields it has nowhere to keep. The rest of the run still works
 * on one: the per-unit backup, the diff and the write are what it is made of.
 */
const idFeature = computed(() => fleet.schema?.features.radioIds ?? false)
const varies = computed(() => idFeature.value !== false)

/** Key slots the master actually holds. Zero hides the opt-in entirely. */
const masterKeys = computed(() => {
  void codeplug.revision
  return codeplug.doc?.encryptionKeys.filter((k) => k.keyHex !== '').length ?? 0
})

// ------------------------------------------------------------------ roster --

const pasted = ref('')
const pasting = ref(false)

function importPasted() {
  const { units, problems } = parseFleetRoster(pasted.value)
  if (units.length === 0) {
    toast.add({
      title: 'No radios in that',
      description:
        'Expected a row per radio, with a name, a DMR ID and a callsign. A header row is read if there is one.',
      icon: 'i-lucide-circle-alert',
      color: 'error',
      duration: 0,
    })
    return
  }
  fleet.setRoster(units)
  pasted.value = ''
  pasting.value = false
  toast.add({
    title: `${units.length} radio${units.length === 1 ? '' : 's'} in the roster`,
    description:
      problems.length === 0
        ? 'Check the DMR IDs against your own list before starting.'
        : `${problems.length} row(s) were left out: ${problems.map((p) => `line ${p.line}, ${p.message}`).join(' ')}`,
    icon: problems.length === 0 ? 'i-lucide-circle-check' : 'i-lucide-triangle-alert',
    color: problems.length === 0 ? 'success' : 'warning',
    duration: problems.length === 0 ? 8000 : 0,
  })
}

async function saveRoster() {
  await saveFile(exportFleetRoster(fleet.roster), 'fleet-roster.csv', 'text/csv')
}

async function saveRecord() {
  const stamp = new Date().toISOString().slice(0, 10)
  await saveFile(exportFleetRecord(fleet.roster, fleet.outcomes), `fleet-record-${stamp}.csv`, 'text/csv')
}

/** Editing a row's DMR ID, kept as a number or null rather than an empty string. */
function setDmrId(unit: FleetUnit, raw: string) {
  const text = raw.trim()
  fleet.updateRow(unit.id, { dmrId: text === '' ? null : Number(text) })
}

// --------------------------------------------------------------------- run --

/** True while a read or a write is in flight, so nothing can be started twice. */
const busy = ref(false)

/**
 * The backup on file for the radio in front of the user.
 *
 * Looked up after each read rather than watched, because the answer only
 * changes when a radio is read - and the read is what stores it. Held apart
 * from "not looked yet" for the same reason the write page holds them apart:
 * telling somebody there is no way back when there is teaches them to ignore
 * the message when it is true.
 */
const backup = ref<{ identHash: string; createdAt?: string } | null>(null)

const sent = ref<{ label: string; blocks: number } | null>(null)

async function programme(unit: FleetUnit) {
  if (busy.value) return
  busy.value = true
  backup.value = null
  sent.value = null
  try {
    const ok = await run.readUnit(unit)
    if (ok) backup.value = await session.latestBackupForOpenCodeplug()
  } finally {
    busy.value = false
  }
}

/**
 * The typed confirmation, held so a failed attempt can clear it.
 *
 * The write page gets this for nothing - it swaps to a different view and back,
 * which remounts the field. This card stays on screen through a failure, so
 * without clearing it the word from the attempt that failed is still in the box
 * and the button is armed again with nothing asked of the person. The friction
 * is the point; it has to be paid per attempt.
 */
const confirm = useTemplateRef<{ reset: () => void }>('confirm')

async function send() {
  if (busy.value) return
  const unit = fleet.current
  if (!unit) return
  busy.value = true
  const blocks = run.pendingBlocks()
  try {
    if (await run.writeCurrent()) sent.value = { label: unit.label, blocks }
  } finally {
    busy.value = false
    confirm.value?.reset()
  }
}

function skip() {
  run.skipCurrent('Set aside during the run.')
  backup.value = null
}

/**
 * Ending the run throws away the record of which radios were done.
 *
 * That is the one thing a fleet session produces that is not on a radio and
 * not in a backup, so once anything has been written this asks for the word -
 * with the CSV of the record offered beside it, which is what somebody
 * actually wants when they reach for this button.
 */
const ending = ref(false)
function finish() {
  fleet.endRun()
  ending.value = false
  sent.value = null
  backup.value = null
}

// ------------------------------------------------------- the pending write --

/**
 * What this write does to the radio's channels.
 *
 * Against the image that was just read off *this* handset, not against the
 * master. Every radio in the run gets a different diff, and that is the point:
 * the second-hand one with somebody else's channels on it is a hundred rows,
 * and the one programmed last week is three.
 */
const diff = computed(() => {
  void codeplug.revision
  const driver = codeplug.driverRef
  const image = codeplug.image
  const after = codeplug.doc
  if (!driver || !image || !after) return null
  return diffChannels(driver.decode(image), after)
})

const blocks = computed(() => {
  void codeplug.revision
  return run.pendingBlocks()
})
const bytes = computed(() => blocks.value * (codeplug.driverRef?.writeBlockBytes ?? 0))

const gate = computed(() => {
  const schema = codeplug.schema
  if (!schema) return null
  const pending = codeplug.pendingWrite
  return evaluateWriteGate({
    schema,
    ident: device.ident,
    imageVariant: codeplug.image?.variant ?? null,
    imageRadioId: codeplug.image?.radioId ?? null,
    backup: backup.value,
    diagnostics: codeplug.diagnostics,
    encodeError: codeplug.encodeError,
    changedBytes: pending?.changedBytes ?? 0,
    unownedRanges: pending?.unowned ?? [],
    documentDirty: codeplug.dirty,
    transport: device.lastKind,
  })
})

const blockers = computed(() => gate.value?.blockers ?? [])
const ready = computed(() => gate.value?.allowed === true && !busy.value)

/** One row per rule, so nine receive-only channels are not nine sentences. */
const warnings = computed(() => {
  const byRule = new Map<string, { code: string; message: string; count: number }>()
  for (const w of gate.value?.warnings ?? []) {
    const seen = byRule.get(w.code)
    if (seen) seen.count++
    else byRule.set(w.code, { code: w.code, message: w.message, count: 1 })
  }
  return [...byRule.values()]
})

const STATE_CHIP = {
  written: { label: 'written', icon: 'i-lucide-circle-check', fg: 'var(--ok)', bg: 'var(--okB)' },
  failed: { label: 'failed', icon: 'i-lucide-circle-x', fg: 'var(--dg)', bg: 'var(--dgB)' },
  skipped: { label: 'skipped', icon: 'i-lucide-circle-minus', fg: 'var(--fn)', bg: 'var(--pn3)' },
} as const

const FIELD_LABEL = { dmrId: 'DMR ID', name: 'Radio name' } as const
</script>

<template>
  <div v-if="!codeplug.isOpen" class="mx-auto px-4 py-10" style="max-width: 880px">
    <h1 style="font-size: 21px; font-weight: 600; letter-spacing: -0.02em">There is no codeplug to send</h1>
    <p class="mt-2" style="font-size: 14px; line-height: 1.6; color: var(--mu); max-width: 70ch">
      Fleet programming puts one codeplug on a roster of radios. Read the radio it was built on, or open the
      file somebody sent you, and that becomes the master for the run.
    </p>
    <div class="mt-4">
      <RiskAction risk="safe" icon="i-lucide-radio" label="Go to Connect" size="lg" @click="navigateTo('/')" />
    </div>
  </div>

  <section v-else-if="!fleet.running" class="mx-auto" style="max-width: 940px; padding: 24px 16px 48px">
    <!-- Stage one: the roster. Nothing here has touched a radio. -->
    <div class="flex items-center flex-wrap" style="gap: 9px; margin-bottom: 5px">
      <UIcon name="i-lucide-users" style="width: 16px; height: 16px; color: var(--ac)" />
      <h1 style="font-size: 21px; font-weight: 600; letter-spacing: -0.02em">Programme a fleet</h1>
      <span style="font-size: 13.5px; color: var(--fn)">nothing sent yet</span>
    </div>
    <p style="margin-bottom: 16px; font-size: 14px; color: var(--mu); max-width: 78ch">
      One codeplug onto a roster of radios, varying only what belongs to each handset. Each radio is read
      before it is written, which is what stores its backup, and each write asks for the word on its own diff.
      Nothing here writes to more than one radio at a time.
    </p>

    <!-- What every radio gets. -->
    <div class="card" style="margin-bottom: 9px">
      <div style="padding: 16px 18px">
        <div class="flex items-baseline flex-wrap" style="gap: 9px; margin-bottom: 6px">
          <span style="font-size: 15px; font-weight: 600">What every radio gets</span>
          <span class="chip" style="background: var(--pn3); color: var(--fn)">{{ model }}</span>
        </div>
        <p class="meta">
          {{ codeplug.doc?.meta.title || 'Untitled' }}
          <template v-if="codeplug.image?.variant"> · {{ codeplug.image.variant }}</template>
          <br>
          {{ codeplug.channelCount }} channel{{ codeplug.channelCount === 1 ? '' : 's' }} ·
          {{ codeplug.zones.length }} zone{{ codeplug.zones.length === 1 ? '' : 's' }} ·
          {{ codeplug.talkGroups.length }} talk group{{ codeplug.talkGroups.length === 1 ? '' : 's' }}
        </p>
        <p class="note">
          The radio's own DMR IDs never travel with it. Each handset keeps the ones it has, and the roster
          below decides what goes in the first slot, which is the one a channel falls back to.
        </p>
      </div>

      <label
        v-if="masterKeys > 0"
        class="flex items-start gap-2.5"
        style="border-top: 1px solid var(--ln); padding: 13px 18px; cursor: pointer"
      >
        <input v-model="fleet.copyKeys" type="checkbox" style="margin-top: 3px" >
        <span>
          <span style="font-size: 14px; font-weight: 600; color: var(--tx)">
            Send the {{ masterKeys }} key slot{{ masterKeys === 1 ? '' : 's' }} as well
          </span>
          <span class="note" style="display: block; margin-top: 2px">
            Off unless asked for. A business fleet sharing its keys is what this screen is for. A club
            receiving somebody's keys because they wanted the channel list is not.
          </span>
        </span>
      </label>
    </div>

    <!-- The roster. -->
    <div class="flex items-center flex-wrap" style="gap: 8px; margin-bottom: 7px">
      <h2 class="sec" style="margin: 0">The roster</h2>
      <span v-if="fleet.roster.length" style="font-size: 13px; color: var(--mu)">
        {{ fleet.roster.length }} radio{{ fleet.roster.length === 1 ? '' : 's' }}
      </span>
      <div class="flex items-center flex-wrap ms-auto" style="gap: 6px">
        <RiskAction
          risk="neutral"
          ghost
          size="sm"
          icon="i-lucide-file-up"
          label="Paste a list"
          @click="pasting = !pasting"
        />
        <RiskAction
          v-if="fleet.roster.length"
          risk="neutral"
          ghost
          size="sm"
          icon="i-lucide-file-down"
          label="Save as CSV"
          @click="saveRoster"
        />
        <RiskAction risk="neutral" ghost size="sm" icon="i-lucide-plus" label="Add" @click="fleet.addRow()" />
      </div>
    </div>

    <div v-if="pasting" class="card" style="margin-bottom: 9px; padding: 15px 17px">
      <p class="note" style="margin-top: 0; margin-bottom: 8px">
        A row per radio. Any order of columns, with a header row naming them, or name, DMR ID and callsign
        in that order without one.
      </p>
      <textarea
        v-model="pasted"
        rows="6"
        spellcheck="false"
        placeholder="label,dmrId,name&#10;Dave's HT,2345678,M0DAV&#10;Sam's HT,2345679,M0SAM"
        class="w-full rounded-[6px] px-2.5 py-2 outline-none font-mono"
        style="background: var(--pn2); border: 1px solid var(--ln2); color: var(--tx); font-size: 13px"
      />
      <div class="flex items-center gap-2 flex-wrap" style="margin-top: 9px">
        <RiskAction
          risk="safe"
          size="sm"
          icon="i-lucide-check"
          label="Read the list"
          :disabled="pasted.trim() === ''"
          @click="importPasted"
        />
        <RiskAction risk="neutral" ghost size="sm" label="Cancel" @click="pasting = false" />
        <span class="note" style="margin: 0">This replaces the roster below.</span>
      </div>
    </div>

    <div class="card">
      <p v-if="fleet.roster.length === 0" class="empty">
        No radios yet. Paste your club's list, or add rows one at a time.
      </p>
      <div
        v-for="(unit, i) in fleet.roster"
        v-else
        :key="unit.id"
        class="flex items-end flex-wrap"
        :style="`gap: 11px; padding: 12px 16px; ${i ? 'border-top: 1px solid var(--ln);' : ''}`"
      >
        <span class="idx" style="padding-bottom: 8px">{{ i + 1 }}</span>

        <label class="grid gap-1" style="min-width: 150px; flex: 1 1 150px">
          <span class="label-xs">Radio</span>
          <input
            :value="unit.label"
            type="text"
            autocomplete="off"
            spellcheck="false"
            class="rounded-[6px] px-2.5 outline-none"
            style="height: 31px; background: var(--pn); border: 1px solid var(--ln2); color: var(--tx); font-size: 14px"
            @change="fleet.updateRow(unit.id, { label: ($event.target as HTMLInputElement).value })"
          >
        </label>

        <template v-if="varies && idFeature !== false">
          <label class="grid gap-1" style="min-width: 130px">
            <span class="label-xs">DMR ID</span>
            <input
              :value="unit.dmrId ?? ''"
              type="number"
              min="1"
              :max="idFeature.maxId"
              placeholder="leave alone"
              class="rounded-[6px] px-2.5 outline-none font-mono"
              style="height: 31px; background: var(--pn); border: 1px solid var(--ln2); color: var(--tx); font-size: 14px"
              @change="setDmrId(unit, ($event.target as HTMLInputElement).value)"
            >
          </label>

          <label class="grid gap-1" style="min-width: 120px">
            <span class="label-xs">Radio name</span>
            <input
              :value="unit.name"
              type="text"
              :maxlength="idFeature.nameLength"
              autocomplete="off"
              spellcheck="false"
              class="rounded-[6px] px-2.5 outline-none"
              style="height: 31px; background: var(--pn); border: 1px solid var(--ln2); color: var(--tx); font-size: 14px"
              @change="fleet.updateRow(unit.id, { name: ($event.target as HTMLInputElement).value })"
            >
          </label>
        </template>

        <RiskAction
          risk="caution"
          ghost
          size="sm"
          icon="i-lucide-trash-2"
          label="Remove"
          class="ms-auto"
          @click="fleet.removeRow(unit.id)"
        />
      </div>
    </div>

    <p v-if="!varies" class="note">
      The {{ model }} has no DMR identity of its own, so there is nothing per radio to vary. Every handset
      gets the same codeplug, and the run is still worth having for the backup it takes off each one.
    </p>

    <!-- Problems, errors first. -->
    <div v-if="fleet.problems.length" style="display: grid; gap: 7px; margin-top: 11px">
      <div
        v-for="p in [...fleet.errors, ...fleet.warnings]"
        :key="p.ruleId + (p.unit ?? '')"
        class="flex items-start gap-2.5 rounded-[6px]"
        :style="{
          padding: '12px 15px',
          border: `1px solid ${p.severity === 'error' ? 'var(--dgL)' : 'var(--cnL)'}`,
          background: p.severity === 'error' ? 'var(--dgB)' : 'var(--cnB)',
        }"
      >
        <UIcon
          :name="p.severity === 'error' ? 'i-lucide-shield-alert' : 'i-lucide-triangle-alert'"
          class="size-3.5 shrink-0"
          :style="{ color: p.severity === 'error' ? 'var(--dg)' : 'var(--cn)', marginTop: '2px' }"
        />
        <p style="font-size: 14px; line-height: 1.55; color: var(--tx); max-width: 76ch">{{ p.message }}</p>
      </div>
    </div>

    <div class="flex items-center gap-2 flex-wrap" style="margin-top: 15px">
      <RiskAction
        risk="safe"
        size="lg"
        icon="i-lucide-play"
        :label="`Start the run · ${fleet.roster.length} radio${fleet.roster.length === 1 ? '' : 's'}`"
        :disabled="fleet.errors.length > 0 || fleet.roster.length === 0"
        @click="run.startRun()"
      />
      <span class="note" style="margin: 0">
        Starting sends nothing. It locks the roster so an ID cannot change once radios have been done.
      </span>
    </div>
  </section>

  <section v-else class="mx-auto" style="max-width: 940px; padding: 24px 16px 48px">
    <!-- Stage two: the run. One radio at a time, each one an ordinary write. -->
    <div class="flex items-center flex-wrap" style="gap: 9px; margin-bottom: 5px">
      <UIcon name="i-lucide-users" style="width: 16px; height: 16px; color: var(--ac)" />
      <h1 style="font-size: 21px; font-weight: 600; letter-spacing: -0.02em">Fleet run</h1>
      <span class="chip" style="background: var(--okB); color: var(--ok)">
        <UIcon name="i-lucide-circle-check" class="size-3" />
        {{ fleet.written.length }} of {{ fleet.roster.length }} written
      </span>
      <span v-if="fleet.skipped.length" class="chip" style="background: var(--pn3); color: var(--fn)">
        {{ fleet.skipped.length }} skipped
      </span>
    </div>
    <p style="margin-bottom: 16px; font-size: 14px; color: var(--mu); max-width: 78ch">
      {{ fleet.masterFacts?.title }} onto {{ fleet.roster.length }} {{ model }}s.
      {{ device.keepLinkUp }} while a radio is being read or written.
    </p>

    <!-- In flight. Nothing to click, by construction. -->
    <div
      v-if="transfer.active"
      class="rounded-[8px]"
      style="border: 1px solid var(--cnL); background: var(--pn); padding: 18px; margin-bottom: 12px"
    >
      <div class="flex items-center gap-2" style="margin-bottom: 6px">
        <UIcon name="i-lucide-triangle-alert" class="size-3.5" style="color: var(--cn)" />
        <span class="label-xs" style="color: var(--cn); letter-spacing: 0.08em">Do not unplug</span>
      </div>
      <h2 style="margin-bottom: 12px; font-size: 17px; font-weight: 600">
        {{ transfer.label }}<template v-if="fleet.current"> · {{ fleet.current.label }}</template>
      </h2>
      <div style="height: 4px; border-radius: 2px; background: var(--pn3); overflow: hidden; margin-bottom: 8px">
        <div
          :style="{
            height: '100%',
            width: `${transfer.percent}%`,
            background: 'var(--cn)',
            transition: 'width .18s linear',
          }"
        />
      </div>
      <p style="font-size: 13px; color: var(--mu)">
        {{ transfer.phase ?? 'getting ready' }}
      </p>
    </div>

    <!-- The radio on the cable, once it has been read. -->
    <div
      v-else-if="fleet.current && fleet.plan"
      class="card"
      style="border-color: var(--cnL); margin-bottom: 12px"
    >
      <div style="padding: 17px 19px">
        <div class="flex items-baseline flex-wrap" style="gap: 9px">
          <span style="font-size: 15px; font-weight: 600">{{ fleet.current.label }}</span>
          <span class="chip" style="background: var(--okB); color: var(--ok)">
            <UIcon name="i-lucide-circle-check" class="size-3" />
            read · backup saved
          </span>
          <span v-if="blocks > 0" class="chip" style="background: var(--cnB); color: var(--cn)">
            {{ blocks }} block{{ blocks === 1 ? '' : 's' }} · {{ bytes.toLocaleString() }} bytes
          </span>
        </div>
        <p style="margin-top: 5px; font-size: 14px; line-height: 1.55; color: var(--mu); max-width: 74ch">
          This is the radio in front of you as it stands now, against what the roster says it should hold.
          Read the identity below before the channel list: it is the only thing on this page that says
          whether you plugged in the right handset.
        </p>
      </div>

      <!-- Identity. The reason this screen exists. -->
      <div v-if="varies" style="border-top: 1px solid var(--ln); padding: 15px 19px; background: var(--pn2)">
        <div v-if="fleet.plan.overrides.length" style="display: grid; gap: 6px">
          <div
            v-for="o in fleet.plan.overrides"
            :key="o.field"
            class="flex items-center flex-wrap"
            style="gap: 8px; font-size: 14px"
          >
            <span class="label-xs" style="width: 90px">{{ FIELD_LABEL[o.field] }}</span>
            <span class="font-mono tabular" style="color: var(--mu)">{{ o.from }}</span>
            <UIcon name="i-lucide-arrow-right" class="size-3.5" style="color: var(--fn)" />
            <span class="font-mono tabular" style="color: var(--tx); font-weight: 600">{{ o.to }}</span>
          </div>
        </div>
        <p v-else style="font-size: 14px; color: var(--mu)">
          This radio already holds the identity the roster gives it. Nothing about it changes.
        </p>

        <p v-if="fleet.plan.carriedRadioIds.length" class="note">
          It also holds
          {{ fleet.plan.carriedRadioIds.length }} other DMR
          ID{{ fleet.plan.carriedRadioIds.length === 1 ? '' : 's' }}
          ({{ fleet.plan.carriedRadioIds.map((r) => r.dmrId).join(', ') }}), left exactly as they are. A
          channel that names one of those slots will transmit as it.
        </p>
      </div>

      <!-- What changes, in channels. -->
      <div v-if="diff && diff.changed > 0" style="border-top: 1px solid var(--ln)">
        <div style="max-height: 300px; overflow-y: auto; padding: 15px 17px">
          <DiffList :diff="diff" :blocks="blocks" :bytes="bytes" />
        </div>
      </div>
      <div
        v-else-if="blocks > 0"
        style="border-top: 1px solid var(--ln); padding: 15px 17px; background: var(--pn2)"
      >
        <p style="font-size: 13px; line-height: 1.6; color: var(--fn); max-width: 74ch">
          Nothing in the channel list changes. The
          <span class="font-mono tabular">{{ bytes.toLocaleString() }} bytes</span> about to be sent are
          elsewhere in the codeplug: a zone or talk group name, an RX group, the radio ID, or a key slot.
        </p>
      </div>

      <!-- Warnings, then blockers, then the word. -->
      <div v-if="warnings.length" style="border-top: 1px solid var(--ln); padding: 13px 19px">
        <p
          v-for="w in warnings"
          :key="w.code"
          style="font-size: 13.5px; line-height: 1.55; color: var(--mu); max-width: 76ch"
        >
          <UIcon name="i-lucide-triangle-alert" class="size-3" style="color: var(--cn)" />
          {{ w.message }}
          <span v-if="w.count > 1" style="color: var(--fn)"> · {{ w.count }} channels</span>
        </p>
      </div>

      <div v-if="blockers.length" style="border-top: 1px solid var(--ln); padding: 17px 19px">
        <div
          class="flex items-start gap-2.5 rounded-[6px]"
          style="padding: 15px 17px; border: 1px solid var(--dgL); background: var(--dgB)"
        >
          <UIcon name="i-lucide-shield-alert" class="size-3.5 shrink-0" style="color: var(--dg); margin-top: 2px" />
          <div class="min-w-0" style="display: grid; gap: 6px">
            <p
              v-for="b in blockers"
              :key="b.code"
              style="font-size: 14px; line-height: 1.55; color: var(--tx); max-width: 74ch"
            >
              {{ b.message }}
              <span v-if="b.remedy" style="color: var(--mu)">{{ b.remedy }}</span>
            </p>
          </div>
        </div>
        <div class="mt-3 flex items-center gap-2 flex-wrap">
          <RiskAction risk="neutral" ghost icon="i-lucide-circle-minus" label="Skip this radio" @click="skip" />
          <RiskAction
            risk="neutral"
            ghost
            icon="i-lucide-refresh-cw"
            label="Read it again"
            :disabled="busy"
            @click="programme(fleet.current)"
          />
        </div>
      </div>

      <div v-else style="border-top: 1px solid var(--ln); padding: 17px 19px">
        <ConfirmTyped
          ref="confirm"
          token="WRITE"
          :label="`Send ${blocks} block${blocks === 1 ? '' : 's'} to ${fleet.current.label}`"
          risk="caution"
          icon="i-lucide-upload"
          :disabled="!ready"
          :loading="busy"
          @confirm="send"
        >
          <template #secondary>
            <RiskAction risk="neutral" ghost label="Skip this radio" :disabled="busy" @click="skip" />
            <RiskAction
              risk="neutral"
              ghost
              icon="i-lucide-refresh-cw"
              label="Read it again"
              :disabled="busy"
              @click="programme(fleet.current)"
            />
          </template>
        </ConfirmTyped>
      </div>
    </div>

    <!-- What just happened, so the next radio can be picked up. -->
    <div
      v-else-if="sent"
      class="flex items-start gap-2.5 rounded-[7px]"
      style="padding: 13px 16px; margin-bottom: 12px; border: 1px solid var(--okL); background: var(--okB)"
    >
      <UIcon name="i-lucide-circle-check" class="size-3.5 shrink-0" style="color: var(--ok); margin-top: 2px" />
      <p style="font-size: 14px; line-height: 1.55; color: var(--tx); max-width: 76ch">
        {{ sent.label }} took {{ sent.blocks }} block{{ sent.blocks === 1 ? '' : 's' }}, every one read back
        and matched. Unplug it and pick the next radio below.
      </p>
    </div>

    <!-- The roster, as a queue. -->
    <div class="card">
      <div
        v-for="(unit, i) in fleet.roster"
        :key="unit.id"
        class="flex items-center flex-wrap"
        :style="`gap: 10px; padding: 12px 16px; ${i ? 'border-top: 1px solid var(--ln);' : ''}` +
          (fleet.currentId === unit.id ? 'background: var(--pn2);' : '')"
      >
        <span class="idx">{{ i + 1 }}</span>

        <span style="font-size: 14px; font-weight: 600; min-width: 120px">{{ unit.label || '(unnamed)' }}</span>

        <span v-if="varies" class="meta" style="min-width: 170px">
          <template v-if="unit.dmrId !== null">{{ unit.dmrId }}</template>
          <template v-else>ID left alone</template>
          <template v-if="unit.name"> · {{ unit.name }}</template>
        </span>

        <span
          v-if="fleet.outcomes[unit.id]"
          class="chip"
          :style="{
            background: STATE_CHIP[fleet.outcomes[unit.id]!.state].bg,
            color: STATE_CHIP[fleet.outcomes[unit.id]!.state].fg,
          }"
        >
          <UIcon :name="STATE_CHIP[fleet.outcomes[unit.id]!.state].icon" class="size-3" />
          {{ STATE_CHIP[fleet.outcomes[unit.id]!.state].label }}
        </span>
        <span v-else-if="fleet.currentId === unit.id" class="chip" style="background: var(--cnB); color: var(--cn)">
          <UIcon name="i-lucide-usb" class="size-3" />
          on the cable
        </span>

        <span v-if="fleet.outcomes[unit.id]" class="note" style="margin: 0; flex: 1 1 200px">
          {{ fleet.outcomes[unit.id]!.note }}
        </span>

        <div class="flex items-center gap-2 ms-auto">
          <RiskAction
            v-if="!fleet.outcomes[unit.id] && fleet.currentId !== unit.id"
            risk="safe"
            size="sm"
            icon="i-lucide-usb"
            label="Read this radio"
            :disabled="busy || fleet.currentId !== null || transfer.active"
            @click="programme(unit)"
          />
          <RiskAction
            v-if="fleet.outcomes[unit.id]"
            risk="neutral"
            ghost
            size="sm"
            icon="i-lucide-refresh-cw"
            label="Do again"
            :disabled="busy || fleet.currentId !== null"
            @click="fleet.reopen(unit.id)"
          />
        </div>
      </div>
    </div>

    <p v-if="fleet.pending.length === 0" class="note">
      Every radio on the roster has been dealt with. Save the record before you end the run: it is the only
      copy of which handset took which identity.
    </p>
    <p v-else-if="fleet.currentId === null" class="note">
      Plug in the next radio, switch it on, then press Read next to its row. The read is what stores the
      backup this write cannot happen without.
    </p>

    <div class="flex items-center gap-2 flex-wrap" style="margin-top: 15px">
      <RiskAction
        risk="neutral"
        icon="i-lucide-file-down"
        label="Save the record as CSV"
        @click="saveRecord"
      />
      <RiskAction
        v-if="fleet.written.length === 0"
        risk="neutral"
        ghost
        icon="i-lucide-x"
        label="End the run"
        :disabled="busy || transfer.active"
        @click="finish"
      />
      <RiskAction
        v-else-if="!ending"
        risk="destructive"
        ghost
        icon="i-lucide-x"
        label="End the run"
        :disabled="busy || transfer.active"
        @click="ending = true"
      />
    </div>

    <div
      v-if="ending"
      class="rounded-[7px]"
      style="margin-top: 11px; padding: 15px 17px; border: 1px solid var(--dgL); background: var(--dgB)"
    >
      <p style="font-size: 14px; line-height: 1.55; color: var(--tx); max-width: 76ch; margin-bottom: 10px">
        Ending the run throws away the record of which {{ fleet.written.length }} radio{{
          fleet.written.length === 1 ? '' : 's'
        }} were written and which physical handset took each row. The radios keep what they were given and
        every backup stays under Backups, but this list is not stored anywhere and cannot be rebuilt.
      </p>
      <ConfirmTyped token="END" label="End the run" risk="destructive" icon="i-lucide-x" @confirm="finish">
        <template #secondary>
          <RiskAction risk="neutral" ghost label="Keep going" @click="ending = false" />
        </template>
      </ConfirmTyped>
    </div>

    <p v-if="fleet.sawRead" class="note">
      The editor now holds the codeplug of the last radio read, not the master. The master is kept by this
      run and is what every remaining radio gets.
    </p>
  </section>
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
  max-width: 76ch;
}
</style>

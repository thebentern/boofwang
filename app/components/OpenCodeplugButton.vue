<script setup lang="ts">
import { openImageFile, type OpenedImage } from '#core/io/open-image.js'
import {
  firstFreeSlot as placeFirstFreeSlot,
  planPlacement,
  programmedOnly,
} from '#core/radio/place.js'
import { createDriver } from '#core/radio/registry.js'
import { transplantCodeplug, type TransplantResult } from '#core/radio/transplant.js'
import {
  acceptTranslation,
  translateChannels,
  ALL_CLAMP_RULES,
  CLAMP_RULE_LABELS,
  type ClampRule,
} from '#core/radio/translate.js'
import type { RadioId } from '#core/model/index.js'
import type { Codeplug } from '#core/model/codeplug.js'
import type { RadioDriver } from '#core/radio/driver.js'
import type { RadioImage } from '#core/radio/image.js'
import type { RadioSchema } from '#core/radio/schema.js'

/**
 * `toolbar` for the form that sits beside Print and Export on the channel
 * table, which is the only place this button can be reached with a codeplug
 * already open - and a codeplug already open is the whole precondition for
 * applying somebody else's to it.
 */
const { toolbar = false } = defineProps<{ toolbar?: boolean }>()

const codeplug = useCodeplugStore()
const toast = useToast()
const input = useTemplateRef<HTMLInputElement>('input')

/**
 * A file that could be a replacement or a donor, held until the user says which.
 *
 * `shallowRef` because it carries an image: hundreds of kilobytes of typed
 * array must never become a reactive proxy.
 */
const donor = shallowRef<{ opened: OpenedImage; doc: Codeplug; driver: RadioDriver } | null>(null)

const copyRadioIds = ref(false)
const copyKeys = ref(false)

/**
 * A file from a *different* model, held while its channels are reviewed.
 *
 * Same-model is a transplant: the whole document moves. Across models nothing
 * can move wholesale, because most of what a channel carries has to be checked
 * against what the target can actually represent - so this is a copy of the
 * channels, one row at a time, with every adjustment shown before any of it
 * lands.
 */
const foreign = shallowRef<{ doc: Codeplug; from: RadioId; schema: RadioSchema } | null>(null)
/** Rules the user has not unticked. Refusing one drops the rows that needed it. */
const acceptedRules = ref(new Set<ClampRule>(ALL_CLAMP_RULES))

/**
 * Could this file be applied to the radio already open, rather than replacing it?
 *
 * Only for the same model - translating between models is a different problem
 * and does not exist yet. The fingerprint decides whether it is worth asking:
 * a file from the same physical unit has nothing to transplant, since applying
 * it and opening it come to the same thing. A driver with nothing per-unit to
 * hash returns null, and that means "cannot tell", never "matches" - so the
 * question gets asked, which is the side that loses nothing.
 */
async function couldBeDonor(image: RadioImage, driver: RadioDriver): Promise<boolean> {
  const mine = codeplug.image
  if (!mine || !codeplug.doc || !codeplug.schema) return false
  if (image.radioId !== mine.radioId) return false
  const [theirs, ours] = await Promise.all([driver.unitFingerprint(image), driver.unitFingerprint(mine)])
  return !(theirs !== null && ours !== null && theirs === ours)
}

/** The merge as it stands, or null when it cannot be built. */
function build(radioIds: boolean, keys: boolean): TransplantResult | null {
  const d = donor.value
  if (!d || !codeplug.doc || !codeplug.schema) return null
  try {
    return transplantCodeplug({
      donor: d.doc,
      recipient: codeplug.doc,
      schema: codeplug.schema,
      now: new Date().toISOString(),
      copyRadioIds: radioIds,
      copyEncryptionKeys: keys,
    })
  } catch {
    // Refused - a donor from another model. The dialog is not offered in that
    // case, so there is nothing to show and nothing to say here.
    return null
  }
}

/**
 * The preview is the same call the button makes, not a description of it.
 *
 * A hand-written list of what a merge does is a second implementation of the
 * merge, and the two drift. Running it is cheap - the lists are copied, the
 * radio is not touched - and it means the counts in front of the user are the
 * counts they get.
 */
const preview = computed(() => build(copyRadioIds.value, copyKeys.value))

/**
 * Why this merge could not be written, asked before it is applied rather than after.
 *
 * The merge itself always succeeds - it is list assignment - but the encoder
 * that has to render it onto your image can refuse, and a codeplug carrying an
 * address book bigger than your radio's read brought back is the ordinary way
 * that happens. Applying anyway used to leave the write page blocking on
 * `encode-failed` with the whole clone in the document and no undo, which is
 * the worst place to find out. So the same call the write page makes runs here
 * first, and the dialog refuses with the encoder's own words. Nothing else can
 * tell: capacity is a property of the image, and only the driver knows it.
 */
const cannotWrite = computed<string | null>(() => {
  const result = preview.value
  const base = codeplug.image
  const d = donor.value?.driver
  if (!result || !base || !d) return null
  try {
    d.encode(result.codeplug, base)
    return null
  } catch (e) {
    return e instanceof Error ? e.message : String(e)
  }
})

/**
 * What copying this file's channels onto the open radio would do.
 *
 * The same call the button makes, not a description of it: a hand-written
 * summary of a clamp pipeline is a second implementation of the pipeline, and
 * the two drift.
 */
const crossModel = computed(() => {
  const f = foreign.value
  if (!f || !codeplug.schema) return null
  return translateChannels({
    // The donor's own pseudo-channels are not channels. A UV-K5 keeps fourteen
    // band presets in the same map as real memories, and letting them through
    // copies duplicate A/B pairs for the in-band ones while the rest are
    // refused - which reads like the clamp pipeline working rather than junk.
    channels: programmedOnly(f.schema, [...f.doc.channels.values()]).sort((a, b) => a.index - b.index),
    target: codeplug.schema,
    // What this radio can do on the firmware it is running, not what its schema
    // declares. Without it the clamp refuses channels the editor would save.
    ...(codeplug.rf ? { rf: codeplug.rf } : {}),
    carries: {
      talkGroups: f.doc.talkGroups.length,
      contacts: f.doc.contacts.length,
      radioIds: f.doc.radioIds.length,
    },
  })
})

/** The rows that would actually land, given what is still ticked. */
const crossModelTaken = computed(() =>
  crossModel.value ? acceptTranslation(crossModel.value, { rules: acceptedRules.value }) : [],
)

/** One line per rule, with a real example rather than a description of one. */
const ruleSummary = computed(() => {
  const changes = crossModel.value?.changes ?? []
  return ALL_CLAMP_RULES.filter((rule) => changes.some((c) => c.rule === rule)).map((rule) => {
    const hits = changes.filter((c) => c.rule === rule)
    const first = hits[0]!
    return {
      rule,
      label: CLAMP_RULE_LABELS[rule],
      count: hits.length,
      why: first.why,
      sample: `slot ${first.index}: ${first.before} → ${first.after}`,
    }
  })
})

function toggleRule(rule: ClampRule) {
  const next = new Set(acceptedRules.value)
  if (next.has(rule)) next.delete(rule)
  else next.add(rule)
  acceptedRules.value = next
}

/**
 * Where they go: after everything already programmed, never over it.
 *
 * The arithmetic lives in `lib/radio/place.ts` because the version that lived
 * here counted the radio's own reserved slots as programmed, which put the
 * first free slot past the end of a UV-K5's memory and placed nothing at all.
 */
const firstFreeSlot = computed(() => {
  if (!codeplug.schema) return null
  return placeFirstFreeSlot(codeplug.schema, codeplug.doc ? codeplug.doc.channels.keys() : [])
})

/**
 * The same merge with both opt-ins off.
 *
 * The reasons for holding something back come from the merge itself, so the
 * dialog cannot explain a rule the code does not follow. Taken with the boxes
 * unticked because ticking one removes its entry, and a checkbox whose
 * explanation vanishes the moment it is ticked cannot be untangled.
 */
const defaults = computed(() => build(false, false))
const skipped = (feature: string) => defaults.value?.skipped.find((s) => s.feature === feature) ?? null
const donorRadioIds = computed(() => skipped('radioIds'))
const donorKeys = computed(() => skipped('encryptionKeys'))
const alsoKept = computed(
  () =>
    defaults.value?.skipped.filter((s) => s.feature !== 'radioIds' && s.feature !== 'encryptionKeys') ?? [],
)

const model = computed(() => codeplug.schema?.model ?? 'radio')

async function onPick(event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0]
  if (!file) return
  const bytes = new Uint8Array(await file.arrayBuffer())

  try {
    const opened = await openImageFile(bytes)
    const driver = createDriver(opened.image.radioId)

    if (await couldBeDonor(opened.image, driver)) {
      copyRadioIds.value = false
      copyKeys.value = false
      donor.value = { opened, doc: driver.decode(opened.image), driver }
      return
    }

    // A different model, with something already open. Its image cannot be
    // written here and its document cannot be transplanted, but its channels
    // can be copied one at a time - which is the only part of it that means
    // anything on another radio.
    if (codeplug.isOpen && codeplug.schema && opened.image.radioId !== codeplug.image?.radioId) {
      acceptedRules.value = new Set(ALL_CLAMP_RULES)
      // The donor's own schema, so its reserved slots can be told from its
      // channels. Taken from the driver rather than looked up, since a driver
      // may report a schema its variant narrowed.
      foreign.value = { doc: driver.decode(opened.image), from: opened.image.radioId, schema: driver.schema }
      return
    }

    await openInstead(opened, driver)
  } catch (e) {
    toast.add({
      title: 'Could not open that file',
      description: e instanceof Error ? e.message : String(e),
      icon: 'i-lucide-circle-alert',
      color: 'error',
      duration: 0,
    })
  } finally {
    if (input.value) input.value.value = ''
  }
}

/** Open the file as the codeplug being edited, replacing whatever was open. */
async function openInstead({ image, note }: OpenedImage, driver: RadioDriver) {
  donor.value = null
  codeplug.load(image, driver)

  if (note.kind === 'bwp') {
    toast.add({
      title: 'Codeplug opened',
      description: `${codeplug.channelCount} channel(s) from ${image.variant || image.radioId}.`,
      icon: 'i-lucide-circle-check',
      color: 'success',
    })
  } else if (note.kind === 'chirp-img') {
    const named = [note.metadata.vendor, note.metadata.model].filter(Boolean).join(' ')
    toast.add({
      title: 'CHIRP image opened',
      description:
        `${codeplug.channelCount} channel(s)` +
        (named ? ` from a ${named}` : '') +
        (note.metadata.chirp_version ? `, saved by CHIRP ${note.metadata.chirp_version}.` : '.'),
      icon: 'i-lucide-circle-check',
      color: 'success',
    })
  } else {
    // A bare dump says nothing about itself beyond its shape, so the guess is
    // stated rather than hidden.
    toast.add({
      title: 'Raw image opened',
      description:
        note.guessedFrom === 'page-ids'
          ? `Read as a ${image.radioId} image from the block ids its pages carry. ` +
            'Check the channels look right before writing it anywhere.'
          : `Assumed to be a ${image.radioId} image from its size. A bare .bin carries no identity. ` +
            'Check the channels look right before writing it anywhere.',
      icon: 'i-lucide-triangle-alert',
      color: 'warning',
      duration: 10_000,
    })
  }
  await navigateTo('/channels')
}

/**
 * Lift the donor's contents onto the open codeplug and hand it to the write flow.
 *
 * Nothing is sent here. The merge is an unsaved edit like any other, so it
 * reaches the radio through the one write path there is - which is what keeps
 * the backup check, the diff and the typed word in front of a change this
 * large.
 */
/**
 * Copy the accepted rows into free slots, as one undoable action.
 *
 * They go after everything already programmed rather than over it: this is a
 * copy, not a clone, and quietly overwriting the channels somebody already had
 * is not something a person asked for by opening a file.
 */
async function copyForeignChannels() {
  const result = crossModel.value
  if (!result || !codeplug.doc) return
  const taken = crossModelTaken.value
  if (taken.length === 0) return

  if (!codeplug.schema) return
  const plan = planPlacement(codeplug.schema, codeplug.doc.channels.keys(), taken)
  const placed = plan.placed.length
  codeplug.transact('copy from another radio', () => {
    for (const p of plan.placed) codeplug.setChannelRecord(p.slot, p.channel)
  })

  const from = foreign.value?.from
  foreign.value = null
  if (input.value) input.value.value = ''

  toast.add({
    title: `Copied ${placed} channel(s) from the ${from}`,
    description:
      (placed < taken.length ? `${taken.length - placed} did not fit and were left out. ` : '') +
      'Nothing has been sent to the radio yet.',
    icon: 'i-lucide-copy',
    color: 'success',
    duration: 12_000,
  })
  await navigateTo('/channels')
}

async function applyToOpen() {
  const result = build(copyRadioIds.value, copyKeys.value)
  if (!result || cannotWrite.value !== null) return

  const moved = result.copied.map((c) => `${c.count} ${c.label}`).join(', ')
  const kept = result.skipped.map((s) => s.label).join(', ')

  codeplug.replaceDocument(result.codeplug)
  donor.value = null
  if (input.value) input.value.value = ''

  toast.add({
    title: 'Applied to the open codeplug',
    description:
      `Copied ${moved}.` +
      (kept ? ` Your own ${kept} were kept.` : '') +
      ' Nothing has been sent to the radio yet.',
    icon: 'i-lucide-layers',
    color: 'success',
    duration: 12_000,
  })
  await navigateTo('/write')
}
</script>

<template>
  <div>
    <input ref="input" type="file" accept=".bwp,.bin,.img,application/octet-stream" class="hidden" @change="onPick" >
    <button
      v-if="toolbar"
      type="button"
      class="inline-flex items-center"
      style="height: 31px; padding: 0 10px; gap: 6px; border: 1px solid var(--ln); background: transparent; color: var(--mu); border-radius: 5px; font-size: 13.5px"
      title="Open a codeplug file: replace the one you have open, or apply another radio's onto it"
      @click="input?.click()"
    >
      <UIcon name="i-lucide-file-up" style="width: 12px; height: 12px; color: var(--fn)" />
      Open
    </button>
    <UButton
      v-else
      icon="i-lucide-file-up"
      label="Open a codeplug file"
      color="neutral"
      variant="subtle"
      @click="input?.click()"
    />

    <!--
      A file from another model. Its image cannot go on this radio and its
      document cannot be transplanted, but its channels can be copied, and the
      whole point is that every adjustment is on screen before any of it lands.
    -->
    <UModal
      :open="foreign !== null"
      :title="`Copy channels from a ${foreign?.from ?? 'radio'} onto your ${model}`"
      :ui="{ content: 'max-w-3xl' }"
      @update:open="(v: boolean) => { if (!v) foreign = null }"
    >
      <template #body>
        <p style="font-size: 14px; line-height: 1.6; color: var(--mu); max-width: 74ch">
          Different radios, so nothing moves wholesale. The channels are checked one at a time against what
          your radio can actually do, and anything that has to change is listed below. They are added after
          the channels you already have, from slot
          <span class="font-mono tabular">{{ firstFreeSlot }}</span>, and nothing you have is overwritten.
        </p>

        <div class="mt-4 flex flex-wrap" style="gap: 6px">
          <span class="chip" style="background: var(--okB); color: var(--ok)">
            <span class="font-mono tabular">{{ crossModelTaken.length }}</span> coming across
          </span>
          <span
            v-if="(crossModel?.refusals.length ?? 0) > 0"
            class="chip"
            style="background: var(--dgB); color: var(--dg)"
          >
            <span class="font-mono tabular">{{ crossModel!.refusals.length }}</span> refused
          </span>
        </div>

        <!-- Refusals first: these are not adjustments, they are rows that cannot go. -->
        <div
          v-if="(crossModel?.refusals.length ?? 0) > 0"
          class="mt-3 rounded-[7px]"
          style="border: 1px solid var(--dg); background: var(--dgB); padding: 11px 13px"
        >
          <div class="label-xs" style="color: var(--dg); letter-spacing: 0.08em; margin-bottom: 6px">
            Cannot come across at all
          </div>
          <p
            v-for="r in crossModel!.refusals.slice(0, 6)"
            :key="`${r.index}-${r.rule}`"
            style="font-size: 13px; line-height: 1.5; color: var(--tx)"
          >
            <span class="font-mono tabular">{{ r.index }}</span> — {{ r.why }}
          </p>
          <p
            v-if="crossModel!.refusals.length > 6"
            style="font-size: 13px; color: var(--fn); margin-top: 4px"
          >
            and {{ crossModel!.refusals.length - 6 }} more.
          </p>
        </div>

        <!-- The adjustments, per rule, each of which can be refused. -->
        <div v-if="(crossModel?.changes.length ?? 0) > 0" class="mt-3 rounded-[7px]" style="border: 1px solid var(--ln)">
          <div
            class="label-xs"
            style="color: var(--fn); letter-spacing: 0.08em; padding: 11px 13px 7px; background: var(--pn2)"
          >
            What would change — untick a rule to refuse it, and the rows that needed it stay behind
          </div>
          <div style="max-height: 300px; overflow-y: auto">
            <div
              v-for="rule in ruleSummary"
              :key="rule.rule"
              style="border-top: 1px solid var(--ln); padding: 10px 13px"
            >
              <label class="flex items-start gap-2.5 cursor-pointer">
                <input
                  type="checkbox"
                  :checked="acceptedRules.has(rule.rule)"
                  style="width: 15px; height: 15px; margin-top: 2px; accent-color: var(--cn)"
                  @change="toggleRule(rule.rule)"
                >
                <span class="min-w-0 flex-1">
                  <span style="font-size: 14px; color: var(--tx)">
                    {{ rule.label }}
                    <span class="font-mono tabular" style="color: var(--fn)">({{ rule.count }})</span>
                  </span>
                  <span style="display: block; font-size: 13px; line-height: 1.5; color: var(--fn)">
                    {{ rule.why }}
                  </span>
                  <span
                    class="font-mono"
                    style="display: block; font-size: 12px; color: var(--mu); margin-top: 3px"
                  >
                    {{ rule.sample }}
                  </span>
                </span>
              </label>
            </div>
          </div>
        </div>

        <div
          v-if="(crossModel?.dropped.length ?? 0) > 0"
          class="mt-3"
          style="font-size: 13px; line-height: 1.6; color: var(--fn); max-width: 74ch"
        >
          Left behind, because your radio has no concept of them:
          {{ crossModel!.dropped.join('; ') }}.
        </div>

        <p class="mt-3" style="font-size: 13px; line-height: 1.6; color: var(--fn); max-width: 74ch">
          Copying sends nothing. It becomes an unsaved edit and goes to the radio through the same write page
          as any other, and it takes back in one step with undo.
        </p>
      </template>

      <template #footer>
        <div class="flex flex-wrap items-center" style="gap: 8px">
          <RiskAction
            risk="caution"
            icon="i-lucide-copy"
            :label="`Copy ${crossModelTaken.length} channel(s) across`"
            :disabled="crossModelTaken.length === 0"
            @click="copyForeignChannels"
          />
          <RiskAction risk="neutral" ghost label="Cancel" @click="foreign = null" />
        </div>
      </template>
    </UModal>

    <!--
      Two verbs for one file, and the difference is worth a dialog.
      "Replace" was the only thing opening a file ever did, which made the club
      codeplug case impossible: the donor's image carries the donor's
      calibration, so it can be looked at but never written to your radio.
    -->
    <UModal
      :open="donor !== null"
      :title="`This is a ${model} codeplug, like the one you have open`"
      :ui="{ content: 'max-w-2xl' }"
      @update:open="(v: boolean) => { if (!v) donor = null }"
    >
      <template #body>
        <p style="font-size: 14px; line-height: 1.6; color: var(--mu); max-width: 70ch">
          It came off a different radio, so its image cannot be written to yours. The calibration in it belongs
          to the unit it was read from. Its <em>contents</em> can: the lists below are lifted onto the codeplug
          you have open, and everything that belongs to your unit stays where it is.
        </p>

        <div class="mt-4 rounded-[7px]" style="border: 1px solid var(--ln); background: var(--pn2)">
          <div style="padding: 13px 15px">
            <div class="label-xs" style="color: var(--fn); letter-spacing: 0.08em; margin-bottom: 8px">
              What comes across
            </div>
            <div class="flex flex-wrap" style="gap: 6px">
              <span
                v-for="c in preview?.copied ?? []"
                :key="c.feature"
                class="chip"
                style="background: var(--cnB); color: var(--cn)"
              >
                <span class="font-mono tabular">{{ c.count.toLocaleString() }}</span>
                {{ c.label }}
              </span>
            </div>
          </div>

          <div style="border-top: 1px solid var(--ln); padding: 13px 15px">
            <div class="label-xs" style="color: var(--fn); letter-spacing: 0.08em; margin-bottom: 8px">
              What stays yours
            </div>

            <div class="grid" style="gap: 10px">
              <!--
                The two opt-ins. Both are off every time this dialog opens: they
                are not preferences, they are decisions about one file, and a
                remembered tick is exactly how someone ends up sharing a DMR ID
                without meaning to.
              -->
              <label v-if="donorRadioIds" class="flex items-start gap-2.5 cursor-pointer">
                <input
                  v-model="copyRadioIds"
                  type="checkbox"
                  style="width: 15px; height: 15px; margin-top: 2px; accent-color: var(--cn)"
                >
                <span class="min-w-0">
                  <span style="font-size: 14px; color: var(--tx)">
                    Copy the {{ donorRadioIds.count }} DMR radio ID(s) from the file as well
                  </span>
                  <span style="display: block; font-size: 13px; line-height: 1.5; color: var(--fn)">
                    {{ donorRadioIds.reason }}
                  </span>
                </span>
              </label>

              <label v-if="donorKeys" class="flex items-start gap-2.5 cursor-pointer">
                <input
                  v-model="copyKeys"
                  type="checkbox"
                  style="width: 15px; height: 15px; margin-top: 2px; accent-color: var(--cn)"
                >
                <span class="min-w-0">
                  <span style="font-size: 14px; color: var(--tx)">
                    Copy the {{ donorKeys.count }} encryption key(s) from the file as well
                  </span>
                  <span style="display: block; font-size: 13px; line-height: 1.5; color: var(--fn)">
                    {{ donorKeys.reason }}
                  </span>
                </span>
              </label>

              <p
                v-for="s in alsoKept"
                :key="s.feature"
                style="font-size: 13px; line-height: 1.5; color: var(--fn); max-width: 74ch"
              >
                {{ s.reason }}
              </p>
            </div>
          </div>
        </div>

        <div
          v-if="cannotWrite"
          class="mt-3 rounded-[7px]"
          style="border: 1px solid var(--dg); background: var(--dgB); padding: 12px 14px"
        >
          <div class="label-xs" style="color: var(--dg); letter-spacing: 0.08em; margin-bottom: 6px">
            This one cannot go onto your radio
          </div>
          <p style="font-size: 13px; line-height: 1.6; color: var(--tx); max-width: 74ch">
            {{ cannotWrite }}
          </p>
        </div>

        <p class="mt-3" style="font-size: 13px; line-height: 1.6; color: var(--fn); max-width: 74ch">
          Applying this sends nothing. It becomes an unsaved edit, and goes to the radio through the same write
          page as any other, with the backup check, the line-by-line diff and the typed confirmation.
          <span style="color: var(--tx)">Undo will not take it back</span>, because it replaces the whole
          codeplug rather than editing part of one. Your radio keeps what it has until you write.
        </p>
      </template>

      <template #footer>
        <div class="flex flex-wrap items-center" style="gap: 8px">
          <RiskAction
            v-if="!cannotWrite"
            risk="caution"
            icon="i-lucide-layers"
            label="Apply to the radio I have open"
            @click="applyToOpen"
          />
          <RiskAction
            v-if="donor"
            risk="neutral"
            ghost
            icon="i-lucide-file-up"
            label="Replace what's open"
            @click="openInstead(donor.opened, donor.driver)"
          />
          <RiskAction risk="neutral" ghost label="Cancel" @click="donor = null" />
        </div>
      </template>
    </UModal>
  </div>
</template>

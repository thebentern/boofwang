<script setup lang="ts">
import { openImageFile, type OpenedImage } from '#core/io/open-image.js'
import { createDriver } from '#core/radio/registry.js'
import { transplantCodeplug, type TransplantResult } from '#core/radio/transplant.js'
import type { Codeplug } from '#core/model/codeplug.js'
import type { RadioDriver } from '#core/radio/driver.js'
import type { RadioImage } from '#core/radio/image.js'

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
async function applyToOpen() {
  const result = build(copyRadioIds.value, copyKeys.value)
  if (!result) return

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
    <UButton
      icon="i-lucide-file-up"
      label="Open a codeplug file"
      color="neutral"
      variant="subtle"
      @click="input?.click()"
    />

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

        <p class="mt-3" style="font-size: 13px; line-height: 1.6; color: var(--fn); max-width: 74ch">
          Applying this sends nothing. It becomes an unsaved edit, and goes to the radio through the same write
          page as any other, with the backup check, the line-by-line diff and the typed confirmation.
        </p>
      </template>

      <template #footer>
        <div class="flex flex-wrap items-center" style="gap: 8px">
          <RiskAction
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

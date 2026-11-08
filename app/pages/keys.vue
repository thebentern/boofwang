<script setup lang="ts">
import { planMonitorExport, planMonitorKeys } from '#core/io/monitor-profile.js'
import { plural } from '#core/text/plural.js'

/**
 * The Keys screen: the notice, then the key slots, then the monitor export.
 *
 * The notice states the rule and cites it, and the operator - who holds the
 * license and is responsible for what they transmit - decides. Making them
 * declare a service first only taught people to click the answer that opened
 * the screen.
 */
useSeoMeta({ title: 'Encryption keys' })

const codeplug = useCodeplugStore()
const session = useRadioSession()

const encryption = computed(() => codeplug.schema?.features.encryption ?? null)

/** A radio with no key slots gets told so, rather than shown an empty editor. */
const noKeySlots = computed(() => codeplug.isOpen && !encryption.value)

/**
 * What the two monitor files would hold, kept current with the document.
 *
 * `doc` is edited in place behind a shallowRef, so this reads `revision` to
 * see an edit at all - the same reason the key list does. Without it a slot
 * cleared on this screen would go on being counted in the sentence above the
 * slide that saves it.
 */
const monitor = computed(() => {
  void codeplug.revision
  const doc = codeplug.doc
  if (!doc) return null
  return { profile: planMonitorExport(doc), keys: planMonitorKeys(doc) }
})

const keyCount = computed(() => monitor.value?.keys.exported.length ?? 0)

const slotList = (slots: readonly number[]) =>
  new Intl.ListFormat('en', { type: 'conjunction' }).format(slots.map(String))

/** Why the keys file holds less than the profile names, said once and here. */
const keysNote = computed(() => {
  const m = monitor.value
  if (!m) return ''
  if (m.profile.keySlots.length === 0) return 'No channel in the profile encrypts, so there are no keys to export.'
  const missing = m.keys.withoutKey
  if (missing.length === 0) return ''
  const n = missing.length
  return (
    `${plural(n, 'Slot', 'Slots')} ${slotList(missing)} ${plural(n, 'is', 'are')} used by a channel in the ` +
    `profile and ${plural(n, 'holds', 'hold')} no key, so the keys file leaves ${plural(n, 'it', 'them')} out.`
  )
})

const confirmingKeys = ref(false)
const savingKeys = ref(false)

/*
 * A read, a restore or a file opened under an open confirmation changes what
 * the slide would save. Close it, the way the key editor closes, so the slide
 * is only ever agreeing to the sentence that was on screen when it opened.
 */
watch(
  () => codeplug.doc,
  () => {
    confirmingKeys.value = false
  },
)

async function exportKeys() {
  savingKeys.value = true
  try {
    await session.downloadMonitorKeys()
  } finally {
    savingKeys.value = false
    confirmingKeys.value = false
  }
}
</script>

<template>
  <div class="mx-auto" style="max-width: 840px; padding: 22px 16px 48px">
    <div
      v-if="noKeySlots"
      style="border: 1px solid var(--ln); background: var(--pn); border-radius: 7px; padding: 22px"
    >
      <div class="flex items-center gap-2.5" style="margin-bottom: 6px">
        <UIcon name="i-lucide-key-round" class="shrink-0" style="width: 15px; height: 15px; color: var(--fn)" />
        <h1 style="font-size: 15.5px; font-weight: 600; color: var(--tx)">
          The {{ codeplug.schema?.vendor }} {{ codeplug.schema?.model }} has no encryption
        </h1>
      </div>
      <p style="font-size: 14px; line-height: 1.6; color: var(--mu); max-width: 74ch">
        This radio has no key slots to program. Of the radios boofwang supports, only the Baofeng DM-32UV
        carries them.
      </p>
    </div>

    <template v-else-if="codeplug.isOpen">
      <div style="margin-bottom: 13px">
        <EncryptionWarning />
      </div>
      <EncryptionKeys />

      <!--
        After the slots because it is about them: which slots the channels use,
        and what to hand a receiver to check that they work. The profile is
        safe to hand anyone. The keys file is the slots themselves, so it costs
        a slide.
      -->
      <section
        v-if="monitor"
        aria-labelledby="monitor-export"
        style="margin-top: 22px; border: 1px solid var(--ln); background: var(--pn); border-radius: 7px; padding: 16px 16px 18px"
      >
        <div class="flex items-center gap-2.5" style="margin-bottom: 6px">
          <UIcon name="i-lucide-radio-tower" class="shrink-0" style="width: 15px; height: 15px; color: var(--fn)" />
          <h2 id="monitor-export" style="font-size: 14.5px; font-weight: 600; color: var(--tx)">
            Monitor export
          </h2>
        </div>
        <p style="font-size: 13.5px; line-height: 1.6; color: var(--mu); max-width: 74ch; margin-bottom: 12px">
          Two files for checking this radio with an SDR receiver. The profile lists the DMR channels with their
          frequency, color code, time slot, talk group and key slot, and never contains a key or the name of a
          slot. The keys file holds the keys those channels use. Both describe the codeplug open here,
          including edits not yet written to the radio.
        </p>

        <ul
          v-if="monitor.profile.warnings.length > 0"
          class="grid"
          style="gap: 6px; margin-bottom: 12px; max-width: 74ch"
        >
          <li
            v-for="w in monitor.profile.warnings"
            :key="w.index"
            class="flex items-start gap-2"
            style="font-size: 13px; line-height: 1.55; color: var(--mu)"
          >
            <UIcon
              name="i-lucide-shield-alert"
              class="shrink-0"
              style="width: 14px; height: 14px; margin-top: 3px; color: var(--cn)"
            />
            <span>{{ w.message }}</span>
          </li>
        </ul>

        <div class="flex flex-wrap items-center gap-2.5">
          <RiskAction
            risk="safe"
            icon="i-lucide-file-down"
            label="Export monitor profile"
            @click="session.downloadMonitorProfile()"
          />
          <RiskAction
            risk="caution"
            icon="i-lucide-key-round"
            label="Export monitor keys"
            :disabled="keyCount === 0"
            @click="confirmingKeys = true"
          />
        </div>
        <p
          v-if="keysNote"
          style="font-size: 13px; line-height: 1.6; color: var(--fn); max-width: 74ch; margin-top: 9px"
        >
          {{ keysNote }}
        </p>

        <div v-if="confirmingKeys && keyCount > 0" style="margin-top: 14px">
          <p style="font-size: 13.5px; line-height: 1.6; color: var(--mu); max-width: 74ch; margin-bottom: 9px">
            This file holds {{ keyCount }} encryption {{ plural(keyCount, 'key') }} in clear, for
            {{ plural(keyCount, 'slot') }} {{ slotList(monitor.keys.exported) }}. Anyone who has it can decrypt
            what those channels send. Handle it like the radio itself.
          </p>
          <ConfirmSlide
            :label="`Slide to save ${keyCount} ${plural(keyCount, 'key')} in clear`"
            risk="caution"
            icon="i-lucide-key-round"
            busy-label="Saving"
            :loading="savingKeys"
            @confirm="exportKeys"
          >
            <template #secondary>
              <RiskAction risk="neutral" ghost label="Cancel" @click="confirmingKeys = false" />
            </template>
          </ConfirmSlide>
        </div>
      </section>
    </template>

    <template v-else>
      <div class="flex items-center gap-2.5 flex-wrap" style="margin-bottom: 11px">
        <UIcon name="i-lucide-key-round" class="shrink-0" style="width: 17px; height: 17px; color: var(--cn)" />
        <h1 style="font-size: 19px; font-weight: 600; letter-spacing: -0.02em; color: var(--tx)">
          Encryption keys
        </h1>
      </div>

      <div style="margin-bottom: 11px">
        <EncryptionWarning variant="bar" />
      </div>

      <div style="border: 1px solid var(--ln); background: var(--pn); border-radius: 7px; padding: 22px">
        <h2 style="font-size: 14.5px; font-weight: 600; color: var(--tx); margin-bottom: 5px">
          No codeplug open
        </h2>
        <p style="font-size: 14px; line-height: 1.6; color: var(--mu); max-width: 74ch; margin-bottom: 13px">
          Key slots belong to a codeplug. Read a radio that has them, or open a codeplug file you saved
          earlier, and the slots appear here.
        </p>
        <div class="flex flex-wrap items-center gap-2.5">
          <RiskAction risk="neutral" icon="i-lucide-radio" label="Connect a radio" @click="navigateTo('/')" />
          <OpenCodeplugButton />
        </div>
      </div>
    </template>
  </div>
</template>

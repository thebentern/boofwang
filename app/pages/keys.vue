<script setup lang="ts">
/**
 * The Keys screen: the notice, then the key slots.
 *
 * The notice states the rule and cites it, and the operator - who holds the
 * licence and is responsible for what they transmit - decides. Making them
 * declare a service first only taught people to click the answer that opened
 * the screen.
 */
useSeoMeta({ title: 'Encryption keys' })

const codeplug = useCodeplugStore()

const encryption = computed(() => codeplug.schema?.features.encryption ?? null)

/** A radio with no key slots gets told so, rather than shown an empty editor. */
const noKeySlots = computed(() => codeplug.isOpen && !encryption.value)
</script>

<template>
  <div class="mx-auto" style="max-width: 840px; padding: 22px 16px 48px">
    <div
      v-if="noKeySlots"
      style="border: 1px solid var(--ln); background: var(--pn); border-radius: 7px; padding: 18px"
    >
      <div class="flex items-center gap-2.5" style="margin-bottom: 6px">
        <UIcon name="i-lucide-key-round" class="shrink-0" style="width: 15px; height: 15px; color: var(--fn)" />
        <h1 style="font-size: 14px; font-weight: 600; color: var(--tx)">
          The {{ codeplug.schema?.vendor }} {{ codeplug.schema?.model }} has no encryption
        </h1>
      </div>
      <p style="font-size: 12.5px; line-height: 1.6; color: var(--mu); max-width: 74ch">
        This radio has no key slots to program. Of the radios boofwang supports, only the Baofeng DM-32UV
        carries them.
      </p>
    </div>

    <template v-else-if="codeplug.isOpen">
      <div style="margin-bottom: 13px">
        <EncryptionWarning />
      </div>
      <EncryptionKeys />
    </template>

    <template v-else>
      <div class="flex items-center gap-2.5 flex-wrap" style="margin-bottom: 11px">
        <UIcon name="i-lucide-key-round" class="shrink-0" style="width: 17px; height: 17px; color: var(--cn)" />
        <h1 style="font-size: 17px; font-weight: 600; letter-spacing: -0.02em; color: var(--tx)">
          Encryption keys
        </h1>
      </div>

      <div style="margin-bottom: 11px">
        <EncryptionWarning variant="bar" />
      </div>

      <div style="border: 1px solid var(--ln); background: var(--pn); border-radius: 7px; padding: 18px">
        <h2 style="font-size: 13px; font-weight: 600; color: var(--tx); margin-bottom: 5px">
          No codeplug open
        </h2>
        <p style="font-size: 12.5px; line-height: 1.6; color: var(--mu); max-width: 74ch; margin-bottom: 13px">
          Key slots belong to a codeplug. Read a radio that has them, or open a codeplug file you saved
          earlier, and the slots appear here.
        </p>
        <div class="flex flex-wrap items-center gap-2.5">
          <RiskAction risk="neutral" icon="i-lucide-radio" label="Choose a radio" @click="navigateTo('/')" />
          <OpenCodeplugButton />
        </div>
      </div>
    </template>
  </div>
</template>

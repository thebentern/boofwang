<script setup lang="ts">
/**
 * The Keys screen: a gate, and behind it the key slots.
 *
 * The screen has exactly one entrance. `EncryptionWarning` asks which service
 * the radio operates under and only a Part 90 answer opens the editor, so the
 * declaration is held here rather than in a store: it is per-visit by design.
 * Reloading, navigating away, or pressing Lock puts the gate back, because a
 * remembered "yes, I am licensed" is a gate that stopped asking.
 */
useSeoMeta({ title: 'Encryption keys' })

const codeplug = useCodeplugStore()

const encryption = computed(() => codeplug.schema?.features.encryption ?? null)

/**
 * A radio with no key slots is not gated, it is answered.
 *
 * Making someone declare a Part 90 licence before being told the UV-K5 has no
 * encryption at all would be theatre, and theatre is what discredits the gate
 * on the radios that do have slots.
 */
const nothingToUnlock = computed(() => codeplug.isOpen && !encryption.value)

const unlocked = ref(false)
</script>

<template>
  <div class="mx-auto" style="max-width: 840px; padding: 22px 16px 48px">
    <div
      v-if="nothingToUnlock"
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

    <EncryptionWarning v-else-if="!unlocked" @unlock="unlocked = true" />

    <EncryptionKeys v-else-if="codeplug.isOpen" @lock="unlocked = false" />

    <template v-else>
      <div class="flex items-center gap-2.5 flex-wrap" style="margin-bottom: 11px">
        <UIcon name="i-lucide-key-round" class="shrink-0" style="width: 17px; height: 17px; color: var(--cn)" />
        <h1 style="font-size: 17px; font-weight: 600; letter-spacing: -0.02em; color: var(--tx)">
          Encryption keys
        </h1>
        <div class="ms-auto flex items-center gap-2">
          <span
            class="chip"
            style="border: 1px solid var(--cnL); background: var(--cnB); color: var(--cn)"
          >Part 90 declared</span>
          <RiskAction risk="neutral" ghost size="sm" icon="i-lucide-lock" label="Lock" @click="unlocked = false" />
        </div>
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

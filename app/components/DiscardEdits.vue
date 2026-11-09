<script setup lang="ts">
/**
 * What an action asks before it throws away unwritten edits.
 *
 * Reading a radio, opening a file and opening a backup all replace the open
 * codeplug, and its unwritten edits go with it: they are on no radio and in
 * no backup. Destructive on the risk register, so this names what is lost,
 * then the hand travels the whole track. A panel rather than a dialog where
 * the page can put it where the button that raised it was, so there is one
 * decision on screen; `bare` drops the frame for a dialog that already has
 * one.
 *
 * The slide can start a read, and a read opens a chooser that needs transient
 * activation. `ConfirmSlide` emits from inside the pointer or key event that
 * completes it, which is what lets a page start the read from `confirm` - as
 * long as it awaits nothing first. An answer given any other way, a button in
 * a dialog seconds after the click, would arrive with no activation left to
 * open a chooser with.
 *
 * Saving a copy sits beside the slide because it is the answer to "how do I
 * keep them", and naming the remedy without the means would send somebody to
 * the channel table's Export menu and back.
 */
const { bare = false } = defineProps<{
  /** What the action discards, as a headline. The slot says the rest. */
  title: string
  /** The verb under the thumb, e.g. "Slide to discard edits and read". */
  label: string
  /** The action's own icon, so the slide says which verb it is besides its color. */
  icon: string
  bare?: boolean
}>()

const emit = defineEmits<{ confirm: []; cancel: [] }>()

const session = useRadioSession()
</script>

<template>
  <div
    :class="bare ? undefined : 'rounded-[8px]'"
    :style="bare ? undefined : 'border: 1px solid var(--dgL); background: var(--pn); padding: 17px 19px'"
    role="region"
    :aria-label="title"
  >
    <div v-if="!bare" class="flex items-start" style="gap: 10px">
      <UIcon name="i-lucide-circle-x" class="size-4 shrink-0" style="color: var(--dg); margin-top: 2px" />
      <div class="min-w-0">
        <div style="font-size: 15px; font-weight: 600; color: var(--tx)">{{ title }}</div>
        <p style="margin-top: 5px; font-size: 14px; line-height: 1.55; color: var(--mu); max-width: 72ch">
          <slot />
        </p>
      </div>
    </div>
    <p v-else style="font-size: 14px; line-height: 1.55; color: var(--mu); max-width: 72ch">
      <slot />
    </p>

    <div style="margin-top: 15px">
      <ConfirmSlide :label="label" risk="destructive" :icon="icon" @confirm="emit('confirm')">
        <template #secondary>
          <RiskAction
            risk="neutral"
            ghost
            icon="i-lucide-save"
            label="Save a copy"
            @click="session.downloadBwp()"
          />
          <RiskAction risk="neutral" ghost label="Keep editing" @click="emit('cancel')" />
        </template>
      </ConfirmSlide>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * What a read asks before it throws away unwritten edits.
 *
 * Destructive on the risk register: the panel names what is lost, then the
 * hand travels the whole track. It is a panel rather than a dialog, like the
 * update notice and the end of a fleet run, and the page that shows it puts
 * it where the button that raised it was, so there is one decision on screen.
 *
 * The slide starts a read, and a read opens a chooser that needs transient
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
defineProps<{
  /** What the read discards, as a headline. The slot says the rest. */
  title: string
}>()

const emit = defineEmits<{ confirm: []; cancel: [] }>()

const session = useRadioSession()
</script>

<template>
  <div
    class="rounded-[8px]"
    style="border: 1px solid var(--dgL); background: var(--pn); padding: 17px 19px"
    role="region"
    :aria-label="title"
  >
    <div class="flex items-start" style="gap: 10px">
      <UIcon name="i-lucide-circle-x" class="size-4 shrink-0" style="color: var(--dg); margin-top: 2px" />
      <div class="min-w-0">
        <div style="font-size: 15px; font-weight: 600; color: var(--tx)">{{ title }}</div>
        <p style="margin-top: 5px; font-size: 14px; line-height: 1.55; color: var(--mu); max-width: 72ch">
          <slot />
        </p>
      </div>
    </div>

    <div style="margin-top: 15px">
      <ConfirmSlide
        label="Slide to discard edits and read"
        risk="destructive"
        icon="i-lucide-download"
        @confirm="emit('confirm')"
      >
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

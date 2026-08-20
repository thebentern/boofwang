<script setup lang="ts">
/**
 * A confirmation you have to type.
 *
 * Deliberate friction on the two actions that cannot be undone from inside the
 * app: writing to a radio and restoring over one. A checkbox or a second
 * "are you sure" dialog trains people to click through; typing the word does
 * not, because the hand has to stop and the eye has to read what it is
 * agreeing to.
 *
 * Used inline as the last card of a flow rather than as a modal, so the diff
 * that justifies the action stays on screen while the word is typed.
 */
const props = withDefaults(
  defineProps<{
    /** The word that must be typed. Matched case-insensitively. */
    token: string
    label: string
    /** Risk level of the action being confirmed; drives the button styling. */
    risk?: 'caution' | 'destructive'
    disabled?: boolean
    loading?: boolean
    icon?: string
  }>(),
  { risk: 'caution', icon: undefined },
)

const emit = defineEmits<{ confirm: [] }>()

const typed = ref('')

/** Case-insensitive exact match. Nothing else enables the button. */
const matches = computed(() => typed.value.trim().toLowerCase() === props.token.toLowerCase())
const ready = computed(() => matches.value && !props.disabled && !props.loading)

function submit() {
  if (!ready.value) return
  emit('confirm')
}

/** Clear the field when the flow is reused, so the last word never carries over. */
defineExpose({ reset: () => (typed.value = '') })
</script>

<template>
  <div>
    <p class="text-[12.5px] mb-2" style="color: var(--mu)">
      <slot name="prompt">
        Type <code
          class="font-mono px-1.5 py-0.5 rounded-[3px] tabular"
          style="background: var(--pn3); color: var(--tx)"
        >{{ token }}</code> to confirm.
      </slot>
    </p>

    <div class="flex items-center gap-2 flex-wrap">
      <input
        v-model="typed"
        type="text"
        autocomplete="off"
        spellcheck="false"
        :aria-label="`Type ${token} to confirm`"
        class="font-mono rounded-[6px] px-2.5 outline-none focus:ring-0"
        style="
          height: 33px;
          width: 106px;
          letter-spacing: 0.08em;
          font-size: 14px;
          background: var(--pn);
          color: var(--tx);
          border: 1px solid var(--ln2);
        "
        @keydown.enter.prevent="submit"
      >

      <RiskAction
        :risk="ready ? risk : 'neutral'"
        :label="label"
        :icon="icon"
        :disabled="!ready"
        :loading="loading"
        size="md"
        @click="submit"
      />

      <slot name="secondary" />
    </div>
  </div>
</template>

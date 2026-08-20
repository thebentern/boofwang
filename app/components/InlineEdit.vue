<script setup lang="ts">
/**
 * A value that turns into a text field when you click Edit.
 *
 * Four lists on the DMR page need exactly this and nothing more, and each one
 * having its own copy is how they drift apart.
 */
defineProps<{
  editing: boolean
  value: string
  placeholder?: string
  maxlength?: number
  hint?: string
  label?: string
  problem?: string
}>()

const model = defineModel<string>('draft', { required: true })
const emit = defineEmits<{ save: []; cancel: []; edit: [] }>()

const INPUT_STYLE =
  'height: 33px; background: var(--pn); border: 1px solid var(--ln2); color: var(--tx); font-size: 14px'
</script>

<template>
  <div v-if="editing" class="min-w-0 flex-1">
    <div class="flex items-center gap-2">
      <input
        v-model="model"
        type="text"
        class="rounded-[6px] px-2.5 outline-none w-full font-mono"
        :style="INPUT_STYLE"
        :maxlength="maxlength"
        :placeholder="placeholder"
        autocomplete="off"
        spellcheck="false"
        @keyup.enter="emit('save')"
        @keyup.escape="emit('cancel')"
      >
      <RiskAction risk="neutral" size="sm" icon="i-lucide-check" label="Save" @click="emit('save')" />
      <RiskAction risk="neutral" ghost size="sm" label="Cancel" @click="emit('cancel')" />
    </div>
    <p
      v-if="problem"
      style="font-size: 13px; color: var(--dg); margin-top: 5px; line-height: 1.5"
    >{{ problem }}</p>
    <p
      v-else-if="hint"
      style="font-size: 13px; color: var(--mu); margin-top: 5px; line-height: 1.5"
    >{{ hint }}</p>
  </div>

  <div v-else class="flex items-center gap-2 flex-wrap min-w-0">
    <slot>
      <span style="font-size: 14.5px; font-weight: 600; color: var(--tx)">{{ value || '(unnamed)' }}</span>
    </slot>
    <button
      type="button"
      class="chip"
      style="border: 1px solid var(--ln2); background: transparent; color: var(--mu); cursor: pointer"
      @click="emit('edit')"
    >{{ label ?? 'Rename' }}</button>
  </div>
</template>

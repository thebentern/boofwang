<script setup lang="ts">
/**
 * One setting, rendered from its `FieldSpec`.
 *
 * The point of the schema being data is that this component is the only place
 * that knows what a control looks like. Adding a setting to a radio means
 * adding a line to its schema, and nothing here changes.
 */
import type { FieldSpec } from '#core/radio/schema.js'

const props = defineProps<{
  field: FieldSpec
  modelValue: unknown
}>()

const emit = defineEmits<{ 'update:modelValue': [unknown] }>()

const INPUT_STYLE =
  'height: 33px; background: var(--pn); border: 1px solid var(--ln2); color: var(--tx); font-size: 14px'

/**
 * A missing value is shown as missing, not as a zero.
 *
 * A radio whose settings this build does not decode has no entry for the key,
 * and rendering that as "0" would invent a value the user could then write.
 */
const present = computed(() => props.modelValue !== undefined && props.modelValue !== null)

const asNumber = computed(() => Number(props.modelValue ?? 0))
const asString = computed(() => String(props.modelValue ?? ''))

/** The label for the current value, when the schema enumerates them. */
const enumLabel = computed(() => {
  const opt = props.field.options?.find((o) => Number(o.value) === asNumber.value)
  return opt ? opt.label : `${asNumber.value} (not a value this build knows)`
})
</script>

<template>
  <label class="grid gap-1.5" style="min-width: 0">
    <span class="flex items-baseline gap-1.5" style="min-width: 0">
      <UIcon
        v-if="field.icon"
        :name="field.icon.replace(':', '-').replace(/^lucide-/, 'i-lucide-')"
        class="shrink-0"
        style="width: 13px; height: 13px; color: var(--fn); align-self: center"
      />
      <span class="label-xs">{{ field.label }}</span>
    </span>

    <span
      v-if="!present"
      style="font-size: 13.5px; color: var(--mu); font-style: italic"
    >not read from this radio</span>

    <select
      v-else-if="field.type === 'enum'"
      :value="asNumber"
      class="rounded-[6px] px-2 outline-none w-full"
      :style="INPUT_STYLE"
      @change="emit('update:modelValue', Number(($event.target as HTMLSelectElement).value))"
    >
      <option v-for="opt in field.options" :key="String(opt.value)" :value="Number(opt.value)">
        {{ opt.label }}
      </option>
      <!-- A value outside the schema's list is kept and shown, not replaced. -->
      <option
        v-if="!field.options?.some((o) => Number(o.value) === asNumber)"
        :value="asNumber"
      >{{ enumLabel }}</option>
    </select>

    <span v-else-if="field.type === 'bool'" class="flex items-center gap-2">
      <input
        type="checkbox"
        :checked="asNumber !== 0"
        style="width: 15px; height: 15px; accent-color: var(--cn)"
        @change="emit('update:modelValue', ($event.target as HTMLInputElement).checked ? 1 : 0)"
      >
      <span style="font-size: 14px; color: var(--mu)">{{ asNumber !== 0 ? 'On' : 'Off' }}</span>
    </span>

    <input
      v-else-if="field.type === 'int'"
      type="number"
      :value="asNumber"
      :min="field.min"
      :max="field.max"
      class="rounded-[6px] px-2.5 outline-none w-full"
      :style="INPUT_STYLE"
      @change="emit('update:modelValue', Number(($event.target as HTMLInputElement).value))"
    >

    <input
      v-else
      type="text"
      :value="asString"
      :maxlength="field.maxLength"
      class="rounded-[6px] px-2.5 outline-none w-full"
      :style="INPUT_STYLE"
      autocomplete="off"
      spellcheck="false"
      @change="emit('update:modelValue', ($event.target as HTMLInputElement).value)"
    >

    <span v-if="field.help" style="font-size: 12.5px; color: var(--mu); line-height: 1.5">{{ field.help }}</span>
  </label>
</template>

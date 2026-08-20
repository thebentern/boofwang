<script setup lang="ts">
/**
 * Every setting a radio declares, grouped as its schema groups them.
 *
 * Renders `RadioSchema.settings` against `Codeplug.settings`. It knows nothing
 * about any particular radio, which is the whole point: a UV-5R Mini and a
 * DM-32UV share this file and disagree only in their schemas.
 */
import type { SettingGroup } from '#core/radio/schema.js'

defineProps<{
  groups: readonly SettingGroup[]
  values: Readonly<Record<string, unknown>>
}>()

const emit = defineEmits<{ change: [key: string, value: unknown] }>()
</script>

<template>
  <div class="grid" style="gap: 14px">
    <section
      v-for="group in groups"
      :key="group.id"
      style="border: 1px solid var(--ln); background: var(--pn); border-radius: 7px; overflow: hidden"
    >
      <div style="padding: 11px 14px 10px; border-bottom: 1px solid var(--ln); background: var(--pn2)">
        <h2 style="font-size: 13px; font-weight: 600; color: var(--tx)">{{ group.label }}</h2>
        <p
          v-if="group.description"
          style="font-size: 11.5px; color: var(--mu); margin-top: 3px; line-height: 1.55; max-width: 74ch"
        >{{ group.description }}</p>
      </div>

      <div class="grid sm:grid-cols-2 lg:grid-cols-3" style="gap: 13px; padding: 14px">
        <SchemaField
          v-for="field in group.fields"
          :key="field.key"
          :field="field"
          :model-value="values[field.key]"
          @update:model-value="emit('change', field.key, $event)"
        />
      </div>
    </section>
  </div>
</template>

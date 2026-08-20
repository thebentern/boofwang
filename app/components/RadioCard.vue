<script setup lang="ts">
import type { RadioId } from '#core/model/codeplug.js'

export interface RadioCardEntry {
  id: RadioId
  vendor: string
  model: string
  summary: string
  implemented: boolean
  canRead: boolean
  canWrite: boolean
  notes: string
}

defineProps<{ radio: RadioCardEntry; enabled: boolean; busy: boolean }>()
const emit = defineEmits<{ read: [RadioId] }>()
</script>

<template>
  <UCard :ui="{ body: 'space-y-3' }">
    <template #header>
      <div class="flex items-start gap-3">
        <UIcon name="i-lucide-radio" class="size-5 mt-0.5 text-primary shrink-0" />
        <div class="min-w-0">
          <h3 class="font-semibold leading-tight">{{ radio.vendor }} {{ radio.model }}</h3>
          <p class="text-sm text-muted">{{ radio.summary }}</p>
        </div>
        <UBadge
          class="ms-auto shrink-0"
          :color="radio.canWrite ? 'success' : radio.canRead ? 'info' : 'neutral'"
          variant="subtle"
          :label="radio.canWrite ? 'Read and write' : radio.canRead ? 'Read only' : 'Not yet implemented'"
        />
      </div>
    </template>

    <p class="text-sm text-muted">{{ radio.notes }}</p>

    <div class="flex items-center gap-2">
      <UButton
        icon="i-lucide-download"
        label="Read from radio"
        size="sm"
        :loading="busy"
        :disabled="!enabled || !radio.canRead || busy"
        @click="emit('read', radio.id)"
      />
      <UButton
        icon="i-lucide-upload"
        label="Write to radio"
        size="sm"
        color="neutral"
        variant="subtle"
        :disabled="!enabled || !radio.canWrite"
      />
    </div>

    <p v-if="radio.canRead && !radio.canWrite" class="text-xs text-muted flex items-start gap-1.5">
      <UIcon name="i-lucide-lock" class="size-3.5 mt-0.5 shrink-0" />
      Writing stays disabled until the write path has been verified against real hardware.
    </p>
  </UCard>
</template>

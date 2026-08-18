<script setup lang="ts">
export interface RadioCardEntry {
  id: string
  vendor: string
  model: string
  summary: string
  status: 'planned' | 'read-only' | 'beta' | 'stable'
  read: boolean
  write: boolean
  notes: string
}

defineProps<{ radio: RadioCardEntry; enabled: boolean }>()

const STATUS = {
  planned: { label: 'Not yet implemented', color: 'neutral' as const },
  'read-only': { label: 'Read only', color: 'info' as const },
  beta: { label: 'Beta', color: 'warning' as const },
  stable: { label: 'Stable', color: 'success' as const },
}
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
          :color="STATUS[radio.status].color"
          variant="subtle"
          :label="STATUS[radio.status].label"
        />
      </div>
    </template>

    <p class="text-sm text-muted">{{ radio.notes }}</p>

    <div class="flex items-center gap-2">
      <UButton
        icon="i-lucide-download"
        label="Read from radio"
        size="sm"
        :disabled="!enabled || !radio.read"
      />
      <UButton
        icon="i-lucide-upload"
        label="Write to radio"
        size="sm"
        color="neutral"
        variant="subtle"
        :disabled="!enabled || !radio.write"
      />
    </div>

    <p v-if="!radio.write" class="text-xs text-muted flex items-start gap-1.5">
      <UIcon name="i-lucide-lock" class="size-3.5 mt-0.5 shrink-0" />
      Writing is disabled for this radio until the write path has been verified against real hardware.
    </p>
  </UCard>
</template>

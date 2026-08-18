<script setup lang="ts">
const transfer = useTransferStore()
</script>

<template>
  <UModal
    :open="transfer.active"
    :dismissible="false"
    :close="false"
    title="Talking to the radio"
    :description="transfer.label"
  >
    <template #body>
      <div class="space-y-4">
        <UProgress :model-value="transfer.percent" />
        <div class="flex items-center justify-between text-sm text-muted tabular">
          <span>{{ transfer.phase ?? 'working' }}</span>
          <span v-if="transfer.total">
            {{ transfer.done.toLocaleString() }} / {{ transfer.total.toLocaleString() }} bytes
          </span>
        </div>
        <p class="text-xs text-muted">
          Leave the cable connected and the radio switched on until this finishes.
        </p>
      </div>
    </template>

    <template #footer>
      <UButton
        label="Cancel"
        color="neutral"
        variant="subtle"
        icon="i-lucide-square"
        :disabled="!transfer.canCancel"
        @click="transfer.cancel()"
      />
    </template>
  </UModal>
</template>

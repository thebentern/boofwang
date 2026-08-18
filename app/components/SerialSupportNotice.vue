<script setup lang="ts">
import type { SerialSupport } from '~/composables/useSerialSupport'

defineProps<{ support: SerialSupport }>()
</script>

<template>
  <UAlert
    v-if="!support.supported"
    :icon="support.blocker === 'insecure-context' ? 'i-lucide-shield-alert' : 'i-lucide-triangle-alert'"
    color="warning"
    variant="subtle"
    :title="
      support.blocker === 'insecure-context'
        ? 'This page needs a secure connection'
        : 'This browser cannot talk to a radio'
    "
    :description="support.advice"
  />
  <UAlert
    v-else
    icon="i-lucide-circle-check"
    color="success"
    variant="subtle"
    title="Web Serial is available"
    description="You can connect a radio over its programming cable."
  />
</template>

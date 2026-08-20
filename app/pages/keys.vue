<script setup lang="ts">
useSeoMeta({ title: 'Encryption keys' })

const codeplug = useCodeplugStore()
</script>

<template>
  <div class="mx-auto max-w-4xl px-4 py-8 space-y-6">
    <div>
      <h1 class="text-2xl font-semibold tracking-tight">Encryption keys</h1>
      <p class="text-sm text-muted">
        <template v-if="codeplug.isOpen">
          {{ codeplug.schema?.vendor }} {{ codeplug.schema?.model }}
        </template>
        <template v-else>Open a codeplug to edit its keys.</template>
      </p>
    </div>

    <div v-if="!codeplug.isOpen" class="space-y-4 max-w-2xl">
      <EncryptionWarning />
      <div class="flex flex-wrap items-center gap-3">
        <UButton to="/" icon="i-lucide-radio" label="Choose a radio" />
        <OpenCodeplugButton />
      </div>
    </div>

    <EncryptionKeys v-else />
  </div>
</template>

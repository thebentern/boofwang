<script setup lang="ts">
useSeoMeta({ title: 'Channels' })

const codeplug = useCodeplugStore()
const session = useRadioSession()
</script>

<template>
  <div class="mx-auto max-w-7xl px-4 py-8 space-y-6">
    <div v-if="!codeplug.isOpen" class="max-w-2xl space-y-4">
      <h1 class="text-2xl font-semibold tracking-tight">No codeplug open</h1>
      <p class="text-muted">
        Read one from a radio, or open a <code>.bwp</code> file you saved earlier.
      </p>
      <div class="flex flex-wrap items-center gap-3">
        <UButton to="/" icon="i-lucide-radio" label="Choose a radio" />
        <OpenCodeplugButton />
      </div>
    </div>

    <template v-else>
      <div class="flex flex-wrap items-start gap-4">
        <div>
          <h1 class="text-2xl font-semibold tracking-tight">
            {{ codeplug.schema?.vendor }} {{ codeplug.schema?.model }}
          </h1>
          <p class="text-sm text-muted">
            {{ codeplug.channelCount }} channel(s)
            <template v-if="codeplug.doc?.meta.variant"> · firmware {{ codeplug.doc.meta.variant }}</template>
          </p>
        </div>

        <div class="ms-auto flex flex-wrap items-center gap-2">
          <UButton icon="i-lucide-file-down" label="CHIRP CSV" size="sm" variant="subtle" color="neutral" @click="session.downloadCsv()" />
          <UButton icon="i-lucide-save" label="Codeplug (.bwp)" size="sm" variant="subtle" color="neutral" @click="session.downloadBwp()" />
          <UButton icon="i-lucide-binary" label="Raw (.bin)" size="sm" variant="subtle" color="neutral" @click="session.downloadRawBin()" />
        </div>
      </div>

      <DiagnosticsSummary :diagnostics="codeplug.diagnostics" />

      <ChannelTable />
    </template>
  </div>
</template>

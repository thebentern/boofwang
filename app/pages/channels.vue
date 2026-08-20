<script setup lang="ts">
import type { Channel } from '#core/model/channel.js'

useSeoMeta({ title: 'Channels' })

const codeplug = useCodeplugStore()
const session = useRadioSession()

const editing = ref<Channel | null>(null)
const writeOpen = ref(false)

/**
 * Offered whenever there is a codeplug and the radio supports writing.
 *
 * Deliberately not conditional on a live connection: reading disconnects when
 * it finishes, so requiring one would hide the button at exactly the moment
 * someone has finished editing. The write flow reconnects, and the gate refuses
 * for any real reason.
 */
const canOfferWrite = computed(() => codeplug.isOpen && codeplug.schema?.capabilities.write === true)
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
          <UButton
            v-if="canOfferWrite"
            icon="i-lucide-upload"
            label="Write to radio"
            size="sm"
            color="warning"
            :disabled="!codeplug.dirty"
            @click="writeOpen = true"
          />
          <UButton icon="i-lucide-file-down" label="CHIRP CSV" size="sm" variant="subtle" color="neutral" @click="session.downloadCsv()" />
          <UButton icon="i-lucide-save" label="Codeplug (.bwp)" size="sm" variant="subtle" color="neutral" @click="session.downloadBwp()" />
          <UButton icon="i-lucide-binary" label="Raw (.bin)" size="sm" variant="subtle" color="neutral" @click="session.downloadRawBin()" />
        </div>
      </div>

      <UAlert
        v-if="codeplug.dirty"
        icon="i-lucide-pencil"
        color="info"
        variant="subtle"
        title="You have unsaved changes"
        :description="
          canOfferWrite
            ? 'They are held in this browser only. Use “Write to radio” to send them.'
            : 'They are held in this browser only.'
        "
      />

      <DiagnosticsSummary :diagnostics="codeplug.diagnostics" />

      <ChannelTable @edit="editing = $event" />

      <UModal v-model:open="writeOpen" title="Write to radio" :ui="{ content: 'max-w-2xl' }">
        <template #body>
          <WriteToRadioDialog @close="writeOpen = false" />
        </template>
      </UModal>

      <UModal
        :open="editing !== null"
        :title="editing ? `Channel ${editing.index}` : ''"
        :ui="{ content: 'max-w-2xl' }"
        @update:open="(v: boolean) => { if (!v) editing = null }"
      >
        <template #body>
          <ChannelEditor v-if="editing" :key="editing.index" :channel="editing" @close="editing = null" />
        </template>
      </UModal>
    </template>
  </div>
</template>

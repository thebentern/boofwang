<script setup lang="ts">
import { openImageFile } from '#core/io/open-image.js'
import { createDriver } from '#core/radio/registry.js'

const codeplug = useCodeplugStore()
const toast = useToast()
const input = useTemplateRef<HTMLInputElement>('input')

async function onPick(event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0]
  if (!file) return
  const bytes = new Uint8Array(await file.arrayBuffer())

  try {
    const { image, note } = await openImageFile(bytes)
    codeplug.load(image, createDriver(image.radioId))

    if (note.kind === 'bwp') {
      toast.add({
        title: 'Codeplug opened',
        description: `${codeplug.channelCount} channel(s) from ${image.variant || image.radioId}.`,
        icon: 'i-lucide-circle-check',
        color: 'success',
      })
    } else if (note.kind === 'chirp-img') {
      const model = [note.metadata.vendor, note.metadata.model].filter(Boolean).join(' ')
      toast.add({
        title: 'CHIRP image opened',
        description:
          `${codeplug.channelCount} channel(s)` +
          (model ? ` from a ${model}` : '') +
          (note.metadata.chirp_version ? `, saved by CHIRP ${note.metadata.chirp_version}.` : '.'),
        icon: 'i-lucide-circle-check',
        color: 'success',
      })
    } else {
      // A bare dump says nothing about itself beyond its shape, so the guess is
      // stated rather than hidden.
      toast.add({
        title: 'Raw image opened',
        description:
          note.guessedFrom === 'page-ids'
            ? `Read as a ${image.radioId} image from the block ids its pages carry. ` +
              'Check the channels look right before writing it anywhere.'
            : `Assumed to be a ${image.radioId} image from its size — a bare .bin carries no identity. ` +
              'Check the channels look right before writing it anywhere.',
        icon: 'i-lucide-triangle-alert',
        color: 'warning',
        duration: 10_000,
      })
    }
    await navigateTo('/channels')
  } catch (e) {
    toast.add({
      title: 'Could not open that file',
      description: e instanceof Error ? e.message : String(e),
      icon: 'i-lucide-circle-alert',
      color: 'error',
      duration: 0,
    })
  } finally {
    if (input.value) input.value.value = ''
  }
}
</script>

<template>
  <div>
    <input ref="input" type="file" accept=".bwp,.bin,.img,application/octet-stream" class="hidden" @change="onPick" >
    <UButton
      icon="i-lucide-file-up"
      label="Open a codeplug file"
      color="neutral"
      variant="subtle"
      @click="input?.click()"
    />
  </div>
</template>

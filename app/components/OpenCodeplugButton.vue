<script setup lang="ts">
import { decodeBwp, decodeRawBin, looksLikeBwp, peekBwpHeader } from '#core/io/bwp.js'
import { createDriver, isImplemented } from '#core/radio/registry.js'
import { REGIONS } from '#core/radios/uvk5/layout.js'
import type { RadioId } from '#core/model/codeplug.js'

const codeplug = useCodeplugStore()
const toast = useToast()
const input = useTemplateRef<HTMLInputElement>('input')

/**
 * Raw images carry no identity, so importing one means asking which radio it
 * came from. A `.bwp` says so itself, which is the whole reason that format
 * exists.
 */
const RAW_LAYOUTS: Partial<Record<RadioId, { variant: string; layout: string; regions: typeof REGIONS }>> = {
  uvk5: { variant: '', layout: 'stock', regions: REGIONS },
}

async function onPick(event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0]
  if (!file) return
  const bytes = new Uint8Array(await file.arrayBuffer())

  try {
    if (looksLikeBwp(bytes)) {
      const header = peekBwpHeader(bytes)
      if (!header || !isImplemented(header.radioId)) {
        throw new Error(`This codeplug is for a ${header?.radioId ?? 'unknown'}, which boofwang cannot decode yet.`)
      }
      const image = await decodeBwp(bytes)
      codeplug.load(image, createDriver(image.radioId))
      toast.add({
        title: 'Codeplug opened',
        description: `${codeplug.channelCount} channel(s) from ${image.variant || image.radioId}.`,
        icon: 'i-lucide-circle-check',
        color: 'success',
      })
      await navigateTo('/channels')
      return
    }

    // A bare .bin: the only clue is its size.
    const match = Object.entries(RAW_LAYOUTS).find(
      ([, l]) => l && bytes.length === l.regions.reduce((n, r) => n + r.length, 0),
    )
    if (!match) {
      throw new Error(
        `This file is ${bytes.length.toLocaleString()} bytes, which does not match any radio boofwang supports. ` +
          'If it is a codeplug, open the .bwp instead — a raw .bin cannot say which radio it came from.',
      )
    }
    const [radioId, layout] = match as [RadioId, NonNullable<(typeof RAW_LAYOUTS)[RadioId]>]
    const image = await decodeRawBin(bytes, {
      radioId,
      variant: layout.variant,
      layout: layout.layout,
      regions: layout.regions.map((r) => ({ start: r.start, length: r.length, label: r.label, readOnly: r.readOnly })),
    })
    codeplug.load(image, createDriver(radioId))
    toast.add({
      title: 'Raw image opened',
      description: `Assumed to be a ${radioId} image from its size. Check the channels look right before writing it anywhere.`,
      icon: 'i-lucide-triangle-alert',
      color: 'warning',
      duration: 10_000,
    })
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

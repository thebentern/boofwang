<script setup lang="ts">
import { diffChannels } from '#core/radio/channel-diff.js'

/**
 * The first sentence of a question about losing unwritten edits: whose
 * codeplug, and the part of the loss that can be counted.
 *
 * Channels are what boofwang can narrate, so they are the count, worked out
 * the way the write page works out its diff. Edits elsewhere are real and
 * uncounted, which is why the sentence says "including" rather than giving a
 * total. It decodes the whole image, so it belongs inside a question that is
 * up rather than anywhere it would be rendered all the time.
 */
const codeplug = useCodeplugStore()

/** The open codeplug's radio, which need not be the one about to replace it. */
const radio = computed(() => (codeplug.schema ? `${codeplug.schema.vendor} ${codeplug.schema.model}` : 'radio'))

const changed = computed(() => {
  void codeplug.revision
  const driver = codeplug.driverRef
  const image = codeplug.image
  const doc = codeplug.doc
  if (!driver || !image || !doc) return 0
  return diffChannels(driver.decode(image), doc).changed
})
</script>

<template>
  <span>The {{ radio }} codeplug open here has unwritten edits<template v-if="changed > 0">,
    including <span class="font-mono tabular">{{ changed }}</span> changed
    channel{{ changed === 1 ? '' : 's' }}</template>.</span>
</template>

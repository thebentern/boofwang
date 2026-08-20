<script setup lang="ts">
import type { RadioId } from '#core/model/codeplug.js'
import type { RadioSchema } from '#core/radio/schema.js'
import { RADIO_IDS, SCHEMAS, isImplemented } from '#core/radio/registry.js'

/**
 * What boofwang knows how to talk to, and how far it has been taken.
 *
 * This replaced a read/write/hardware matrix, deliberately. Three of four rows
 * said a variation of "yes", so the one column meant to carry a warning became
 * furniture - the reader learned to skim a grid of confident ticks and the
 * caveat went with it. One chip per driver instead, so a narrowed or untested
 * driver is the only thing on the screen spending colour.
 *
 * The chip is computed from `SCHEMAS[id].capabilities` and nothing else, which
 * is the point: a driver that stops writing stops being described as writing on
 * the same deploy, and this page has no way to say otherwise. The prose below
 * is editorial and can only add caveats, never capability.
 *
 * Nobody picks a radio from this list - the handshake identifies what is on the
 * cable - so the rows are not choices. The one that a read would use is tinted,
 * so the list still answers "which of these am I about to talk to".
 */
defineProps<{ activeRadio?: RadioId | null }>()

type ChipTone = 'ok' | 'cn' | 'dg' | 'neutral'

/**
 * One sentence about what this driver does, derived from what it declares.
 *
 * `writeScope` is quoted rather than paraphrased so a driver that narrows its
 * write in a future release renames its own chip instead of waiting for someone
 * to notice the copy here has gone stale.
 */
function statusOf(id: RadioId, schema: RadioSchema | null): { tone: ChipTone; icon: string; label: string } {
  if (!schema || !isImplemented(id)) {
    return { tone: 'neutral', icon: 'i-lucide-circle-minus', label: 'Not supported yet' }
  }
  if (schema.status === 'planned' || !schema.capabilities.read) {
    return { tone: 'neutral', icon: 'i-lucide-circle-minus', label: 'Not supported yet' }
  }
  const scope = schema.capabilities.writeScope
  if (schema.capabilities.write && scope) {
    return { tone: 'cn', icon: 'i-lucide-circle-dot', label: `Read · ${scope.replace(/^encryption /, '')} only` }
  }
  if (schema.capabilities.write) {
    return { tone: 'ok', icon: 'i-lucide-circle-check', label: 'Read and write' }
  }
  return { tone: 'neutral', icon: 'i-lucide-circle-minus', label: 'Read only' }
}

/** Channels, then whatever else this radio's memory actually holds. */
function memoryOf(schema: RadioSchema | null): string {
  if (!schema) return ''
  const parts = [`${schema.memory.channelCount.toLocaleString()} ch`, schema.features.dmr ? 'DMR' : 'analog']
  if (schema.features.zones) parts.push('zones')
  if (schema.features.encryption) parts.push('AES')
  return parts.join(' · ')
}

const CHIP_STYLES: Record<ChipTone, { border: string; background: string; color: string }> = {
  ok: { border: 'var(--okL)', background: 'var(--okB)', color: 'var(--ok)' },
  cn: { border: 'var(--cnL)', background: 'var(--cnB)', color: 'var(--cn)' },
  dg: { border: 'var(--dgL)', background: 'var(--dgB)', color: 'var(--dg)' },
  neutral: { border: 'var(--ln)', background: 'var(--pn2)', color: 'var(--mu)' },
}

const rows = computed(() =>
  RADIO_IDS.map((id) => {
    const schema = SCHEMAS[id]
    return {
      id,
      name: schema ? `${schema.vendor} ${schema.model}` : id,
      memory: memoryOf(schema),
      status: statusOf(id, schema),
    }
  }),
)
</script>

<template>
  <div style="border: 1px solid var(--ln); background: var(--pn); border-radius: 7px; overflow: hidden">
    <div class="flex items-center gap-2.5" style="padding: 12px 16px; border-bottom: 1px solid var(--ln)">
      <UIcon name="i-lucide-list" style="width: 13px; height: 13px; color: var(--fn)" />
      <span class="label-xs">Radios boofwang knows</span>
      <span class="ms-auto hidden sm:inline" style="font-size: 13px; color: var(--fn)">
        The handshake identifies which is on the cable.
      </span>
    </div>

    <div v-for="row in rows" :key="row.id">
      <div
        class="w-full flex items-center gap-3"
        style="height: 38px; padding: 0 13px; border-bottom: 1px solid var(--ln)"
        :style="{ background: row.id === activeRadio ? 'var(--okB)' : 'transparent' }"
      >
        <span
          class="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap"
          style="font-size: 14px; font-weight: 600; color: var(--tx)"
        >{{ row.name }}</span>
        <span
          class="font-mono tabular whitespace-nowrap hidden sm:inline"
          style="font-size: 12.5px; color: var(--fn)"
        >{{ row.memory }}</span>
        <span
          class="chip ms-auto shrink-0"
          :style="{
            border: `1px solid ${CHIP_STYLES[row.status.tone].border}`,
            background: CHIP_STYLES[row.status.tone].background,
            color: CHIP_STYLES[row.status.tone].color,
          }"
        >
          <UIcon :name="row.status.icon" style="width: 11px; height: 11px" />
          {{ row.status.label }}
        </span>
      </div>
    </div>
  </div>
</template>

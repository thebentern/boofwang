<script setup lang="ts">
import type { ChannelChange, ChannelDiff } from '#core/radio/channel-diff.js'

/**
 * What a write changes, in verbs rather than bytes.
 *
 * The old dialog's problem was not that it had too much text - it was that a
 * byte count and a block count are trivia. Nobody can consent to "1,792 bytes".
 * This is the confirmation step, so it has to be readable as a list of things
 * happening to channels.
 *
 * Two rows are called out by name because they carry consequence beyond their
 * size: a channel gaining transmit, and a slot being erased.
 */
const props = defineProps<{ diff: ChannelDiff; blocks?: number; bytes?: number }>()

const KIND = {
  edit: { label: 'edit', icon: 'i-lucide-pencil', tone: 'neutral' },
  add: { label: 'add', icon: 'i-lucide-plus', tone: 'info' },
  gain: { label: 'gain', icon: 'i-lucide-lock-open', tone: 'caution' },
  erase: { label: 'erase', icon: 'i-lucide-trash-2', tone: 'danger' },
} as const

const NOTE = {
  'gains-transmit': { text: 'gains transmit', tone: 'caution' },
  'loses-transmit': { text: 'transmit disabled', tone: 'neutral' },
  'slot-cleared': { text: 'slot cleared', tone: 'danger' },
  'error-cleared': { text: 'error cleared', tone: 'ok' },
  'from-preset': { text: 'from preset', tone: 'neutral' },
} as const

const TONE_COLOR: Record<string, string> = {
  neutral: 'var(--fn)',
  info: 'var(--in)',
  caution: 'var(--cn)',
  danger: 'var(--dg)',
  ok: 'var(--ok)',
}
const TONE_BG: Record<string, string> = {
  neutral: 'var(--pn3)',
  info: 'var(--inB)',
  caution: 'var(--cnB)',
  danger: 'var(--dgB)',
  ok: 'var(--okB)',
}

function kindOf(c: ChannelChange) {
  return KIND[c.kind]
}

/**
 * The totals line, ordered by consequence rather than by size.
 *
 * "Gains transmit" and "erased" come before the byte count on purpose: the
 * numbers that matter are the ones with a legal or safety meaning, and the
 * wire size is the least interesting fact about a write.
 */
const totals = computed(() => {
  const d = props.diff
  const parts = [`${d.changed} channel${d.changed === 1 ? '' : 's'} change`]
  parts.push(`${d.gainsTransmit} gains transmit`)
  parts.push(`${d.erased} slot${d.erased === 1 ? '' : 's'} erased`)
  parts.push(`${d.receiveOnlyLost} RX-Only lost`)
  return parts.join(' · ')
})
</script>

<template>
  <div class="rounded-[7px] overflow-hidden" style="border: 1px solid var(--ln)">
    <div
      v-for="c in diff.changes"
      :key="c.slot"
      class="flex items-center gap-2.5"
      style="padding: 7px 14px; border-bottom: 1px solid var(--ln)"
    >
      <span
        class="chip justify-center shrink-0"
        style="width: 64px"
        :style="{ background: TONE_BG[kindOf(c).tone], color: TONE_COLOR[kindOf(c).tone] }"
      >
        <UIcon :name="kindOf(c).icon" class="size-3" />
        {{ kindOf(c).label }}
      </span>

      <span class="font-mono tabular text-right shrink-0" style="width: 24px; font-size: 13px; color: var(--fn)">
        {{ c.slot }}
      </span>

      <span
        v-if="c.before"
        class="truncate"
        style="font-size: 13.5px; color: var(--fn); text-decoration: line-through"
      >{{ c.before }}</span>

      <UIcon v-if="c.before && c.after" name="i-lucide-arrow-right" class="size-3 shrink-0" style="color: var(--fn)" />

      <span v-if="c.after" class="truncate" style="font-size: 13.5px; color: var(--tx)">{{ c.after }}</span>

      <span
        v-if="c.note"
        class="ms-auto shrink-0"
        style="font-size: 13px"
        :style="{ color: TONE_COLOR[NOTE[c.note].tone] }"
      >{{ NOTE[c.note].text }}</span>
    </div>

    <div
      class="flex items-center gap-3 flex-wrap"
      style="padding: 7px 14px; background: var(--pn2); font-size: 13px; color: var(--mu)"
    >
      <span>{{ totals }}</span>
      <span v-if="blocks !== undefined" class="ms-auto font-mono tabular" style="color: var(--fn)">
        {{ blocks }} block{{ blocks === 1 ? '' : 's' }}<template v-if="bytes !== undefined"> · {{ bytes.toLocaleString() }} bytes on the wire</template>
      </span>
    </div>
  </div>
</template>

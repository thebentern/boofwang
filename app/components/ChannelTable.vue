<script setup lang="ts">
import { useVirtualizer } from '@tanstack/vue-virtual'
import { chirpMode, txFrequency, type Channel } from '#core/model/channel.js'
import { describeTone } from '#core/model/tones.js'
import { formatFreq, formatPower } from '#core/model/units.js'

const emit = defineEmits<{ edit: [Channel] }>()

const codeplug = useCodeplugStore()

const query = ref('')
const rxOnlyOnly = ref(false)

const rows = computed(() => {
  const q = query.value.trim().toLowerCase()
  return codeplug.channels.filter((c) => {
    if (rxOnlyOnly.value && c.txAllowed) return false
    if (!q) return true
    return (
      c.name.toLowerCase().includes(q) ||
      formatFreq(c.rxFreq).includes(q) ||
      String(c.index) === q
    )
  })
})

// A UV-K5 holds 200 channels but a DM-32UV holds 4000, and the table is the
// same component for both. Rendering only the visible window keeps it usable at
// either size.
const scroller = useTemplateRef<HTMLElement>('scroller')
const rowHeight = 36

/** Shared by the header and every row so they cannot drift apart. */
const COLUMNS = '3.5rem 9rem 7rem 5rem 7rem 6rem 4rem 5rem 4rem'

const virtualizer = useVirtualizer(
  computed(() => ({
    count: rows.value.length,
    getScrollElement: () => scroller.value ?? null,
    estimateSize: () => rowHeight,
    overscan: 12,
  })),
)

const virtualRows = computed(() => virtualizer.value.getVirtualItems())
const totalHeight = computed(() => virtualizer.value.getTotalSize())

function offsetLabel(c: Channel): string {
  if (!c.txAllowed) return 'TX off'
  switch (c.tx.kind) {
    case 'simplex':
      return '—'
    case 'offset':
      return `${c.tx.direction === 'plus' ? '+' : '−'}${(c.tx.offset / 1e6).toFixed(3)}`
    case 'split':
      return `split ${formatFreq(c.tx.txFreq)}`
  }
}

function txLabel(c: Channel): string {
  const f = txFrequency(c)
  return f === null ? '—' : formatFreq(f)
}
</script>

<template>
  <div class="space-y-4">
    <div class="flex flex-wrap items-center gap-3">
      <UInput
        v-model="query"
        icon="i-lucide-search"
        placeholder="Filter by name, frequency or slot"
        class="max-w-xs"
      />
      <USwitch v-model="rxOnlyOnly" label="Receive-only channels" />
      <div class="ms-auto flex items-center gap-2 text-sm text-muted tabular">
        <span>{{ rows.length.toLocaleString() }} of {{ codeplug.channelCount.toLocaleString() }}</span>
        <UBadge
          v-if="codeplug.rxOnlyCount"
          :label="`${codeplug.rxOnlyCount} RX only`"
          icon="i-lucide-lock"
          color="warning"
          variant="subtle"
          size="sm"
        />
      </div>
    </div>

    <div class="border border-default rounded-md overflow-hidden">
      <div
        class="grid items-center gap-2 px-3 py-2 text-xs font-medium text-muted bg-elevated border-b border-default"
        :style="{ gridTemplateColumns: COLUMNS }"
      >
        <span>Slot</span><span>Name</span><span class="text-right">Receive</span><span>Offset</span>
        <span class="text-right">Transmit</span><span>Tone</span><span>Mode</span><span>Step</span>
        <span class="text-right">Power</span>
      </div>

      <div ref="scroller" class="overflow-auto" style="height: min(60vh, 40rem)">
        <div :style="{ height: `${totalHeight}px`, position: 'relative' }">
          <div
            v-for="v in virtualRows"
            :key="rows[v.index]!.index"
            class="grid items-center gap-2 px-3 text-sm border-b border-default/60 hover:bg-elevated/60 cursor-pointer"
            :class="rows[v.index]!.txAllowed ? '' : 'bg-warning/5'"
            role="button"
            :tabindex="0"
            :style="{
              gridTemplateColumns: COLUMNS,
              position: 'absolute',
              top: 0,
              left: 0,
              right: 0,
              height: `${v.size}px`,
              transform: `translateY(${v.start}px)`,
            }"
            @click="emit('edit', rows[v.index]!)"
            @keydown.enter="emit('edit', rows[v.index]!)"
          >
            <span class="tabular text-muted">{{ rows[v.index]!.index }}</span>
            <span class="truncate font-medium">{{ rows[v.index]!.name || '—' }}</span>
            <span class="tabular text-right">{{ formatFreq(rows[v.index]!.rxFreq) }}</span>
            <span class="tabular text-muted">{{ offsetLabel(rows[v.index]!) }}</span>
            <span
              class="tabular text-right"
              :class="rows[v.index]!.txAllowed ? '' : 'text-warning font-medium'"
            >
              <UIcon v-if="!rows[v.index]!.txAllowed" name="i-lucide-lock" class="size-3 me-1 align-[-1px]" />
              {{ txLabel(rows[v.index]!) }}
            </span>
            <span class="text-muted truncate">{{ describeTone(rows[v.index]!.tone.tx) }}</span>
            <span class="text-muted">{{ chirpMode(rows[v.index]!) }}</span>
            <span class="tabular text-muted">{{ (rows[v.index]!.tuningStep / 1000).toFixed(2) }}</span>
            <span class="tabular text-right text-muted">{{ formatPower(rows[v.index]!.power.mW) }}</span>
          </div>
        </div>
      </div>
    </div>

    <p v-if="codeplug.rxOnlyCount" class="text-xs text-muted flex items-start gap-1.5">
      <UIcon name="i-lucide-lock" class="size-3.5 mt-0.5 shrink-0 text-warning" />
      Highlighted rows are receive-only. On this radio that is stored by parking the transmit
      frequency at 0 MHz, and it is exported as CHIRP's <code>Duplex=off</code>.
    </p>
  </div>
</template>

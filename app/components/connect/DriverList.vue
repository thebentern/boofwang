<script setup lang="ts">
import type { RadioId } from '#core/model/codeplug.js'
import type { RadioSchema } from '#core/radio/schema.js'
import { RADIO_IDS, SCHEMAS, createDriver, isImplemented } from '#core/radio/registry.js'

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

interface DriverNote {
  readonly note: string
  /** Editorial facts. Each may narrow what the chip claims; none may widen it. */
  readonly facts: readonly (readonly [string, string])[]
}

const NOTES: Record<RadioId, DriverNote> = {
  uvk5: {
    note:
      'Verified against a real radio on stock firmware 2.01.32. Writing sends only the blocks that differ and ' +
      'reads each one back before sending the next. Calibration is captured in every backup and never written.',
    facts: [
      ['i-lucide-circle-check', 'Round-trip test: encode(decode(x)) === x'],
      ['i-lucide-lock', 'No transmit-inhibit bit — receive-only is transmit parked at 0 MHz'],
    ],
  },
  uv82: {
    note:
      'Read verified on firmware N822413 and cross-checked against CHIRP channel by channel. The classic UV-5R ' +
      'family protocol: plain unobfuscated blocks, and an absolute transmit frequency per channel rather than a ' +
      'shift.',
    facts: [
      ['i-lucide-circle-check', 'Matches CHIRP channel for channel'],
      ['i-lucide-lock', 'Write path not yet exercised'],
    ],
  },
  uv5rmini: {
    note:
      'A UV-17 Pro family radio despite the name: obfuscated blocks across four disjoint memory regions. Two ' +
      'different radios ship under near-identical names — "UV-5R Mini" and "5RM" — and the handshake decides ' +
      'which is on the cable. Only the UV-5R Mini has been on the cable here.',
    facts: [
      ['i-lucide-users', 'Two distinct radios share the name'],
      ['i-lucide-triangle-alert', 'The 5RM variant has never met hardware'],
    ],
  },
  dm32uv: {
    note:
      'No CHIRP driver exists for this radio. Writing is deliberately narrow — only the encryption key slots. ' +
      'Its pages move between sessions and 22 of 59 allocated blocks have no documented meaning, so every other ' +
      'byte is preserved and never sent back.',
    facts: [
      ['i-lucide-server', '59 memory pages · 22 undocumented'],
      ['i-lucide-key-round', '22 AES key slots'],
    ],
  },
}

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
    return { tone: 'dg', icon: 'i-lucide-triangle-alert', label: 'Untested on hardware' }
  }
  if (schema.status === 'planned' || !schema.capabilities.read) {
    return { tone: 'dg', icon: 'i-lucide-triangle-alert', label: 'Untested on hardware' }
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
    // The wire facts come off the driver rather than the prose, so the baud
    // rate and block size on screen are the ones the transport will open with.
    const driver = isImplemented(id) ? createDriver(id) : null
    const wire = driver
      ? [`${driver.serial.baudRate.toLocaleString()} baud · ${driver.writeBlockBytes}-byte blocks`]
      : []
    return {
      id,
      name: schema ? `${schema.vendor} ${schema.model}` : id,
      memory: memoryOf(schema),
      status: statusOf(id, schema),
      note: NOTES[id].note,
      facts: [
        ...wire.map((t) => ['i-lucide-zap', t] as const),
        ...NOTES[id].facts,
      ],
    }
  }),
)

const open = ref<RadioId | null>(null)

function toggle(id: RadioId) {
  open.value = open.value === id ? null : id
}
</script>

<template>
  <div style="border: 1px solid var(--ln); background: var(--pn); border-radius: 7px; overflow: hidden">
    <div class="flex items-center gap-2.5" style="padding: 9px 13px; border-bottom: 1px solid var(--ln)">
      <UIcon name="i-lucide-list" style="width: 13px; height: 13px; color: var(--fn)" />
      <span class="label-xs">Radios boofwang knows</span>
      <span class="ms-auto hidden sm:inline" style="font-size: 11.5px; color: var(--fn)">
        The handshake identifies which is on the cable.
      </span>
    </div>

    <div v-for="row in rows" :key="row.id">
      <button
        type="button"
        class="w-full flex items-center gap-3 text-left"
        style="height: 38px; padding: 0 13px; border-bottom: 1px solid var(--ln)"
        :style="{ background: row.id === activeRadio ? 'var(--okB)' : 'transparent' }"
        :aria-expanded="open === row.id"
        @click="toggle(row.id)"
      >
        <span
          class="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap"
          style="font-size: 12.5px; font-weight: 600; color: var(--tx)"
        >{{ row.name }}</span>
        <span
          class="font-mono tabular whitespace-nowrap hidden sm:inline"
          style="font-size: 11px; color: var(--fn)"
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
        <UIcon
          :name="open === row.id ? 'i-lucide-chevron-down' : 'i-lucide-chevron-right'"
          class="shrink-0"
          style="width: 12px; height: 12px; color: var(--fn)"
        />
      </button>

      <div
        v-if="open === row.id"
        style="padding: 0 13px 12px; border-bottom: 1px solid var(--ln); background: var(--pn2)"
      >
        <p style="margin: 0 0 8px; padding-top: 10px; font-size: 12px; line-height: 1.6; color: var(--mu); max-width: 88ch">
          {{ row.note }}
        </p>
        <div class="flex gap-3.5 flex-wrap">
          <span
            v-for="[icon, text] in row.facts"
            :key="text"
            class="flex items-center gap-1.5"
            style="font-size: 11.5px; color: var(--fn)"
          >
            <UIcon :name="icon" class="shrink-0" style="width: 12px; height: 12px" />
            {{ text }}
          </span>
        </div>
      </div>
    </div>
  </div>
</template>

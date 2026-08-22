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
 * The rows are also the chooser, which they did not used to be. This list once
 * carried a note saying "the handshake identifies what is on the cable, so the
 * rows are not choices" - and the handshake does, but only once it is talking
 * to something. Deciding *for* the user which handshake to send first meant
 * guessing, the guess was a hardcoded UV-K5, and getting it wrong looks exactly
 * like a broken cable: the port opens, the radio says nothing, and the screen
 * blames the lead.
 *
 * So the radio is picked here, by name, and nothing infers it. A driver that is
 * not implemented yet is listed but cannot be selected - it has no handshake to
 * send.
 */
defineProps<{ activeRadio?: RadioId | null; selected?: RadioId | null }>()
const emit = defineEmits<{ choose: [RadioId] }>()

type ChipTone = 'ok' | 'cn' | 'dg' | 'neutral'

/**
 * One line about what this driver does.
 *
 * Three states and no qualifiers. Everything a driver cannot reach used to be
 * spelled out here, and it grew with the driver until the chip read "Read -
 * channels and their talk groups, zones, talk groups, scan lists, RX groups,
 * contacts, text messages, roaming, emergency system names, DTMF, radio
 * settings and encryption keys only" - a sentence that pushes the radio's own
 * name off the row and, worse, opens with "Read" on a driver that writes.
 *
 * The precise scope still exists on `capabilities.writeScope`, and the restore
 * screen and the write gate both use it. That is where the question is what
 * will actually be put back. A list of radios is not.
 */
function statusOf(id: RadioId, schema: RadioSchema | null): { tone: ChipTone; icon: string; label: string } {
  if (!schema || !isImplemented(id) || schema.status === 'planned' || !schema.capabilities.read) {
    return { tone: 'neutral', icon: 'i-lucide-circle-minus', label: 'Not supported yet' }
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
      /** A row you can pick. A driver with no implementation has no handshake to send. */
      usable: isImplemented(id) && schema?.capabilities.read === true,
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
        Pick the one on your cable.
      </span>
    </div>

    <div v-for="row in rows" :key="row.id">
      <component
        :is="row.usable ? 'button' : 'div'"
        :type="row.usable ? 'button' : undefined"
        :aria-pressed="row.usable ? row.id === selected : undefined"
        :disabled="row.usable ? undefined : true"
        class="w-full flex items-center gap-3 text-start"
        :class="row.usable ? 'transition-colors cursor-pointer' : ''"
        style="height: 44px; padding: 0 15px; border-bottom: 1px solid var(--ln)"
        :style="{
          background: row.id === selected ? 'var(--acB)' : row.id === activeRadio ? 'var(--okB)' : 'transparent',
          boxShadow: row.id === selected ? 'inset 3px 0 0 var(--ac)' : 'none',
        }"
        @click="row.usable && emit('choose', row.id)"
      >
        <span
          class="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap"
          style="font-size: 14px; font-weight: 600"
          :style="{ color: row.id === selected ? 'var(--acTx)' : 'var(--tx)' }"
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
      </component>
    </div>

    <!--
      Every list of supported hardware is also a list of hardware someone owns
      and cannot use. Saying where to ask costs one row.
    -->
    <a
      href="https://github.com/thebentern/boofwang/issues/new?title=Radio%20support%3A%20&body=Which%20radio%2C%20and%20what%20programming%20software%20it%20uses%20today%3A"
      target="_blank"
      rel="noopener"
      class="w-full flex items-center gap-3"
      style="height: 44px; padding: 0 15px; color: var(--acTx)"
    >
      <UIcon name="i-lucide-plus" class="shrink-0" style="width: 14px; height: 14px" />
      <span style="font-size: 14px; font-weight: 600">Add support for your radio</span>
      <span class="hidden sm:inline" style="font-size: 13px; color: var(--fn)">
        Tell us which one, on GitHub
      </span>
      <UIcon name="i-lucide-arrow-up-right" class="ms-auto shrink-0" style="width: 14px; height: 14px" />
    </a>
  </div>
</template>

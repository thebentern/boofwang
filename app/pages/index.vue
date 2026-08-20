<script setup lang="ts">
import type { RadioCardEntry } from '~/components/RadioCard.vue'
import type { RadioId } from '#core/model/codeplug.js'
import { SCHEMAS, isImplemented } from '#core/radio/registry.js'

useSeoMeta({ title: 'Radios' })

const support = useSerialSupport()
const session = useRadioSession()
const transfer = useTransferStore()
const codeplug = useCodeplugStore()

/**
 * Capabilities come from the driver registry rather than being restated here,
 * so this page cannot advertise something the code does not do.
 */
const radios = computed<RadioCardEntry[]>(() => [
  {
    id: 'uvk5',
    vendor: 'Quansheng',
    model: 'UV-K5',
    summary: '200 channels · analog · 8 KB EEPROM',
    notes:
      'Reading is verified against a real radio on stock firmware 2.01.32. Writing sends only the blocks that differ, reads each one back before sending the next, and refuses without a backup of the same radio. Calibration is captured in every backup but never written.',
  },
  {
    id: 'uv82',
    vendor: 'Baofeng',
    model: 'UV-82',
    summary: '128 channels · analog · 6.5 KB image',
    notes:
      'Reading is verified against a real radio on firmware N822413, cross-checked against CHIRP channel by channel. The classic UV-5R family protocol: 9600 baud, plain unobfuscated blocks, and an absolute transmit frequency per channel rather than a shift.',
  },
  {
    id: 'uv5rmini',
    vendor: 'Baofeng',
    model: 'UV-5R Mini',
    summary: '999 channels · analog · 33 KB image',
    notes: 'Shares the UV-17 Pro family protocol: obfuscated 64-byte blocks across three disjoint memory regions.',
  },
  {
    id: 'dm32uv',
    vendor: 'Baofeng',
    model: 'DM-32UV',
    summary: '4000 channels · DMR · zones, talkgroups, AES keys',
    notes:
      'No CHIRP driver exists for this radio. Writing will be staged behind a dry run and per-block unlocks, because its memory pages move between reads and a bad write can brick it.',
  },
].map((r) => {
  const schema = SCHEMAS[r.id as RadioId]
  return {
    ...r,
    id: r.id as RadioId,
    implemented: isImplemented(r.id as RadioId),
    canRead: schema?.capabilities.read === true,
    canWrite: schema?.capabilities.write === true,
  }
}))

async function read(id: RadioId) {
  await session.connectAndRead(id)
  if (codeplug.isOpen) await navigateTo('/channels')
}
</script>

<template>
  <div class="mx-auto max-w-7xl px-4 py-10 space-y-10">
    <section class="space-y-4 max-w-3xl">
      <h1 class="text-3xl font-semibold tracking-tight">Program your radio from the browser</h1>
      <p class="text-muted">
        boofwang reads and writes codeplugs over your radio's programming cable using Web Serial. There is
        nothing to install and no server involved — your codeplugs never leave your machine.
      </p>
      <SerialSupportNotice :support="support" />
      <div class="flex flex-wrap items-center gap-3 pt-1">
        <OpenCodeplugButton />
        <span class="text-sm text-muted">…or read one from a radio below.</span>
      </div>
    </section>

    <section class="space-y-4">
      <h2 class="text-lg font-semibold tracking-tight">Supported radios</h2>
      <div class="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        <RadioCard
          v-for="radio in radios"
          :key="radio.id"
          :radio="radio"
          :enabled="support.supported"
          :busy="transfer.active"
          @read="read"
        />
      </div>
    </section>

    <section class="space-y-3 max-w-3xl">
      <h2 class="text-lg font-semibold tracking-tight">Before you transmit</h2>
      <UAlert
        icon="i-lucide-shield"
        color="neutral"
        variant="subtle"
        title="You are responsible for what your radio transmits"
        description="Channels marked receive-only stay receive-only: weather, marine, aviation and public-safety frequencies are never made transmit-capable on import. Transmitting outside the bands your licence covers is illegal, and where a radio cannot enforce a per-channel transmit inhibit, boofwang says so rather than quietly programming a channel you can key up."
      />
    </section>

    <TransferProgress />
  </div>
</template>

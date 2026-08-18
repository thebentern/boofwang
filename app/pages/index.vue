<script setup lang="ts">
import type { RadioCardEntry } from '~/components/RadioCard.vue'

useSeoMeta({ title: 'Radios' })

const support = useSerialSupport()

// Mirrors lib/radio/registry.ts once drivers land; for now it is the honest
// state of play, so the landing page never promises a capability that does not
// exist yet.
const radios: RadioCardEntry[] = [
  {
    id: 'uvk5',
    vendor: 'Quansheng',
    model: 'UV-K5',
    summary: '200 channels · analog · 8 KB EEPROM',
    status: 'planned',
    read: false,
    write: false,
    notes:
      'The reference implementation. Calibration data is excluded from every upload by construction, and unrecognised firmware is treated as read-only.',
  },
  {
    id: 'uv5rmini',
    vendor: 'Baofeng',
    model: 'UV-5R Mini',
    summary: '999 channels · analog · 33 KB image',
    status: 'planned',
    read: false,
    write: false,
    notes:
      'Shares the UV-17 Pro family protocol: obfuscated 64-byte blocks across three disjoint memory regions.',
  },
  {
    id: 'dm32uv',
    vendor: 'Baofeng',
    model: 'DM-32UV',
    summary: '4000 channels · DMR · zones, talkgroups, AES keys',
    status: 'planned',
    read: false,
    write: false,
    notes:
      'No CHIRP driver exists for this radio. Writing is staged behind a dry run and per-block unlocks, because its memory pages move between reads and a bad write can brick it.',
  },
]
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
    </section>

    <section class="space-y-4">
      <h2 class="text-lg font-semibold tracking-tight">Supported radios</h2>
      <div class="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        <RadioCard v-for="radio in radios" :key="radio.id" :radio="radio" :enabled="support.supported" />
      </div>
    </section>

    <section class="space-y-3 max-w-3xl">
      <h2 class="text-lg font-semibold tracking-tight">Before you transmit</h2>
      <UAlert
        icon="i-lucide-shield"
        color="neutral"
        variant="subtle"
        title="You are responsible for what your radio transmits"
        description="Presets for weather, marine, aviation and public-safety frequencies are receive-only and cannot be switched to transmit. Transmitting outside the bands your licence covers is illegal, and some radios have no per-channel transmit inhibit at all — boofwang will say so rather than quietly programming a channel you can key up."
      />
    </section>
  </div>
</template>

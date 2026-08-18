<script setup lang="ts">
useSeoMeta({ title: 'About' })

const credits = [
  {
    name: 'CHIRP',
    licence: 'GPL-3.0',
    url: 'https://chirpmyradio.com/',
    what: 'Memory layouts and protocol details for the UV-K5 and the UV-5R Mini were transcribed from its drivers (uvk5.py, baofeng_uv17Pro.py), and its stock channel configurations are the source of the bundled FRS/GMRS/MURS/weather presets.',
  },
  {
    name: 'DM-32UV Protocol Specification',
    licence: 'MIT',
    url: 'https://github.com/infamy/DM32-Protocol-Spec',
    what: 'The only public documentation of the DM-32UV serial protocol and memory layout. Everything boofwang knows about that radio starts here.',
  },
  {
    name: 'UV-K5 reverse engineering notes',
    licence: 'CC-BY-SA-4.0',
    url: 'https://github.com/sq5bpf/uvk5-reverse-engineering',
    what: 'Jacek Lipkowski SQ5BPF’s original work on the UV-K5 framing, obfuscation and EEPROM map.',
  },
]
</script>

<template>
  <div class="mx-auto max-w-3xl px-4 py-10 space-y-10">
    <section class="space-y-3">
      <h1 class="text-3xl font-semibold tracking-tight">About boofwang</h1>
      <p class="text-muted">
        A codeplug editor and programmer that runs entirely in your browser. It speaks to radios over the
        Web Serial API, so there is no desktop application to install and no account to create.
      </p>
    </section>

    <section class="space-y-3">
      <h2 class="text-lg font-semibold tracking-tight">Where your data goes</h2>
      <p class="text-sm text-muted">
        Nowhere. boofwang is a static site: there is no backend, no analytics and no upload endpoint.
        Codeplugs you read from a radio are held in your browser’s local storage and in files you
        explicitly save. Encryption keys you enter are treated the same way — which also means that
        anyone with access to your browser profile or to an exported file can read them.
      </p>
    </section>

    <section class="space-y-3">
      <h2 class="text-lg font-semibold tracking-tight">Licence</h2>
      <p class="text-sm text-muted">
        boofwang is free software licensed under the
        <a
          class="underline underline-offset-2"
          href="https://www.gnu.org/licenses/gpl-3.0.html"
          target="_blank"
          rel="noopener"
          >GNU General Public License, version 3 or later</a
        >. It comes with absolutely no warranty. Programming a radio incorrectly can render it unusable;
        always keep a backup you have verified you can restore.
      </p>
    </section>

    <section class="space-y-4">
      <h2 class="text-lg font-semibold tracking-tight">Credits</h2>
      <p class="text-sm text-muted">
        boofwang would not exist without the people who reverse-engineered these radios and published what
        they found.
      </p>
      <div class="space-y-3">
        <UCard v-for="c in credits" :key="c.name" :ui="{ body: 'space-y-1.5' }">
          <div class="flex items-center gap-2">
            <a class="font-medium underline underline-offset-2" :href="c.url" target="_blank" rel="noopener">
              {{ c.name }}
            </a>
            <UBadge :label="c.licence" color="neutral" variant="subtle" size="sm" />
          </div>
          <p class="text-sm text-muted">{{ c.what }}</p>
        </UCard>
      </div>
    </section>

    <section class="space-y-3">
      <h2 class="text-lg font-semibold tracking-tight">Not affiliated</h2>
      <p class="text-sm text-muted">
        boofwang is an independent project. It is not affiliated with, endorsed by, or supported by
        Baofeng, Quansheng, or the CHIRP project. Radio model names are used only to identify the hardware
        each driver targets.
      </p>
    </section>
  </div>
</template>

<script setup lang="ts">
/**
 * browser ───── adapter ──✕── radio, on one line.
 *
 * Three things sit between a person and their codeplug, and when one of them
 * fails the useful question is which. The old interface answered "could not
 * read the radio" for a browser without Web Serial, a cable that was not
 * plugged in, and a radio that was switched off - three different problems with
 * three different remedies and one message.
 *
 * Drawn only while something is wrong or in flight. A topology diagram of a
 * working connection is decoration; the same diagram with a cross in it is a
 * diagnosis, and rendering it on the healthy path would spend the reader's
 * attention on it every visit until it stopped meaning anything.
 *
 * The links are mono glyphs rather than borders or SVG so the trail survives
 * being pasted into a bug report as text, and so its meaning does not rest on
 * colour: a dashed run reads as "not started" and a cross as "broken" in a
 * screenshot, in print, and to someone who cannot separate amber from green.
 *
 * The topology is fixed and written out rather than looped, because there is no
 * fourth hop to generalise for and three named spans read better than a loop
 * over a discriminated union.
 */
export type HopTone = 'ok' | 'cn' | 'dg' | 'in' | 'neutral'
export type HopLink = 'ok' | 'work' | 'bad' | 'warn' | 'none'

const props = withDefaults(
  defineProps<{
    /** The browser itself, which is only the broken hop when Web Serial is missing. */
    browser?: HopTone
    adapter: HopTone
    radio: HopTone
    links: readonly [HopLink, HopLink]
  }>(),
  { browser: 'ok' },
)

const TONES: Record<HopTone, { border: string; background: string; color: string }> = {
  ok: { border: 'var(--okL)', background: 'var(--okB)', color: 'var(--ok)' },
  cn: { border: 'var(--cnL)', background: 'var(--cnB)', color: 'var(--cn)' },
  dg: { border: 'var(--dgL)', background: 'var(--dgB)', color: 'var(--dg)' },
  in: { border: 'var(--inL)', background: 'var(--inB)', color: 'var(--in)' },
  neutral: { border: 'var(--ln)', background: 'var(--pn2)', color: 'var(--fn)' },
}

/** A link in progress is still a link: solid, and coloured as informational. */
const LINK_COLOURS: Record<HopLink, string> = {
  ok: 'var(--ok)',
  work: 'var(--in)',
  bad: 'var(--dg)',
  warn: 'var(--cn)',
  none: 'var(--fn)',
}

const LINK_GLYPHS: Record<HopLink, string> = {
  ok: '─────',
  work: '─────',
  warn: '─────',
  bad: '──✕──',
  none: '╌╌╌╌╌',
}

const LINK_WORDS: Record<HopLink, string> = {
  ok: 'established',
  work: 'in progress',
  warn: 'established, with a mismatch',
  bad: 'broken',
  none: 'not started',
}

function chip(tone: HopTone) {
  const t = TONES[tone]
  return { border: `1px solid ${t.border}`, background: t.background, color: t.color }
}

const firstLink = computed(() => props.links[0])
const secondLink = computed(() => props.links[1])

/**
 * The glyphs carry no text, so the trail is announced as one image. Read out
 * hop by hop it would be five fragments with the break buried in the middle.
 */
const description = computed(
  () =>
    `Connection trail: browser to adapter ${LINK_WORDS[props.links[0]]}, ` +
    `adapter to radio ${LINK_WORDS[props.links[1]]}.`,
)
</script>

<template>
  <div class="flex items-center flex-wrap" role="img" :aria-label="description">
    <span
      class="inline-flex items-center gap-1.5 whitespace-nowrap"
      style="font-size: 11px; padding: 3px 8px; border-radius: 5px"
      :style="chip(browser)"
    >
      <UIcon name="i-lucide-laptop" style="width: 11px; height: 11px" />
      browser
    </span>

    <span
      aria-hidden="true"
      class="font-mono px-[3px]"
      style="font-size: 11px"
      :style="{ color: LINK_COLOURS[firstLink] }"
    >{{ LINK_GLYPHS[firstLink] }}</span>

    <span
      class="inline-flex items-center gap-1.5 whitespace-nowrap"
      style="font-size: 11px; padding: 3px 8px; border-radius: 5px"
      :style="chip(adapter)"
    >
      <UIcon name="i-lucide-usb" style="width: 11px; height: 11px" />
      adapter
    </span>

    <span
      aria-hidden="true"
      class="font-mono px-[3px]"
      style="font-size: 11px"
      :style="{ color: LINK_COLOURS[secondLink] }"
    >{{ LINK_GLYPHS[secondLink] }}</span>

    <span
      class="inline-flex items-center gap-1.5 whitespace-nowrap"
      style="font-size: 11px; padding: 3px 8px; border-radius: 5px"
      :style="chip(radio)"
    >
      <UIcon name="i-lucide-radio-tower" style="width: 11px; height: 11px" />
      radio
    </span>
  </div>
</template>

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
 *
 * Over Bluetooth the middle hop is not an adapter - there is no cable and no
 * USB-serial chip, which is the entire point of the feature. It is still a hop
 * worth naming, because it is still where things break: the browser's Bluetooth
 * stack, the machine's radio, and the pairing all sit between the page and the
 * handset. So the middle chip changes what it is rather than disappearing, and
 * the trail stays three wide.
 *
 * A dongle session puts a physical middle hop back: a BLE-to-serial bridge
 * clipped onto the radio's programming port, reached over Bluetooth. The
 * chip names it, because "check the dongle" and "check the pairing" are
 * different first moves.
 */
export type HopTone = 'ok' | 'cn' | 'dg' | 'in' | 'neutral'
export type HopLink = 'ok' | 'work' | 'bad' | 'warn' | 'none'
export type HopVia = 'adapter' | 'bluetooth' | 'dongle'

const props = withDefaults(
  defineProps<{
    /** The browser itself, which is only the broken hop when the API is missing. */
    browser?: HopTone
    adapter: HopTone
    radio: HopTone
    links: readonly [HopLink, HopLink]
    /** What the middle hop is: a programming cable, or a Bluetooth link. */
    via?: HopVia
  }>(),
  { browser: 'ok', via: 'adapter' },
)

/**
 * Both icon names are written out as literals so the client-bundle scanner can
 * see them. An icon that arrives only as a computed string renders as a gap,
 * which on a diagram reads as a missing hop.
 */
const MIDDLE: Record<HopVia, { label: string; icon: string }> = {
  adapter: { label: 'adapter', icon: 'i-lucide-usb' },
  bluetooth: { label: 'bluetooth', icon: 'i-lucide-signal' },
  dongle: { label: 'dongle', icon: 'i-lucide-bluetooth' },
}

const middle = computed(() => MIDDLE[props.via])

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
    `Connection trail: browser to ${middle.value.label} ${LINK_WORDS[props.links[0]]}, ` +
    `${middle.value.label} to radio ${LINK_WORDS[props.links[1]]}.`,
)
</script>

<template>
  <div class="flex items-center flex-wrap" role="img" :aria-label="description">
    <span
      class="inline-flex items-center gap-1.5 whitespace-nowrap"
      style="font-size: 12.5px; padding: 3px 8px; border-radius: 5px"
      :style="chip(browser)"
    >
      <UIcon name="i-lucide-laptop" style="width: 11px; height: 11px" />
      browser
    </span>

    <span
      aria-hidden="true"
      class="font-mono px-[3px]"
      style="font-size: 12.5px"
      :style="{ color: LINK_COLOURS[firstLink] }"
    >{{ LINK_GLYPHS[firstLink] }}</span>

    <span
      class="inline-flex items-center gap-1.5 whitespace-nowrap"
      style="font-size: 12.5px; padding: 3px 8px; border-radius: 5px"
      :style="chip(adapter)"
    >
      <UIcon :name="middle.icon" style="width: 11px; height: 11px" />
      {{ middle.label }}
    </span>

    <span
      aria-hidden="true"
      class="font-mono px-[3px]"
      style="font-size: 12.5px"
      :style="{ color: LINK_COLOURS[secondLink] }"
    >{{ LINK_GLYPHS[secondLink] }}</span>

    <span
      class="inline-flex items-center gap-1.5 whitespace-nowrap"
      style="font-size: 12.5px; padding: 3px 8px; border-radius: 5px"
      :style="chip(radio)"
    >
      <UIcon name="i-lucide-radio-tower" style="width: 11px; height: 11px" />
      radio
    </span>
  </div>
</template>

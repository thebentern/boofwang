<script setup lang="ts">
import type { RadioId } from '#core/model/codeplug.js'

/**
 * The healthy state: one line and one button.
 *
 * `navigator.serial.getPorts()` hands back every port already granted to this
 * origin without asking anyone to click anything, so on a return visit the
 * working case is known before the page has finished painting. Nothing is left
 * to decide, and the landing page that used to sell the tool - a headline, a
 * paragraph and four radio cards - was four screens of scrolling in front of a
 * button whose answer was already yes.
 *
 * What is *not* known from a granted port is which radio is on the far end of
 * it: Web Serial reports a USB-serial bridge, and a CH340 is in countless
 * unrelated devices. So the model is a choice until a handshake has confirmed
 * it, and the card says which of the two it is showing rather than presenting a
 * guess as a fact.
 */
const props = defineProps<{
  /** The radio the read will use: identified if `confirmed`, otherwise chosen. */
  radioId: RadioId
  title: string
  /** Mono sub-line: firmware when known, then the adapter. */
  detail: string
  /** True once a handshake has actually named the radio on the cable. */
  confirmed: boolean
  options: readonly { id: RadioId; label: string }[]
  busy?: boolean
}>()

const emit = defineEmits<{ read: []; otherPort: []; choose: [RadioId] }>()

const items = computed(() =>
  props.options.map((o) => ({
    label: o.label,
    icon: o.id === props.radioId ? 'i-lucide-circle-check' : 'i-lucide-radio',
    onSelect: () => emit('choose', o.id),
  })),
)
</script>

<template>
  <div style="border: 1px solid var(--okL); background: var(--pn); border-radius: 8px; padding: 19px 21px">
    <div class="flex items-center gap-3.5 flex-wrap">
      <span
        class="flex items-center justify-center shrink-0"
        style="width: 32px; height: 32px; border-radius: 7px; border: 1px solid var(--okL); background: var(--okB)"
      >
        <UIcon name="i-lucide-radio" style="width: 17px; height: 17px; color: var(--ok)" />
      </span>

      <div class="min-w-0">
        <div v-if="confirmed" style="font-size: 17.5px; font-weight: 600; letter-spacing: -0.015em; line-height: 1.3">
          {{ title }}
        </div>
        <!--
          The name doubles as the picker while it is still a choice. Putting the
          control anywhere else would mean two places to look for the same fact,
          and it disappears the moment the handshake settles the question.
        -->
        <UDropdownMenu v-else :items="items" :ui="{ content: 'w-56' }">
          <button
            type="button"
            class="flex items-center gap-1.5 rounded-[5px] -mx-1 px-1 text-left"
            style="font-size: 17.5px; font-weight: 600; letter-spacing: -0.015em; line-height: 1.3; color: var(--tx)"
          >
            {{ title }}
            <UIcon name="i-lucide-chevron-down" style="width: 14px; height: 14px; color: var(--fn)" />
          </button>
        </UDropdownMenu>

        <div class="font-mono tabular mt-0.5" style="font-size: 13px; color: var(--fn)">{{ detail }}</div>
      </div>

      <div class="ms-auto flex items-center gap-2.5">
        <RiskAction
          risk="safe"
          size="lg"
          label="Read the radio"
          icon="i-lucide-download"
          :loading="busy"
          @click="emit('read')"
        />
        <RiskAction risk="neutral" ghost label="Other port" :disabled="busy" @click="emit('otherPort')" />
      </div>
    </div>

    <div class="flex items-center gap-2 mt-[11px] pt-[11px]" style="border-top: 1px solid var(--ln)">
      <UIcon name="i-lucide-circle-check" class="shrink-0" style="width: 13px; height: 13px; color: var(--ok)" />
      <span style="font-size: 13.5px; color: var(--mu)">
        Reading changes nothing on the radio and saves a backup before you edit anything.
      </span>
    </div>
  </div>
</template>

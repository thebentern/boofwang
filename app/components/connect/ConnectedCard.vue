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
/**
 * On a phone the identity lines split and the actions stack.
 *
 * `detail` is one middot-joined string - firmware, adapter, and whether the
 * model is confirmed - which is right for a desktop line with room for it and
 * clips mid-word at 375px. The parts are already separate before they are
 * joined, so the phone takes them apart again rather than truncating.
 *
 * The actions stop being a right-aligned row for the same reason: three
 * buttons side by side on a phone are three buttons nobody can read the labels
 * of.
 */
const phone = ref(false)
function measure() {
  phone.value = window.innerWidth < 640
}
onMounted(() => {
  measure()
  window.addEventListener('resize', measure)
})
onBeforeUnmount(() => window.removeEventListener('resize', measure))

const props = defineProps<{
  /**
   * The radio the read will use: identified if `confirmed`, otherwise chosen.
   * Null until the user has picked one - this screen does not guess.
   */
  radioId: RadioId | null
  title: string
  /** Mono sub-line: firmware when known, then the adapter. */
  detail: string
  /** True once a handshake has actually named the radio on the cable. */
  confirmed: boolean
  options: readonly { id: RadioId; label: string }[]
  busy?: boolean
  /**
   * Whether this radio can also be reached over Bluetooth.
   *
   * A granted cable used to hide that question entirely: `hasPort` goes true
   * for any adapter and never goes back, so this card was the end of the road
   * and the one radio with a wireless profile had nowhere to be reached from.
   */
  bluetooth?: boolean
  /**
   * What the wireless button calls its route.
   *
   * 'Bluetooth' for a radio with its own module; the connect screen passes
   * 'Bluetooth dongle' for a cable-only radio reached through a clip-on
   * bridge, because calling that radio a Bluetooth radio would be the card
   * claiming something the hardware does not have.
   */
  bluetoothLabel?: string
}>()

const emit = defineEmits<{ read: []; otherPort: []; choose: [RadioId]; bluetooth: [] }>()

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
            style="font-size: 17.5px; font-weight: 600; letter-spacing: -0.015em; line-height: 1.3"
            :style="{ color: radioId ? 'var(--tx)' : 'var(--acTx)' }"
          >
            {{ title }}
            <UIcon name="i-lucide-chevron-down" style="width: 14px; height: 14px; color: var(--fn)" />
          </button>
        </UDropdownMenu>

        <div v-if="!phone" class="font-mono tabular mt-0.5" style="font-size: 13px; color: var(--fn)">{{ detail }}</div>
        <div v-else class="font-mono tabular" style="font-size: 12.5px; color: var(--fn)">
          <span v-for="part in detail.split(' · ')" :key="part" class="block" style="margin-top: 3px">{{ part }}</span>
        </div>
      </div>

      <div :class="phone ? 'w-full mt-3' : 'ms-auto flex items-center gap-2.5'">
        <RiskAction
          :class="phone ? 'w-full justify-center' : ''"
          :style="phone ? { height: '48px', borderRadius: '8px', fontSize: '15px' } : undefined"
          risk="safe"
          size="lg"
          :label="radioId ? 'Read the radio' : 'Choose your radio first'"
          icon="i-lucide-download"
          :loading="busy"
          :disabled="!radioId"
          @click="emit('read')"
        />
        <div :class="phone ? 'flex gap-2 mt-2' : 'contents'">
        <RiskAction
          :class="phone ? 'flex-1 justify-center' : ''"
          :style="phone ? { height: '44px', borderRadius: '8px' } : undefined"
          risk="neutral"
          ghost
          label="Other port"
          :disabled="busy"
          @click="emit('otherPort')"
        />
        <!--
          Ghost and last, for the same reason it is ghost on the fault cards:
          the cable is the route that has been proved, and this card exists
          because it is already working.
        -->
        <RiskAction
          v-if="bluetooth"
          :class="phone ? 'flex-1 justify-center' : ''"
          :style="phone ? { height: '44px', borderRadius: '8px' } : undefined"
          risk="neutral"
          ghost
          :label="bluetoothLabel ?? 'Bluetooth'"
          icon="i-lucide-bluetooth"
          :disabled="busy"
          @click="emit('bluetooth')"
        />
        </div>
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

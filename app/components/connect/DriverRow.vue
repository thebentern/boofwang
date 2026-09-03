<script setup lang="ts">
import type { RadioId } from '#core/model/codeplug.js'

/**
 * One radio in the chooser.
 *
 * Split out of `DriverList` because the same row is rendered twice: once in a
 * flat list where a cable is a route, and once inside three groups where it is
 * not. Two copies of this markup would drift, and the half that drifts is the
 * one nobody has a device to look at.
 *
 * It carries the three things that separate one radio from another - what it
 * is, how you reach it, and the one odd thing about it if there is one - and
 * deliberately no capability chip. All five read and write, so a per-row chip
 * said the same thing five times and stopped being read, which is the exact
 * failure `DriverList`'s header comment records about the matrix before it.
 */
const props = withDefaults(
  defineProps<{
    row: {
      id: RadioId
      name: string
      memory: string
      wireless: boolean
      dongle: boolean
      caveat: string
      usable: boolean
    }
    selected?: RadioId | null
    activeRadio?: RadioId | null
    /** A radio this device cannot reach at all. Rendered, never offered. */
    dimmed?: boolean
    /** Last in its container, so the hairline is left off. */
    last?: boolean
  }>(),
  { selected: null, activeRadio: null, dimmed: false, last: false },
)

const emit = defineEmits<{ choose: [RadioId] }>()

/**
 * A dimmed row is not a choice.
 *
 * On a device with no cable the three cabled radios are listed so somebody
 * knows boofwang speaks them, not so they can be picked - selecting one would
 * arm a handshake that has no route to travel down.
 */
const pickable = computed(() => props.row.usable && !props.dimmed)

const isSelected = computed(() => props.row.id === props.selected)
</script>

<template>
  <component
    :is="pickable ? 'button' : 'div'"
    :type="pickable ? 'button' : undefined"
    :aria-pressed="pickable ? isSelected : undefined"
    :disabled="pickable ? undefined : true"
    class="w-full text-start"
    :class="pickable ? 'transition-colors cursor-pointer' : ''"
    style="display: grid; grid-template-columns: 1fr auto; column-gap: 10px; align-items: start; padding: 12px 14px"
    :style="{
      borderBottom: last ? 'none' : '1px solid var(--ln)',
      background: isSelected ? 'var(--acB)' : row.id === activeRadio ? 'var(--okB)' : 'transparent',
      boxShadow: isSelected ? 'inset 3px 0 0 var(--ac)' : 'none',
    }"
    @click="pickable && emit('choose', row.id)"
  >
    <span class="min-w-0">
      <span
        class="block overflow-hidden text-ellipsis whitespace-nowrap"
        style="font-size: 15.5px; font-weight: 600; letter-spacing: -0.01em"
        :style="{ color: dimmed ? 'var(--fn)' : isSelected ? 'var(--acTx)' : 'var(--tx)' }"
      >{{ row.name }}</span>

      <span
        class="block font-mono tabular"
        style="font-size: 12px; margin-top: 3px"
        :style="{ color: dimmed ? '#7b8894' : 'var(--fn)' }"
      >{{ row.memory }}</span>

      <!--
        No reach chips on a row this device cannot reach: the group heading has
        already said so once, and repeating it per row is the badge-on-every-row
        this list exists to avoid.
      -->
      <span v-if="!dimmed" class="flex flex-wrap" style="gap: 6px; margin-top: 7px">
        <span
          class="inline-flex items-center"
          style="gap: 4px; font-size: 11.5px; padding: 2px 7px; border-radius: 4px; background: var(--pn3); color: var(--mu)"
        >
          <UIcon name="i-lucide-cable" style="width: 11px; height: 11px; color: var(--fn)" />
          cable
        </span>
        <span
          v-if="row.wireless"
          class="inline-flex items-center"
          style="gap: 4px; font-size: 11.5px; padding: 2px 7px; border-radius: 4px; background: var(--pn3); color: var(--mu)"
          title="This radio has a Bluetooth module of its own."
        >
          <UIcon name="i-lucide-bluetooth" style="width: 11px; height: 11px; color: var(--fn)" />
          bluetooth
        </span>
        <span
          v-else-if="row.dongle"
          class="inline-flex items-center"
          style="gap: 4px; font-size: 11.5px; padding: 2px 7px; border-radius: 4px; background: var(--pn3); color: var(--mu)"
          title="Its programming port takes a clip-on Bluetooth dongle."
        >
          <UIcon name="i-lucide-bluetooth" style="width: 11px; height: 11px; color: var(--fn)" />
          dongle
        </span>
      </span>

      <span
        v-if="row.caveat && !dimmed"
        class="block"
        style="font-size: 12px; line-height: 1.45; color: var(--fn); margin-top: 7px"
      >{{ row.caveat }}</span>
    </span>

    <UIcon
      v-if="!dimmed"
      :name="isSelected ? 'i-lucide-circle-check' : 'i-lucide-chevron-right'"
      :style="{
        width: '17px',
        height: '17px',
        marginTop: '2px',
        color: isSelected ? 'var(--ac)' : 'var(--ln2)',
      }"
    />
  </component>
</template>

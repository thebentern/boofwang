<script setup lang="ts">
/**
 * One button that knows what its action costs.
 *
 * The risk register is the spine of the interface: every action belongs to
 * exactly one level, and the level decides the icon, the colour, the button
 * weight and what the confirmation costs. Putting that in one component is what
 * stops it drifting per screen - which is how the old UI ended up with reading
 * a radio and overwriting one looking identical.
 *
 * Colour is never the only carrier. The default icon and the verb change too,
 * so the level survives being printed, screenshotted, or read by someone who
 * cannot distinguish amber from green.
 */
export type Risk = 'safe' | 'caution' | 'destructive' | 'neutral'

const props = withDefaults(
  defineProps<{
    risk?: Risk
    label?: string
    icon?: string
    disabled?: boolean
    loading?: boolean
    /** Ghost styling: same register, no fill. For the secondary action in a pair. */
    ghost?: boolean
    size?: 'sm' | 'md' | 'lg'
    type?: 'button' | 'submit'
  }>(),
  { risk: 'neutral', size: 'md', type: 'button', label: '', icon: undefined },
)

const emit = defineEmits<{ click: [MouseEvent] }>()

/** The icon each level carries when the caller does not name one. */
const DEFAULT_ICON: Record<Risk, string> = {
  safe: 'i-lucide-circle-check',
  caution: 'i-lucide-triangle-alert',
  destructive: 'i-lucide-circle-x',
  neutral: '',
}

const HEIGHT = { sm: '23px', md: '29px', lg: '32px' } as const

const resolvedIcon = computed(() => props.icon ?? DEFAULT_ICON[props.risk] ?? '')

/**
 * Safe is the only level that gets a solid fill.
 *
 * Caution and destructive are tinted rather than solid on purpose: a big solid
 * red button invites the muscle memory of clicking the bright thing, and both
 * of those levels want a beat of hesitation instead.
 */
const styles = computed(() => {
  if (props.disabled) {
    return { background: 'transparent', color: 'var(--fn)', border: '1px solid var(--ln)' }
  }
  if (props.ghost) {
    const tone = { safe: 'var(--ok)', caution: 'var(--cn)', destructive: 'var(--dg)', neutral: 'var(--mu)' }
    return { background: 'transparent', color: tone[props.risk], border: '1px solid var(--ln2)' }
  }
  switch (props.risk) {
    case 'safe':
      return { background: 'var(--ok)', color: 'var(--okT)', border: '1px solid var(--ok)' }
    case 'caution':
      return { background: 'var(--cnB)', color: 'var(--cn)', border: '1px solid var(--cnL)' }
    case 'destructive':
      return { background: 'var(--dgB)', color: 'var(--dg)', border: '1px solid var(--dgL)' }
    default:
      return { background: 'var(--sd)', color: 'var(--sdT)', border: '1px solid var(--sd)' }
  }
})
</script>

<template>
  <button
    :type="type"
    :disabled="disabled || loading"
    :data-risk="risk"
    class="inline-flex items-center gap-1.5 rounded-[5px] px-3 font-medium transition-colors disabled:cursor-not-allowed"
    :style="{ ...styles, height: HEIGHT[size], fontSize: size === 'sm' ? '11.5px' : '12.5px' }"
    @click="emit('click', $event)"
  >
    <UIcon v-if="loading" name="i-lucide-loader-circle" class="size-3.5 animate-spin shrink-0" />
    <UIcon v-else-if="resolvedIcon" :name="resolvedIcon" class="size-3.5 shrink-0" />
    <span v-if="label">{{ label }}</span>
    <slot />
  </button>
</template>

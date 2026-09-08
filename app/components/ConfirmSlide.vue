<script setup lang="ts">
/**
 * A confirmation you have to drag.
 *
 * This is the one confirmation control, on every screen and at every width.
 * It began as the phone form only: typing a word was kept on the desktop as the
 * better friction, and the drag went in where a keyboard would cover the diff
 * that justifies the action. The typed form was then retired everywhere, on the
 * grounds that the friction is the point rather than the typing, and one gate
 * that behaves the same on every screen is easier to trust than two.
 *
 * What it keeps, and why each part matters:
 *
 * - The hand has to travel the full width and stay down for the whole trip. A
 *   tap cannot do it and neither can a flick, which is what separates this from
 *   a button with a confirmation dialog behind it.
 * - Released short of the end, it springs back and sends nothing. There is no
 *   "near enough".
 * - The label says the verb and the amount, so what is being agreed to is under
 *   the thumb rather than above it.
 *
 * Pointer events, not touch events, so a desktop mouse and a stylus behave the
 * same way and the component is testable without a touch harness.
 */
const props = withDefaults(
  defineProps<{
    /** The verb and its object, e.g. "Slide to send 1 change". Read aloud too. */
    label: string
    /** Risk level of the action; drives the fill and the handle. */
    risk?: 'caution' | 'destructive'
    disabled?: boolean
    loading?: boolean
    icon?: string
    /** What the track says while `loading`. "Sending" fits a write; an update is not sent. */
    busyLabel?: string
  }>(),
  { risk: 'caution', icon: 'i-lucide-upload', busyLabel: 'Sending' },
)

const emit = defineEmits<{ confirm: [] }>()

const track = ref<HTMLElement | null>(null)
/** 0 to 1. Drives the handle, the fill and nothing else. */
const progress = ref(0)
const dragging = ref(false)
const sent = ref(false)

const HANDLE = 46
/** How far along counts as the end. Not 1: the last pixel is unreachable. */
const COMMIT = 0.97

const live = computed(() => !props.disabled && !props.loading && !sent.value)

/*
 * The accent the fill and handle take. Deliberately read from the risk level
 * rather than hardcoded, so the caution and destructive forms cannot drift from
 * the rest of the register.
 */
const tone = computed(() => (props.risk === 'destructive' ? 'dg' : 'cn'))

function widthOf(): number {
  const el = track.value
  return el ? Math.max(1, el.clientWidth - HANDLE) : 1
}

function moveTo(clientX: number) {
  const el = track.value
  if (!el) return
  const left = el.getBoundingClientRect().left
  progress.value = Math.min(1, Math.max(0, (clientX - left - HANDLE / 2) / widthOf()))
}

function down(e: PointerEvent) {
  if (!live.value) return
  dragging.value = true
  ;(e.target as HTMLElement).setPointerCapture?.(e.pointerId)
  moveTo(e.clientX)
}

function move(e: PointerEvent) {
  if (!dragging.value || !live.value) return
  moveTo(e.clientX)
}

function up() {
  if (!dragging.value) return
  dragging.value = false
  if (progress.value >= COMMIT && live.value) {
    // Latched rather than reset: the transfer is starting and a second drag
    // must not be able to start a second one.
    sent.value = true
    progress.value = 1
    emit('confirm')
    return
  }
  progress.value = 0
}

/*
 * A keyboard route, because a slider that only answers to a pointer is a
 * control somebody cannot reach. End (or ArrowRight held to the end) commits,
 * which keeps the "travel the whole way" property rather than making Enter a
 * one-key bypass of the friction this component exists to add.
 */
function key(e: KeyboardEvent) {
  if (!live.value) return
  const step = 0.25
  if (e.key === 'ArrowRight') progress.value = Math.min(1, progress.value + step)
  else if (e.key === 'ArrowLeft') progress.value = Math.max(0, progress.value - step)
  else if (e.key === 'End') progress.value = 1
  else if (e.key === 'Home') progress.value = 0
  else return
  e.preventDefault()
  if (progress.value >= COMMIT) {
    sent.value = true
    emit('confirm')
  }
}

/** Let a reused flow put the handle back. */
defineExpose({ reset: () => ((progress.value = 0), (sent.value = false), (dragging.value = false)) })
</script>

<template>
  <!--
    Capped in width. On a phone the card is narrower than this and the track
    fills it; on a desktop a track the width of the page would be a very long
    drag for the same decision, and the cap keeps the handle's travel within
    one comfortable sweep of a mouse.
  -->
  <div style="max-width: 480px">
    <div
      ref="track"
      role="slider"
      :aria-label="label"
      :aria-valuemin="0"
      :aria-valuemax="100"
      :aria-valuenow="Math.round(progress * 100)"
      :aria-disabled="!live"
      :tabindex="live ? 0 : -1"
      class="relative select-none overflow-hidden"
      style="height: 52px; border-radius: 8px"
      :style="{
        background: live ? `var(--${tone}B)` : 'var(--pn2)',
        border: `1px solid var(--${live ? tone : 'ln'})`,
        cursor: live ? 'grab' : 'not-allowed',
      }"
      @keydown="key"
    >
      <!-- The fill trails the handle so the distance traveled is visible, not just implied. -->
      <div
        class="absolute inset-y-0 left-0"
        :style="{
          width: `${progress * 100}%`,
          background: `var(--${tone}L)`,
          transition: dragging ? 'none' : 'width 160ms ease-out',
        }"
      />

      <span
        class="absolute inset-0 flex items-center justify-center pointer-events-none text-center px-12"
        style="font-size: 15px; font-weight: 500"
        :style="{ color: live ? `var(--${tone})` : 'var(--fn)', opacity: 1 - progress * 0.85 }"
      >{{ loading ? busyLabel : label }}</span>

      <div
        class="absolute top-1/2 flex items-center justify-center"
        :style="{
          width: `${HANDLE}px`,
          height: `${HANDLE}px`,
          left: `calc(${progress} * (100% - ${HANDLE}px))`,
          transform: 'translateY(-50%)',
          borderRadius: '7px',
          background: live ? `var(--${tone})` : 'var(--ln)',
          transition: dragging ? 'none' : 'left 160ms ease-out',
          touchAction: 'none',
        }"
        @pointerdown="down"
        @pointermove="move"
        @pointerup="up"
        @pointercancel="up"
      >
        <UIcon
          :name="loading ? 'i-lucide-loader-circle' : icon"
          :class="loading ? 'animate-spin' : ''"
          style="width: 19px; height: 19px"
          :style="{ color: risk === 'destructive' ? 'var(--sd)' : 'var(--okT)' }"
        />
      </div>
    </div>

    <p class="mt-2 text-[12px]" style="color: var(--fn)">
      <slot name="hint">Drag the handle all the way across. Let go early and nothing happens.</slot>
    </p>

    <!-- The way out, below the track so it can never be mistaken for the way in. -->
    <div v-if="$slots.secondary" class="flex items-center gap-2 flex-wrap mt-3">
      <slot name="secondary" />
    </div>
  </div>
</template>

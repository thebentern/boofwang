<script setup lang="ts">
import {
  BOOT_IMAGE_HEIGHT,
  BOOT_IMAGE_WIDTH,
  DEFAULT_FRAMING,
  cropRect,
  decodeBootImage,
  encodeBootImage,
  type CropFraming,
} from '#core/io/boot-image.js'

/**
 * Choose a picture, frame it, and see what the radio will actually show.
 *
 * The preview is rendered from the **encoded bytes**, not from the source file.
 * That is the whole point of it. A channel order or byte order mistake produces
 * a picture that is correctly framed, correctly shaped and perfectly legible,
 * with only the colours wrong - which is exactly how this codebase shipped
 * BGR565 for a while and only caught it by writing a colour chart to a radio
 * and looking at the panel. A preview drawn from the source file would have
 * looked right the entire time.
 *
 * The browser decodes the JPEG or PNG, because `lib/` may not touch the DOM and
 * the only image decoder available is the one behind `<canvas>`. Everything
 * after that - the crop, the resample, the 16-bit packing - is `lib/io`.
 */
const emit = defineEmits<{ picture: [Uint8Array | null] }>()

const source = shallowRef<ImageBitmap | HTMLImageElement | null>(null)
const sourceName = ref('')
const sourceSize = ref({ width: 0, height: 0 })
const framing = ref<CropFraming>({ ...DEFAULT_FRAMING })
const encoded = shallowRef<Uint8Array | null>(null)
const fileInput = useTemplateRef<HTMLInputElement>('fileInput')
const previewCanvas = useTemplateRef<HTMLCanvasElement>('previewCanvas')
const stageCanvas = useTemplateRef<HTMLCanvasElement>('stageCanvas')
const dragging = ref(false)

const hasPicture = computed(() => source.value !== null)

async function onPick(event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0]
  if (!file) return
  try {
    // `createImageBitmap` handles JPEG, PNG, GIF, WebP and anything else the
    // browser can decode, which is a longer list than any decoder shipped here
    // would be and does not cost a dependency.
    const bitmap = await createImageBitmap(file)
    source.value = bitmap
    sourceSize.value = { width: bitmap.width, height: bitmap.height }
    sourceName.value = file.name
    framing.value = { ...DEFAULT_FRAMING }
    await nextTick()
    render()
  } catch {
    sourceName.value = ''
    source.value = null
    emit('picture', null)
  }
}

/**
 * Draw the framed crop at the radio's size, encode it, and draw it back.
 *
 * The round trip through `encodeBootImage` and `decodeBootImage` is deliberate
 * and is not wasted work: what appears on screen is what 153,600 bytes of the
 * radio's own format decode to, five and six bits per channel included. A
 * gradient that banks visibly here will band on the radio too.
 */
function render() {
  const img = source.value
  const stage = stageCanvas.value
  const preview = previewCanvas.value
  if (!img || !stage || !preview) return

  const rect = cropRect(sourceSize.value.width, sourceSize.value.height, framing.value)
  const sctx = stage.getContext('2d', { willReadFrequently: true })
  if (!sctx) return
  sctx.clearRect(0, 0, BOOT_IMAGE_WIDTH, BOOT_IMAGE_HEIGHT)
  sctx.drawImage(
    img as CanvasImageSource,
    rect.x, rect.y, rect.width, rect.height,
    0, 0, BOOT_IMAGE_WIDTH, BOOT_IMAGE_HEIGHT,
  )

  const { data } = sctx.getImageData(0, 0, BOOT_IMAGE_WIDTH, BOOT_IMAGE_HEIGHT)
  const bytes = encodeBootImage(data, BOOT_IMAGE_WIDTH, BOOT_IMAGE_HEIGHT)
  encoded.value = bytes
  emit('picture', bytes)

  const back = decodeBootImage(bytes)
  const pctx = preview.getContext('2d')
  if (!pctx) return
  pctx.putImageData(new ImageData(new Uint8ClampedArray(back.rgba), BOOT_IMAGE_WIDTH, BOOT_IMAGE_HEIGHT), 0, 0)
}

watch(framing, render, { deep: true })

/** Drag the preview to move the crop, at the source's scale rather than the screen's. */
function onPointerDown(e: PointerEvent) {
  if (!hasPicture.value) return
  dragging.value = true
  ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
}
function onPointerMove(e: PointerEvent) {
  if (!dragging.value) return
  const box = (e.currentTarget as HTMLElement).getBoundingClientRect()
  // Movement is in preview pixels; the crop is a fraction of the source, and
  // zooming in means the same drag should move the frame less.
  const dx = (e.movementX / box.width) / framing.value.zoom
  const dy = (e.movementY / box.height) / framing.value.zoom
  framing.value = {
    ...framing.value,
    centreX: Math.min(1, Math.max(0, framing.value.centreX - dx)),
    centreY: Math.min(1, Math.max(0, framing.value.centreY - dy)),
  }
}
function onPointerUp(e: PointerEvent) {
  dragging.value = false
  ;(e.target as HTMLElement).releasePointerCapture?.(e.pointerId)
}

function clear() {
  source.value = null
  encoded.value = null
  sourceName.value = ''
  framing.value = { ...DEFAULT_FRAMING }
  if (fileInput.value) fileInput.value.value = ''
  emit('picture', null)
}

defineExpose({ render })
</script>

<template>
  <div>
    <input
      ref="fileInput"
      type="file"
      accept="image/*"
      class="hidden"
      @change="onPick"
    >

    <div class="flex flex-wrap items-center" style="gap: 8px">
      <RiskAction
        risk="neutral"
        icon="i-lucide-image-plus"
        :label="hasPicture ? 'Choose a different picture' : 'Choose a picture'"
        @click="fileInput?.click()"
      />
      <RiskAction v-if="hasPicture" risk="neutral" ghost label="Clear" @click="clear" />
      <span v-if="sourceName" class="truncate" style="font-size: 13px; color: var(--fn); max-width: 34ch">
        {{ sourceName }}
        <span class="font-mono tabular">{{ sourceSize.width }}x{{ sourceSize.height }}</span>
      </span>
    </div>

    <div v-if="hasPicture" class="mt-4 flex flex-wrap" style="gap: 20px">
      <div>
        <div class="label-xs" style="color: var(--fn); letter-spacing: 0.08em; margin-bottom: 7px">
          What the radio will show
        </div>
        <!--
          Sized in CSS to twice the panel so it is comfortable to look at, with
          `image-rendering: pixelated` so it is honest about resolution: this is
          240 x 320, and a smoothly upscaled preview would flatter it.
        -->
        <canvas
          ref="previewCanvas"
          :width="BOOT_IMAGE_WIDTH"
          :height="BOOT_IMAGE_HEIGHT"
          class="touch-none select-none"
          :style="{
            width: '240px',
            height: '320px',
            imageRendering: 'pixelated',
            border: '1px solid var(--ln)',
            borderRadius: '7px',
            background: '#000',
            cursor: dragging ? 'grabbing' : 'grab',
          }"
          @pointerdown="onPointerDown"
          @pointermove="onPointerMove"
          @pointerup="onPointerUp"
          @pointercancel="onPointerUp"
        />
        <p style="font-size: 12.5px; color: var(--fn); margin-top: 6px; max-width: 240px; line-height: 1.5">
          Drag to move the crop. This is drawn from the encoded bytes, not from your file, so the colours here
          are the colours the radio gets.
        </p>
      </div>

      <div style="min-width: 240px; flex: 1; max-width: 380px">
        <label class="block">
          <span class="label-xs" style="color: var(--fn); letter-spacing: 0.08em">Zoom</span>
          <input
            v-model.number="framing.zoom"
            type="range"
            min="1"
            max="6"
            step="0.05"
            style="width: 100%; margin-top: 7px; accent-color: var(--cn)"
          >
          <span class="font-mono tabular" style="font-size: 12.5px; color: var(--mu)">
            {{ framing.zoom.toFixed(2) }}x
          </span>
        </label>

        <p style="font-size: 13px; line-height: 1.6; color: var(--fn); margin-top: 12px; max-width: 46ch">
          The picture is cropped to the radio's 240 x 320 rather than stretched, so a landscape photo loses its
          sides instead of everyone in it becoming narrow. Zoom in and drag to choose which part survives.
        </p>

        <div class="mt-3 flex flex-wrap" style="gap: 8px">
          <RiskAction
            risk="neutral"
            ghost
            icon="i-lucide-maximize"
            label="Fit the whole picture"
            @click="framing = { ...DEFAULT_FRAMING }"
          />
        </div>
      </div>
    </div>

    <p
      v-else
      class="mt-3"
      style="font-size: 13.5px; line-height: 1.6; color: var(--fn); max-width: 66ch"
    >
      A JPEG, PNG or anything else this browser can open. It is cropped to 240 x 320 and converted to the
      65-thousand-colour format the radio's screen uses, and you see the result of that rather than the file
      you picked.
    </p>

    <!-- Off-screen, at the radio's exact size: the source of the encoded bytes. -->
    <canvas ref="stageCanvas" :width="BOOT_IMAGE_WIDTH" :height="BOOT_IMAGE_HEIGHT" class="hidden" />
  </div>
</template>

<script setup lang="ts">
import { BOOT_IMAGE_BYTES, BOOT_IMAGE_HEIGHT, BOOT_IMAGE_WIDTH, decodeBootImage } from '#core/io/boot-image.js'

/**
 * The picture a DM-32UV shows while it powers up.
 *
 * Two things make this page more careful than it looks.
 *
 * The region lives at 0x150000, outside the configuration region, so it is
 * outside every backup boofwang takes. A codeplug can be rebuilt from a CSV;
 * the factory splash cannot be rebuilt from anything, and the only copy that
 * will ever exist is the one read before the first write. So reading is the
 * first step and the download is offered immediately.
 *
 * And writing a picture is not enough to see one: the radio decides between the
 * picture, a text message and the battery voltage with a separate setting, and
 * a radio set to the text will never show what was uploaded. That is said here
 * rather than left for somebody to discover.
 */
useSeoMeta({ title: 'Startup picture' })

const codeplug = useCodeplugStore()
const device = useDeviceStore()
const boot = useBootImage()
const toast = useToast()

const staged = shallowRef<Uint8Array | null>(null)
const currentCanvas = useTemplateRef<HTMLCanvasElement>('currentCanvas')

/** Only this radio has one, and only its driver knows how to reach it. */
const isDm32 = computed(() => codeplug.doc?.radio === 'dm32uv' || device.radioId === 'dm32uv')

/**
 * Whether the radio will actually display a picture.
 *
 * Read from the open codeplug, because that is where the setting lives. Absent
 * when no codeplug is open, in which case the warning is worded as a reminder
 * rather than a diagnosis.
 */
const powerOnInterface = computed(() => {
  const v = codeplug.doc?.settings?.powerOnInterface
  return typeof v === 'number' ? v : null
})
const showsPicture = computed(() => powerOnInterface.value === 0)

watch(
  () => boot.backup.value,
  async () => {
    await nextTick()
    const held = boot.backup.value
    const canvas = currentCanvas.value
    if (!held || !canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const { rgba } = decodeBootImage(held.subarray(0, BOOT_IMAGE_BYTES))
    ctx.putImageData(new ImageData(new Uint8ClampedArray(rgba), BOOT_IMAGE_WIDTH, BOOT_IMAGE_HEIGHT), 0, 0)
  },
)

async function downloadCurrent() {
  const held = boot.backup.value
  if (!held) return
  const saved = await saveFile(
    held.slice(0, BOOT_IMAGE_BYTES),
    `dm32uv-startup-${new Date().toISOString().slice(0, 10)}.bin`,
    'application/octet-stream',
  )
  if (!saved) return
  toast.add({
    title: 'Saved',
    description: 'Raw 240 x 320 pixels. Nothing else boofwang stores contains this region, so keep it.',
    icon: 'i-lucide-hard-drive-download',
    color: 'success',
    duration: 10_000,
  })
}

async function send() {
  const picture = staged.value
  if (!picture) return
  await boot.writeToRadio(picture)
}
</script>

<template>
  <div class="mx-auto" style="max-width: 1000px; padding: 22px 17px 40px">
    <div class="flex items-center flex-wrap" style="gap: 9px; margin-bottom: 6px">
      <UIcon name="i-lucide-image" style="width: 16px; height: 16px; color: var(--mu)" />
      <h1 style="font-size: 19px; font-weight: 600; letter-spacing: -0.02em; color: var(--tx)">
        Startup picture
      </h1>
    </div>
    <p style="font-size: 14px; line-height: 1.6; color: var(--mu); max-width: 72ch">
      The picture a DM-32UV shows while it powers up. 240 by 320, and it lives in a part of the radio that no
      codeplug backup covers.
    </p>

    <div
      v-if="!isDm32"
      class="mt-5 rounded-[7px]"
      style="border: 1px solid var(--ln); background: var(--pn); padding: 20px"
    >
      <h2 style="font-size: 14.5px; font-weight: 600; color: var(--tx); margin-bottom: 5px">
        This is a DM-32UV feature
      </h2>
      <p style="font-size: 14px; line-height: 1.6; color: var(--mu); max-width: 68ch">
        No other radio boofwang supports stores a startup picture. Connect a DM-32UV, or read one, and this
        page becomes useful.
      </p>
    </div>

    <template v-else>
      <!--
        Step one, and not a formality: this region is in no backup boofwang has
        ever taken, so the read is the only way back that will ever exist.
      -->
      <div
        class="mt-5 rounded-[7px]"
        :style="{
          border: `1px solid ${boot.backup.value ? 'var(--ln)' : 'var(--cn)'}`,
          background: 'var(--pn)',
          padding: '17px 19px',
        }"
      >
        <div class="flex items-start flex-wrap" style="gap: 16px">
          <div style="flex: 1; min-width: 260px">
            <div class="label-xs" style="color: var(--fn); letter-spacing: 0.08em; margin-bottom: 6px">
              A way back
            </div>
            <p v-if="!boot.backup.value" style="font-size: 14px; line-height: 1.6; color: var(--mu); max-width: 62ch">
              Read what the radio has now before replacing it. This region sits outside the codeplug, so no
              <code class="font-mono">.bwp</code>, no stored backup and no export contains it. A codeplug can be
              rebuilt from a CSV; the factory picture cannot be rebuilt from anything.
            </p>
            <p v-else style="font-size: 14px; line-height: 1.6; color: var(--mu); max-width: 62ch">
              Read from the radio. Download it and keep it somewhere: this is the only copy that exists.
            </p>

            <div class="mt-3 flex flex-wrap" style="gap: 8px">
              <RiskAction
                risk="safe"
                icon="i-lucide-image-down"
                :label="boot.backup.value ? 'Read it again' : 'Read what the radio has'"
                :disabled="boot.busy.value"
                @click="boot.readFromRadio()"
              />
              <RiskAction
                v-if="boot.backup.value"
                risk="neutral"
                ghost
                icon="i-lucide-hard-drive-download"
                label="Download it"
                @click="downloadCurrent"
              />
              <ConfirmTyped
                v-if="boot.backup.value"
                token="RESTORE"
                label="Put it back on the radio"
                risk="caution"
                icon="i-lucide-undo-2"
                :disabled="boot.busy.value"
                @confirm="boot.restore()"
              />
            </div>
          </div>

          <div v-if="boot.backup.value">
            <div class="label-xs" style="color: var(--fn); letter-spacing: 0.08em; margin-bottom: 6px">
              On the radio now
            </div>
            <canvas
              ref="currentCanvas"
              :width="BOOT_IMAGE_WIDTH"
              :height="BOOT_IMAGE_HEIGHT"
              style="width: 150px; height: 200px; image-rendering: pixelated; border: 1px solid var(--ln); border-radius: 6px; background: #000"
            />
          </div>
        </div>
      </div>

      <!--
        The thing that makes people think the feature is broken. Worth its own
        panel rather than a footnote: a radio set to the text message will never
        show an uploaded picture, and nothing about the write says so.
      -->
      <div
        v-if="powerOnInterface !== null && !showsPicture"
        class="mt-4 rounded-[7px]"
        style="border: 1px solid var(--wn, var(--fn)); background: var(--pn2); padding: 15px 17px"
      >
        <div class="flex items-start" style="gap: 10px">
          <UIcon name="i-lucide-triangle-alert" style="width: 15px; height: 15px; color: var(--dg); margin-top: 2px; flex: none" />
          <p style="font-size: 13.5px; line-height: 1.6; color: var(--tx); max-width: 74ch">
            This radio's power-on screen is set to
            <strong>{{ powerOnInterface === 1 ? 'a custom message' : 'the battery voltage' }}</strong>, so it
            will not show a picture no matter what is written here. Change
            <em>Power-on screen</em> to <em>Picture</em> on the
            <NuxtLink to="/settings" style="color: var(--cn); text-decoration: underline">Settings</NuxtLink>
            page and write the codeplug, or this will look like it did nothing.
          </p>
        </div>
      </div>

      <div class="mt-5 rounded-[7px]" style="border: 1px solid var(--ln); background: var(--pn); padding: 17px 19px">
        <div class="label-xs" style="color: var(--fn); letter-spacing: 0.08em; margin-bottom: 10px">
          A new picture
        </div>
        <BootImageEditor @picture="staged = $event" />

        <!--
          Destructive, per the risk register: this discards the picture on the
          radio now, which no backup boofwang takes anywhere else covers, so the
          confirmation names that and asks for the word. A plain button here was
          the one write in the application that did not.
        -->
        <div class="mt-4">
          <p v-if="staged && boot.backup.value" style="margin: 0 0 10px; font-size: 13.5px; line-height: 1.55; color: var(--mu); max-width: 70ch">
            This replaces the picture the radio shows when it starts. The one it has now was read at
            the top of this page and is the only copy - keep that download if you might want it back.
          </p>
          <ConfirmTyped
            v-if="staged && boot.backup.value"
            token="REPLACE"
            label="Write it to the radio"
            risk="destructive"
            icon="i-lucide-upload"
            :disabled="boot.busy.value"
            @confirm="send"
          />
          <span v-else-if="!boot.backup.value" style="font-size: 13px; color: var(--fn)">
            Read the radio first, so there is a way back.
          </span>
        </div>
      </div>

      <p class="mt-4" style="font-size: 13px; line-height: 1.6; color: var(--fn); max-width: 74ch">
        Every page is read back and compared after it is written. The picture region is separate from the
        codeplug, so this does not touch channels, contacts or settings.
      </p>
    </template>
  </div>
</template>

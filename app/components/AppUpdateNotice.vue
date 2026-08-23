<script setup lang="ts">
import { formatBuild } from '#core/version/build.js'

/**
 * A newer boofwang is installed and waiting.
 *
 * The offline cache is what makes this necessary. Before it, a reload got
 * whatever the server had; with it, a browser can hold one build indefinitely,
 * and a codeplug editor that has quietly stopped being updated is a hazard of
 * its own kind. So the arrival of a new build is stated rather than applied.
 *
 * **Applying it means reloading, and a reload discards unwritten edits.** That
 * is the only reason this is more than a button. The risk register decides what
 * it costs:
 *
 *   nothing open, or nothing changed   safe        one click
 *   a transfer running                 no offer    the reload would cut a write
 *   unwritten edits                    destructive names them, then a typed word
 *
 * The middle row is not a confirmation. Reloading during a read is a lost
 * afternoon; reloading during a write is a radio left half programmed, and
 * there is no wording that makes that a choice worth offering. It comes back
 * the moment the transfer ends.
 */
const codeplug = useCodeplugStore()
const transfer = useTransferStore()
const { state, pending, apply } = useAppUpdate()
const running = useBuildInfo()

/**
 * Dismissal lasts for this page, not for this device.
 *
 * Somebody halfway through a channel plan should be able to get the bar out of
 * the way. Remembering that across reloads would be the same as not telling
 * them at all, which is the failure the notice exists to prevent.
 */
const dismissed = ref(false)

/** The typed confirmation is opened deliberately, not shown by default. */
const confirming = ref(false)

const waitingLabel = computed(() => {
  const b = state.waitingBuild
  return b ? formatBuild(b) : 'a newer build'
})

const blocked = computed(() => transfer.active)
const costly = computed(() => codeplug.dirty)

const radioName = computed(() => {
  const s = codeplug.schema
  return s ? `${s.vendor} ${s.model}` : 'this radio'
})

const visible = computed(() => pending.value && !dismissed.value)

/*
 * A new build arriving while a transfer runs must not surprise anybody when the
 * transfer ends, so the panel closes itself back to its collapsed state rather
 * than leaving a typed confirmation open across a change of circumstances.
 */
watch([blocked, costly], () => (confirming.value = false))
</script>

<template>
  <div
    v-if="visible"
    class="print-hide"
    style="background: var(--inB); border-bottom: 1px solid var(--inL)"
    role="region"
    aria-label="Application update"
  >
    <div class="mx-auto w-full max-w-[1400px] px-4 py-2 flex items-center flex-wrap gap-x-3 gap-y-2">
      <UIcon name="i-lucide-refresh-cw" class="size-3.5 shrink-0" style="color: var(--in)" />

      <!--
        The live region is the sentence, not the bar. On the bar it would be
        re-announced every time the typed confirmation opens or a button
        changes, which is how a screen reader user learns to tune it out.
      -->
      <div class="flex items-baseline flex-wrap gap-x-2 gap-y-0.5">
        <span role="status" style="font-size: 13.5px; font-weight: 600; color: var(--tx)">
          A newer boofwang is ready
        </span>
        <span class="font-mono tabular" style="font-size: 12px; color: var(--fn)">
          {{ formatBuild(running) }} <UIcon name="i-lucide-arrow-right" class="size-3 align-middle" /> {{ waitingLabel }}
        </span>
      </div>

      <div class="ms-auto flex items-center gap-2">
        <!--
          Nothing is offered while a transfer is running. The bar still says an
          update is there, because the fact is true and hiding it is how it gets
          missed once the transfer ends.
        -->
        <span v-if="blocked" style="font-size: 12.5px; color: var(--mu)">
          Not while a transfer is running
        </span>

        <template v-else-if="costly && !confirming">
          <span class="hidden md:inline" style="font-size: 12.5px; color: var(--mu)">
            Updating reloads the page
          </span>
          <RiskAction
            risk="destructive"
            label="Update anyway"
            icon="i-lucide-refresh-cw"
            size="sm"
            @click="confirming = true"
          />
        </template>

        <RiskAction
          v-else-if="!costly"
          risk="safe"
          label="Update now"
          icon="i-lucide-refresh-cw"
          size="sm"
          :loading="state.applying"
          @click="apply()"
        />

        <button
          type="button"
          class="flex items-center justify-center rounded-[5px] shrink-0"
          style="width: 23px; height: 23px; color: var(--fn)"
          aria-label="Dismiss until the page is reloaded"
          title="Dismiss until the page is reloaded"
          @click="dismissed = true"
        >
          <UIcon name="i-lucide-x" style="width: 13px; height: 13px" />
        </button>
      </div>

      <!--
        The destructive tier in full: what is lost, named, then a word typed.
        On its own row so the diff-sized explanation is not squeezed into a bar,
        and only once the person has asked for it.
      -->
      <div v-if="confirming && costly && !blocked" class="w-full pt-1 pb-1">
        <p style="font-size: 12.5px; line-height: 1.6; color: var(--mu); margin-bottom: 8px">
          Your edits to the {{ radioName }} codeplug are held in this page and nowhere else. Updating reloads
          the page, which discards them. They have not been written to the radio and there is no way back to
          them afterwards. Write them to the radio first, or save a copy, if you want to keep them.
        </p>
        <ConfirmTyped
          token="update"
          label="Discard edits and update"
          risk="destructive"
          icon="i-lucide-refresh-cw"
          :loading="state.applying"
          @confirm="apply()"
        >
          <template #secondary>
            <RiskAction risk="neutral" ghost label="Keep editing" size="md" @click="confirming = false" />
          </template>
        </ConfirmTyped>
      </div>
    </div>
  </div>
</template>

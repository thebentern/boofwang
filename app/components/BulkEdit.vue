<script setup lang="ts">
import type { Channel, Modulation, SkipMode } from '#core/model/channel.js'
import { formatCtcss } from '#core/model/tones.js'
import { formatPower, hz } from '#core/model/units.js'
import { bulkPatch, isEmptyChange, transmitExposure, type BulkChange } from '#core/radio/bulk-edit.js'

/**
 * One change, applied to every channel that is ticked.
 *
 * The table has had a selection for a long time and it could only delete or
 * export. Setting the same power on forty channels meant opening forty editors,
 * which is why nobody did it: the way people actually got there was to export a
 * CSV, edit it elsewhere and import it back, and a round trip through another
 * program is a chance for a tone table or a receive-only flag to be quietly
 * reinterpreted on the way.
 *
 * Every control starts at "leave alone" and only the ones moved are written, so
 * this cannot flatten a field somebody never mentioned. That is what makes it
 * safe to apply across a mixed selection, where the channels genuinely differ
 * in things this form is not about.
 *
 * The form is all that is here. Turning the controls into a patch, and counting
 * what allowing transmit would unlock, are `bulk-edit.ts` in the core - pure
 * arithmetic over a channel, reachable by a test without mounting anything.
 * `place.ts` is the note on why: the last piece of channel arithmetic written
 * inside a component was wrong in a way nothing could see.
 *
 * **Transmit is the field this screen exists to be careful with.** A channel
 * that quietly becomes transmit-capable is the failure that puts a weather or
 * public-safety frequency into a radio someone can key up, and doing it to
 * forty channels at once is exactly how it would happen unnoticed. So enabling
 * transmit counts the receive-only channels in the selection first, says how
 * many receive where the radio's own band plan forbids transmitting, and names
 * the slots. It is not blocked - there are real reasons to do it, and
 * `rules.ts` sets out why this tool is not the licensing authority - but it is
 * never silent.
 */
const props = defineProps<{ slots: readonly number[] }>()
const emit = defineEmits<{ close: [] }>()

const open = defineModel<boolean>('open', { required: true })

const codeplug = useCodeplugStore()
const schema = computed(() => codeplug.schema!)
/** The firmware's profile rather than the schema's, the same as the single editor. */
const rf = computed(() => codeplug.rf ?? schema.value.rf)

/** `keep` is the absence of an instruction, and it is every control's default. */
const KEEP = 'keep' as const
type Keep = typeof KEEP

const power = ref<string | Keep>(KEEP)
const bandwidth = ref<number | Keep>(KEEP)
const modulation = ref<Modulation | Keep>(KEEP)
const step = ref<number | Keep>(KEEP)
const skip = ref<SkipMode | Keep>(KEEP)
const transmit = ref<'keep' | 'rx-only' | 'allow'>(KEEP)
const rxTone = ref<number | Keep | 'none'>(KEEP)
const txTone = ref<number | Keep | 'none'>(KEEP)

/**
 * Back to "leave alone" whenever the dialog opens.
 *
 * A form that remembered last time would apply a power level somebody set for a
 * different set of channels, to a selection they have not looked at through
 * this lens. Reopening is the gesture that means "start again".
 */
watch(open, (isOpen) => {
  if (!isOpen) return
  power.value = KEEP
  bandwidth.value = KEEP
  modulation.value = KEEP
  step.value = KEEP
  skip.value = KEEP
  transmit.value = KEEP
  rxTone.value = KEEP
  txTone.value = KEEP
})

const channels = computed<Channel[]>(() => {
  const doc = codeplug.doc
  if (!doc) return []
  return props.slots.map((s) => doc.channels.get(s)).filter((c): c is Channel => c !== undefined)
})

const KEEP_OPTION = { value: KEEP, label: 'Leave alone' }

const powerOptions = computed(() => [
  KEEP_OPTION,
  ...rf.value.powerLevels.map((l) => ({ value: l.id, label: `${l.label} · ${formatPower(l.mW)}` })),
])
const bandwidthOptions = computed(() => [
  KEEP_OPTION,
  ...rf.value.bandwidths.map((b) => ({ value: b, label: `${(b / 1000).toFixed(2)} kHz` })),
])
const modulationOptions = computed(() => [
  KEEP_OPTION,
  ...rf.value.modulations.map((m) => ({ value: m, label: m })),
])
const stepOptions = computed(() => [
  KEEP_OPTION,
  ...rf.value.tuningSteps.map((s) => ({ value: s as number, label: `${(s / 1000).toFixed(2)} kHz` })),
])
const skipOptions = [
  KEEP_OPTION,
  { value: 'none', label: 'Scan it' },
  { value: 'skip', label: 'Skip it' },
  { value: 'pskip', label: 'Skip (priority)' },
]
const transmitOptions = [
  KEEP_OPTION,
  { value: 'rx-only', label: 'Receive-only' },
  { value: 'allow', label: 'Allow transmit' },
]

/**
 * CTCSS only, and DTCS deliberately absent.
 *
 * A DTCS code carries a polarity as well, and a bulk control offering one
 * without the other would write a plausible-looking wrong answer across a whole
 * selection - the channel whose squelch never opens, which is worse than no
 * tone and completely silent. The single-channel editor has both, and a DTCS
 * change is rarely the same across forty channels anyway.
 */
const toneOptions = computed(() => [
  KEEP_OPTION,
  { value: 'none', label: 'No tone' },
  ...rf.value.ctcssDeciHz.map((d) => ({ value: d, label: `${formatCtcss(d)} Hz` })),
])

const powerLevel = computed(() => rf.value.powerLevels.find((l) => l.id === power.value) ?? null)

/** What this form would do, said in words, so the button is not a leap of faith. */
const changes = computed<string[]>(() => {
  const out: string[] = []
  if (powerLevel.value) out.push(`Power · ${powerLevel.value.label} (${formatPower(powerLevel.value.mW)})`)
  if (bandwidth.value !== KEEP) out.push(`Bandwidth · ${(bandwidth.value / 1000).toFixed(2)} kHz`)
  if (modulation.value !== KEEP) out.push(`Mode · ${modulation.value}`)
  if (step.value !== KEEP) out.push(`Step · ${(step.value / 1000).toFixed(2)} kHz`)
  if (skip.value !== KEEP) out.push(`Scan · ${skip.value === 'none' ? 'scan it' : 'skip it'}`)
  if (transmit.value === 'rx-only') out.push('Transmit · receive-only')
  if (transmit.value === 'allow') out.push('Transmit · allowed')
  if (rxTone.value !== KEEP) {
    out.push(`Receive tone · ${rxTone.value === 'none' ? 'none' : `${formatCtcss(rxTone.value)} Hz`}`)
  }
  if (txTone.value !== KEEP) {
    out.push(`Transmit tone · ${txTone.value === 'none' ? 'none' : `${formatCtcss(txTone.value)} Hz`}`)
  }
  return out
})

// -------------------------------------------------------------- the instruction

/**
 * The controls, read as one instruction for `bulkPatch`.
 *
 * `exactOptionalPropertyTypes` is on, so a key is spread in or left out rather
 * than assigned `undefined` - which is also exactly the distinction the change
 * object is built on: absent is "leave alone", and `null` is a tone somebody
 * asked to clear.
 */
const change = computed<BulkChange>(() => ({
  ...(powerLevel.value === null ? {} : { power: { mW: powerLevel.value.mW, label: powerLevel.value.label } }),
  ...(bandwidth.value === KEEP ? {} : { bandwidthHz: bandwidth.value }),
  ...(modulation.value === KEEP ? {} : { modulation: modulation.value }),
  ...(step.value === KEEP ? {} : { tuningStep: hz(step.value) }),
  ...(skip.value === KEEP ? {} : { skip: skip.value }),
  ...(transmit.value === KEEP ? {} : { transmit: transmit.value }),
  ...(rxTone.value === KEEP
    ? {}
    : { rxTone: rxTone.value === 'none' ? null : { kind: 'ctcss' as const, deciHz: rxTone.value } }),
  ...(txTone.value === KEEP
    ? {}
    : { txTone: txTone.value === 'none' ? null : { kind: 'ctcss' as const, deciHz: txTone.value } }),
}))

/** What enabling transmit would open up, counted before it is offered. */
const exposure = computed(() => transmitExposure(channels.value, change.value, rf.value.bands))

const nothingToDo = computed(() => isEmptyChange(change.value) || channels.value.length === 0)

// --------------------------------------------------------------------- applying

/**
 * One transaction, so one undo takes the whole thing back.
 *
 * `updateChannel` opens its own and nesting joins the group already open. Doing
 * it any other way would leave someone pressing undo forty times to take back
 * one decision - the same reason the bulk delete is written like this.
 */
function apply() {
  const list = channels.value
  if (nothingToDo.value) return

  codeplug.transact(`edit ${list.length} channel${list.length === 1 ? '' : 's'}`, () => {
    for (const ch of list) codeplug.updateChannel(ch.index, bulkPatch(ch, change.value))
  })
  open.value = false
  emit('close')
}

const slotSummary = computed(() => {
  const shown = props.slots.slice(0, 12).join(', ')
  return props.slots.length > 12 ? `${shown} and ${props.slots.length - 12} more` : shown
})
</script>

<template>
  <UModal
    v-model:open="open"
    :title="`Edit ${slots.length} channel${slots.length === 1 ? '' : 's'}`"
    :ui="{ content: 'max-w-2xl' }"
  >
    <template #body>
      <p style="font-size: 13.5px; line-height: 1.6; color: var(--mu); max-width: 68ch">
        Every control starts on <span style="color: var(--tx)">leave alone</span>, and only the ones you move
        are written. Nothing is sent to the radio, and undo takes the whole edit back in one step.
      </p>

      <div class="mt-3 grid grid-cols-3 gap-3">
        <UFormField label="Power">
          <USelect v-model="power" class="w-full" :items="powerOptions" />
        </UFormField>
        <UFormField label="Bandwidth">
          <USelect v-model="bandwidth" class="w-full" :items="bandwidthOptions" />
        </UFormField>
        <UFormField label="Mode">
          <USelect v-model="modulation" class="w-full" :items="modulationOptions" />
        </UFormField>
      </div>

      <div class="mt-3 grid grid-cols-3 gap-3">
        <UFormField label="Step">
          <USelect v-model="step" class="w-full" :items="stepOptions" />
        </UFormField>
        <UFormField v-if="rf.canSkip" label="Scanning">
          <USelect v-model="skip" class="w-full" :items="skipOptions" />
        </UFormField>
        <UFormField label="Transmit">
          <USelect v-model="transmit" class="w-full" :items="transmitOptions" />
        </UFormField>
      </div>

      <div class="mt-3 grid grid-cols-2 gap-3">
        <UFormField label="Receive tone (opens squelch)">
          <USelect v-model="rxTone" class="w-full" :items="toneOptions" />
        </UFormField>
        <UFormField label="Transmit tone (sent)">
          <USelect v-model="txTone" class="w-full" :items="toneOptions" />
        </UFormField>
      </div>

      <!--
        Named before it happens, not discovered afterwards in the diff.

        The diff before a write would show it, which is late: by then the
        selection is gone and forty rows have changed together, so there is
        nothing left to compare the intent against.
      -->
      <div
        v-if="exposure.unlocked.length > 0"
        class="mt-4 rounded-[7px]"
        style="border: 1px solid var(--cnL); background: var(--cnB); padding: 10px 13px"
      >
        <div class="flex items-center" style="gap: 6px; color: var(--cn); margin-bottom: 4px">
          <UIcon name="i-lucide-lock-open" style="width: 12px; height: 12px" />
          <span class="label-xs" style="letter-spacing: 0.08em">
            {{ exposure.unlocked.length }} of {{ channels.length }}
            {{ exposure.unlocked.length === 1 ? 'is' : 'are' }} receive-only now
          </span>
        </div>
        <p style="font-size: 13px; line-height: 1.5; color: var(--tx)">
          {{ exposure.unlocked.length === 1 ? 'Slot' : 'Slots' }}
          <span class="font-mono tabular">{{ exposure.unlocked.slice(0, 12).map((c) => c.index).join(', ') }}</span
          ><template v-if="exposure.unlocked.length > 12"> and {{ exposure.unlocked.length - 12 }} more</template>. This
          edit makes {{ exposure.unlocked.length === 1 ? 'it' : 'them' }} transmit-capable.
        </p>
        <p
          v-if="exposure.inReceiveOnlyBand.length > 0"
          style="font-size: 13px; line-height: 1.5; color: var(--cn); margin-top: 5px"
        >
          {{ exposure.inReceiveOnlyBand.length }} of {{ exposure.unlocked.length === 1 ? 'them' : 'those' }}
          {{ exposure.inReceiveOnlyBand.length === 1 ? 'receives' : 'receive' }} in a band this radio's band plan marks
          receive-only. Check your licence before transmitting there.
        </p>
      </div>

      <div
        class="mt-4 rounded-[7px]"
        style="border: 1px solid var(--ln); background: var(--pn); padding: 10px 13px"
      >
        <div class="label-xs" style="color: var(--fn); letter-spacing: 0.08em; margin-bottom: 6px">
          {{ changes.length === 0 ? 'Nothing to change yet' : `Applied to ${channels.length} channel${channels.length === 1 ? '' : 's'}` }}
        </div>
        <p
          v-if="changes.length === 0"
          style="font-size: 13px; line-height: 1.5; color: var(--mu)"
        >
          Move a control above. Slots
          <span class="font-mono tabular">{{ slotSummary }}</span> are selected.
        </p>
        <div v-else class="flex flex-wrap" style="gap: 5px">
          <span
            v-for="c in changes"
            :key="c"
            class="chip"
            style="border: 1px solid var(--inL); background: var(--inB); color: var(--in)"
          >{{ c }}</span>
        </div>
      </div>
    </template>

    <template #footer>
      <div class="flex items-center w-full" style="gap: 8px">
        <RiskAction
          risk="caution"
          icon="i-lucide-pencil"
          :disabled="nothingToDo"
          :label="`Apply to ${channels.length} channel${channels.length === 1 ? '' : 's'}`"
          @click="apply()"
        />
        <RiskAction risk="neutral" ghost label="Cancel" @click="open = false" />
      </div>
    </template>
  </UModal>
</template>

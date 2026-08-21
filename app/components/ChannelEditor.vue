<script setup lang="ts">
import type { Channel } from '#core/model/channel.js'
import { formatCtcss, type ToneSpec } from '#core/model/tones.js'
import { encryptionLegality } from '#core/model/encryption.js'
import { formatFreq, hz, parseFreq } from '#core/model/units.js'

/**
 * Editing one channel.
 *
 * Driven from the radio's schema rather than hard-coded for the UV-K5: the mode,
 * power and step choices are whatever the connected radio declares, so a second
 * radio needs no change here.
 */
const props = defineProps<{ channel: Channel }>()
const emit = defineEmits<{ close: [] }>()

const codeplug = useCodeplugStore()
const schema = computed(() => codeplug.schema!)

const name = ref(props.channel.name)
const rxText = ref(formatFreq(props.channel.rxFreq))
const txAllowed = ref(props.channel.txAllowed)
const duplex = ref<'simplex' | 'plus' | 'minus'>(
  props.channel.tx.kind === 'offset' ? props.channel.tx.direction : 'simplex',
)
const offsetText = ref(formatFreq(props.channel.tx.kind === 'offset' ? props.channel.tx.offset : hz(0)))
const modulation = ref(props.channel.modulation)
const bandwidthHz = ref(props.channel.bandwidthHz)
/*
 * Match the channel's power by its value, not its name.
 *
 * A driver labels a level from whatever table the radio it identified actually
 * has - the UV-5R Mini calls 5 W "High" while the schema, which carries both
 * variants, calls it "High (5 W)". Matching on the label found nothing, fell
 * back to an id no schema defines, and made saving any High-power channel throw.
 */
const powerId = ref(
  (
    schema.value.rf.powerLevels.find((l) => l.mW === props.channel.power.mW) ??
    schema.value.rf.powerLevels.find((l) => l.label === props.channel.power.label) ??
    schema.value.rf.powerLevels[0]
  )?.id ?? '',
)
const stepHz = ref(props.channel.tuningStep as number)

type ToneKind = 'none' | 'ctcss' | 'dtcs'
const toneKind = (t: ToneSpec | null): ToneKind => (t === null ? 'none' : t.kind)
const rxToneKind = ref<ToneKind>(toneKind(props.channel.tone.rx))
const txToneKind = ref<ToneKind>(toneKind(props.channel.tone.tx))
const rxCtcss = ref(props.channel.tone.rx?.kind === 'ctcss' ? props.channel.tone.rx.deciHz : 885)
const txCtcss = ref(props.channel.tone.tx?.kind === 'ctcss' ? props.channel.tone.tx.deciHz : 885)
const rxDtcs = ref(props.channel.tone.rx?.kind === 'dtcs' ? props.channel.tone.rx.code : 23)
const txDtcs = ref(props.channel.tone.tx?.kind === 'dtcs' ? props.channel.tone.tx.code : 23)

const ctcssOptions = computed(() =>
  schema.value.rf.ctcssDeciHz.map((d) => ({ value: d, label: `${formatCtcss(d)} Hz` })),
)
const dtcsOptions = computed(() =>
  schema.value.rf.dtcsCodes.map((c) => ({ value: c, label: `D${String(c).padStart(3, '0')}` })),
)
const toneKindOptions = [
  { value: 'none', label: 'None' },
  { value: 'ctcss', label: 'CTCSS' },
  { value: 'dtcs', label: 'DTCS' },
]

const rxError = computed(() => {
  try {
    const f = parseFreq(rxText.value)
    const band = schema.value.rf.bands.find((b) => f >= b.loHz && f <= b.hiHz)
    if (!band) return 'Outside every band this radio covers'
    if (!band.txAllowed && txAllowed.value) return `${band.label} is receive-only on this radio`
    return null
  } catch {
    return 'Not a frequency'
  }
})

const nameError = computed(() =>
  name.value.length > schema.value.memory.nameLength
    ? `The radio shows ${schema.value.memory.nameLength} characters`
    : null,
)

const canSave = computed(() => rxError.value === null && nameError.value === null && !encryptionBlocked.value)

/**
 * Encryption, on radios that have it.
 *
 * Shown per channel because that is where the decision actually lives, and
 * because the legality of it depends on the frequency in the field above.
 */
const supportsEncryption = computed(() => schema.value.features.encryption !== false)
const availableKeys = computed(() => codeplug.doc?.encryptionKeys ?? [])
const encKeyId = ref(Number(props.channel.extras.vendor?.encryptionKeyId ?? '0'))

/**
 * Which talk group this channel transmits to.
 *
 * Kept in two blocks of its own rather than in the channel record - the channel
 * byte people reach for, 0x2B, is the radio ID index, not this - and identified
 * by the talk group's physical slot, so a gap in the bank does not shift it.
 */
const supportsTalkGroups = computed(() => schema.value.features.talkGroups !== false)
const talkGroups = computed(() => codeplug.doc?.talkGroups ?? [])
const txContact = ref(Number(props.channel.extras.vendor?.txContact ?? '0'))

/**
 * A talk group's physical slot, which is what the channel stores.
 *
 * Not its position in the list: this radio's bank has gaps - slots 2, 5, 8 and
 * 9 are wiped records - and the decoder keeps them visible for exactly this
 * reason. The id carries the slot, as `tg-<block>-<n>`.
 */
function slotOf(id: string): number {
  const m = /^tg-[0-9a-fx]+-(\d+)$/.exec(id)
  return m ? Number(m[1]) : 0
}
/** Only a digital channel keys a talk group. */
const isDigital = computed(() => modulation.value === 'DMR')

const legality = computed(() => {
  try {
    return encryptionLegality(parseFreq(rxText.value))
  } catch {
    return null
  }
})

const encryptionBlocked = computed(() => encKeyId.value !== 0 && legality.value !== null && !legality.value.allowed)

function buildTone(kind: ToneKind, ctcssV: number, dtcsV: number): ToneSpec | null {
  if (kind === 'ctcss') return { kind: 'ctcss', deciHz: ctcssV }
  if (kind === 'dtcs') return { kind: 'dtcs', code: dtcsV, polarity: 'N' }
  return null
}

function save() {
  if (!canSave.value) return
  const rxFreq = parseFreq(rxText.value)
  // Falling back rather than asserting: an id that matches nothing should not
  // take the whole save down with it.
  const level =
    schema.value.rf.powerLevels.find((l) => l.id === powerId.value) ?? schema.value.rf.powerLevels[0]!

  codeplug.updateChannel(props.channel.index, {
    name: name.value,
    rxFreq,
    txAllowed: txAllowed.value,
    tx:
      duplex.value === 'simplex'
        ? { kind: 'simplex' }
        : { kind: 'offset', direction: duplex.value, offset: parseFreq(offsetText.value) },
    tone: {
      rx: buildTone(rxToneKind.value, rxCtcss.value, rxDtcs.value),
      tx: buildTone(txToneKind.value, txCtcss.value, txDtcs.value),
      rxInverted: props.channel.tone.rxInverted,
    },
    modulation: modulation.value,
    bandwidthHz: bandwidthHz.value,
    power: { mW: level.mW, label: level.label },
    tuningStep: hz(stepHz.value),
    ...(txAllowed.value ? {} : { txInhibitReason: 'Marked receive-only' }),
    ...(supportsEncryption.value
      ? {
          extras: {
            ...props.channel.extras,
            vendor: {
              ...props.channel.extras.vendor,
              encryptionKeyId: String(encKeyId.value),
              ...(supportsTalkGroups.value ? { txContact: String(txContact.value) } : {}),
            },
          },
        }
      : {}),
  })
  emit('close')
}

function remove() {
  codeplug.deleteChannel(props.channel.index)
  emit('close')
}
</script>

<template>
  <div class="space-y-4">
    <div class="grid grid-cols-2 gap-3">
      <UFormField label="Name" :error="nameError ?? undefined">
        <UInput v-model="name" :maxlength="schema.memory.nameLength + 4" class="w-full" />
      </UFormField>
      <UFormField label="Receive (MHz)" :error="rxError ?? undefined">
        <UInput v-model="rxText" class="w-full tabular" />
      </UFormField>
    </div>

    <UFormField>
      <USwitch v-model="txAllowed" label="This channel may transmit" />
      <template #help>
        <span v-if="!txAllowed" class="text-warning">
          Receive-only. {{ schema.rf.txInhibit ? schema.rf.txInhibit.mechanism : '' }}
        </span>
      </template>
    </UFormField>

    <div v-if="txAllowed" class="grid grid-cols-2 gap-3">
      <UFormField label="Shift">
        <USelect
          v-model="duplex"
          class="w-full"
          :items="[
            { value: 'simplex', label: 'Simplex' },
            { value: 'plus', label: 'Plus (+)' },
            { value: 'minus', label: 'Minus (−)' },
          ]"
        />
      </UFormField>
      <UFormField v-if="duplex !== 'simplex'" label="Offset (MHz)">
        <UInput v-model="offsetText" class="w-full tabular" />
      </UFormField>
    </div>

    <div class="grid grid-cols-3 gap-3">
      <UFormField label="Mode">
        <USelect
          v-model="modulation"
          class="w-full"
          :items="schema.rf.modulations.map((m) => ({ value: m, label: m }))"
        />
      </UFormField>
      <UFormField label="Bandwidth">
        <USelect
          v-model="bandwidthHz"
          class="w-full"
          :items="schema.rf.bandwidths.map((b) => ({ value: b, label: `${b / 1000} kHz` }))"
        />
      </UFormField>
      <UFormField label="Power">
        <USelect
          v-model="powerId"
          class="w-full"
          :items="schema.rf.powerLevels.map((l) => ({ value: l.id, label: `${l.label} (${l.mW / 1000} W)` }))"
        />
      </UFormField>
    </div>

    <div class="grid grid-cols-2 gap-3">
      <UFormField label="Receive tone (opens squelch)">
        <div class="flex gap-2">
          <USelect v-model="rxToneKind" class="w-32" :items="toneKindOptions" />
          <USelect v-if="rxToneKind === 'ctcss'" v-model="rxCtcss" class="flex-1" :items="ctcssOptions" />
          <USelect v-else-if="rxToneKind === 'dtcs'" v-model="rxDtcs" class="flex-1" :items="dtcsOptions" />
        </div>
      </UFormField>
      <UFormField label="Transmit tone (sent)">
        <div class="flex gap-2">
          <USelect v-model="txToneKind" class="w-32" :items="toneKindOptions" :disabled="!txAllowed" />
          <USelect
            v-if="txToneKind === 'ctcss'"
            v-model="txCtcss"
            class="flex-1"
            :items="ctcssOptions"
            :disabled="!txAllowed"
          />
          <USelect
            v-else-if="txToneKind === 'dtcs'"
            v-model="txDtcs"
            class="flex-1"
            :items="dtcsOptions"
            :disabled="!txAllowed"
          />
        </div>
      </UFormField>
    </div>

    <template v-if="supportsTalkGroups && isDigital">
      <USeparator />
      <UFormField label="Transmit talk group">
        <USelect
          v-model="txContact"
          class="w-full"
          :items="[
            { value: 0, label: 'None' },
            ...talkGroups.map((g) => ({ value: slotOf(g.id), label: `${g.name || 'unnamed'} · ${g.number}` })),
          ]"
        />
        <template #help>
          <span class="text-muted">
            Where this channel transmits. Analog channels do not have one.
          </span>
        </template>
      </UFormField>
    </template>

    <template v-if="supportsEncryption">
      <USeparator />
      <UFormField label="Encryption">
        <USelect
          v-model="encKeyId"
          class="w-full"
          :items="[
            { value: 0, label: 'None (clear)' },
            ...availableKeys.map((k) => ({ value: k.slot, label: `Slot ${k.slot} · ${k.name || 'unnamed'}` })),
          ]"
        />
        <template #help>
          <span v-if="availableKeys.length === 0" class="text-muted">
            No keys are defined yet. Add one on the Keys page first.
          </span>
        </template>
      </UFormField>

      <UAlert
        v-if="encKeyId !== 0 && legality"
        :icon="legality.allowed ? 'i-lucide-shield' : 'i-lucide-shield-alert'"
        :color="legality.allowed ? 'warning' : 'error'"
        variant="subtle"
        :title="
          legality.allowed
            ? 'Licensed business and commercial use only'
            : `Encryption is not permitted on this frequency (${legality.service})`
        "
      >
        <template #description>
          <span>{{ legality.reason }}</span>
          <span v-if="legality.cfr" class="text-muted"> ({{ legality.cfr }})</span>
        </template>
      </UAlert>
    </template>

    <UFormField label="Tuning step">
      <USelect
        v-model="stepHz"
        class="w-full"
        :items="schema.rf.tuningSteps.map((s) => ({ value: s as number, label: `${(s as number) / 1000} kHz` }))"
      />
    </UFormField>

    <div class="flex items-center gap-2 pt-2">
      <UButton icon="i-lucide-circle-check" label="Apply" :disabled="!canSave" @click="save" />
      <UButton label="Cancel" color="neutral" variant="ghost" @click="emit('close')" />
      <UButton
        class="ms-auto"
        icon="i-lucide-trash-2"
        label="Delete channel"
        color="error"
        variant="subtle"
        @click="remove"
      />
    </div>
  </div>
</template>

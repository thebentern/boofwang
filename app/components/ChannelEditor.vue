<script setup lang="ts">
import type { Channel, TxSpec } from '#core/model/channel.js'
import { formatCtcss, type ToneSpec } from '#core/model/tones.js'
import { encryptionLegality } from '#core/model/encryption.js'
import { shiftFormOf, txSpecOf, type ShiftChoice } from '#core/model/shift-form.js'
import { formatFreq, hz, parseFreq } from '#core/model/units.js'
import { validateChannel } from '#core/validate/rules.js'

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
/**
 * What this firmware can do, which is not always what the schema declares.
 *
 * The bands, the modulations and the tuning steps all differ between a stock
 * UV-K5 and an egzumer one, and reading them off the schema meant a decoded
 * egzumer channel could not be edited or even renamed.
 */
const rf = computed(() => codeplug.rf ?? schema.value.rf)

const name = ref(props.channel.name)
const rxText = ref(formatFreq(props.channel.rxFreq))
const txAllowed = ref(props.channel.txAllowed)

/**
 * Why the channel was receive-only when it was opened, said in its own words.
 *
 * `txInhibitReason` is kept "for the UI to explain rather than just gray out",
 * and for a long time nothing showed it: a NOAA preset carried "transmitting
 * on 162 MHz is unlawful" and the editor said only "Receive-only" and how the
 * radio enforces it. It replaces the mechanism rather than following it,
 * because a channel read from a radio carries the mechanism as its reason -
 * each decoder writes how its radio holds the channel, "Transmit frequency is
 * zero" or "Transmit forbidden on this channel" - and two sentences saying the
 * same thing is one too many.
 */
const arrivedReason = computed(() => {
  const reason = props.channel.txAllowed ? '' : (props.channel.txInhibitReason ?? '').trim()
  if (reason === '') return null
  return /[.!?]$/.test(reason) ? reason : `${reason}.`
})
/*
 * The shift, the offset and the transmit frequency, held as the fields show
 * them. `shift-form.ts` converts both ways, and its note says why that is not
 * done here: this editor once opened a split channel as simplex and wrote it
 * back that way.
 */
const initialShift = shiftFormOf(props.channel.tx, props.channel.rxFreq)
const duplex = ref<ShiftChoice>(initialShift.shift)
const offsetText = ref(initialShift.offset)
const txText = ref(initialShift.txFreq)
const shiftForm = computed(() => ({ shift: duplex.value, offset: offsetText.value, txFreq: txText.value }))

/**
 * Split where the radio can store a separate transmit frequency, which is what
 * the schema's `duplexes` says: five radios list it, and the UV-K5, whose
 * encoder refuses one, does not. A channel that is already split is offered
 * split on any radio, because the control has to be able to show what the
 * channel holds.
 */
const splitStorable = computed(() => rf.value.duplexes.includes('split'))
const shiftItems = computed(() => [
  { value: 'simplex', label: 'Simplex' },
  { value: 'plus', label: 'Plus (+)' },
  { value: 'minus', label: 'Minus (−)' },
  ...(splitStorable.value || props.channel.tx.kind === 'split' ? [{ value: 'split', label: 'Split' }] : []),
])
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
    // The firmware's bands, not the schema's: an egzumer build with wide
    // receive legitimately reaches frequencies the stock table does not list,
    // and refusing those made a decoded channel unsavable - not even
    // renameable.
    const band = rf.value.bands.find((b) => f >= b.loHz && f <= b.hiHz)
    // Only what the radio cannot do is an error. A band its plan marks
    // receive-only is a warning, under the transmit switch: see `txWarning`.
    if (!band) return 'Outside every band this radio covers'
    return null
  } catch {
    return 'Not a frequency'
  }
})

/**
 * What the shared rules say about where this channel would transmit.
 *
 * Asked of `validateChannel` rather than worked out here, with the same bands,
 * so the editor says what the channel table and the write gate say and cannot
 * drift from them. It warns and Apply goes through: `lib/validate/rules.ts`
 * made transmitting into a receive-only allocation a warning on 2026-08-21,
 * because it is a licensing question and this tool is not the licensing
 * authority. This editor kept an older check that refused Apply until the
 * transmit switch went off, so the one screen built for a deliberate edit was
 * the one place that decision never reached - while the table's own inline
 * edit let the same frequency straight through.
 *
 * The transmit frequency, not the receive one. A shift can carry a channel
 * into a band its receive frequency is not in, and the old check, reading the
 * receive frequency, missed exactly that.
 */
const txWarning = computed(() => {
  let draft: Channel
  try {
    draft = {
      ...props.channel,
      rxFreq: parseFreq(rxText.value),
      txAllowed: txAllowed.value,
      tx: txSpecOf(shiftForm.value),
    }
  } catch {
    // Nothing to check until the frequencies parse.
    return null
  }
  const found = validateChannel(draft, schema.value, { bands: rf.value.bands }).find(
    (d) => d.ruleId === 'regulatory.band.tx-not-permitted',
  )
  return found?.message ?? null
})

const nameError = computed(() =>
  name.value.length > schema.value.memory.nameLength
    ? `The radio shows ${schema.value.memory.nameLength} characters`
    : null,
)

/**
 * The transmit side's own errors, for the field the shift reads.
 *
 * A split's transmit field is a frequency like the receive one, so it gets the
 * receive field's two errors, and it needs the second: `parseFreq` reads an
 * emptied field as 0 Hz, which is outside every band rather than unreadable.
 * Where an offset lands is left to the validator, as it was before split was
 * here. An offset that does not parse used to throw from `save` and do
 * nothing at all.
 */
const txError = computed(() => {
  if (!txAllowed.value || duplex.value === 'simplex') return null
  let tx: TxSpec
  try {
    tx = txSpecOf(shiftForm.value)
  } catch {
    return 'Not a frequency'
  }
  if (tx.kind !== 'split') return null
  const at = tx.txFreq
  return rf.value.bands.some((b) => at >= b.loHz && at <= b.hiHz) ? null : 'Outside every band this radio covers'
})

const canSave = computed(() => rxError.value === null && nameError.value === null && txError.value === null)

/**
 * On a phone this is a full-height sheet, not a centerd dialog.
 *
 * Two things forced it. The form is `grid-cols-2` and `grid-cols-3`, which puts
 * a select at about 120px on a 375px screen - narrower than the words inside
 * it. And Apply sat at the bottom of a scrolling form, so committing an edit
 * meant scrolling past every field you did not touch to reach it.
 *
 * So the columns collapse to one and the two actions pin to a header a thumb
 * can reach without moving. Delete stays at the foot: it is destructive, and a
 * destructive action pinned next to Apply is a mis-tap waiting to happen.
 */
const { phone } = useFormFactor()

/** One column on a phone; the desktop keeps its pairs. */
const pair = computed(() => (phone.value ? '' : 'grid grid-cols-2 gap-3'))
const triple = computed(() => (phone.value ? '' : 'grid grid-cols-3 gap-3'))

/**
 * Encryption, on radios that have it.
 *
 * Shown per channel because that is where the decision actually lives, and
 * because the legality of it depends on the frequency in the field above.
 */
const supportsEncryption = computed(() => schema.value.features.encryption !== false)
const availableKeys = computed(() => codeplug.doc?.encryptionKeys ?? [])
const savedKeyId = Number(props.channel.extras.vendor?.encryptionKeyId ?? '0')
const encKeyId = ref(savedKeyId)

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

/**
 * Whether encryption is lawful on the frequency in the field above.
 *
 * Stated, never enforced. The alert under the key picker gives the rule and
 * its citation, and Apply goes through either way: the operator holds the
 * license, and this tool is not the licensing authority. Apply used to refuse,
 * and on the DM-32UV this was built against the refusal reached further than
 * anyone meant. Its CPS had encrypted TAC 1-14 on GMRS, so none of those
 * channels could be saved from here at all - not renamed, not retuned, not
 * pointed at another talk group - without first taking its encryption off,
 * the one edit nobody had asked for.
 */
const legality = computed(() => {
  try {
    return encryptionLegality(parseFreq(rxText.value))
  } catch {
    return null
  }
})

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
  let tx: TxSpec
  try {
    tx = txSpecOf(shiftForm.value)
  } catch {
    // Reachable only with transmit off, where the shift fields are hidden and
    // `txError` stays quiet: keep what the channel had rather than throw.
    tx = props.channel.tx
  }

  codeplug.updateChannel(props.channel.index, {
    name: name.value,
    rxFreq,
    txAllowed: txAllowed.value,
    tx,
    tone: {
      rx: buildTone(rxToneKind.value, rxCtcss.value, rxDtcs.value),
      tx: buildTone(txToneKind.value, txCtcss.value, txDtcs.value),
      rxInverted: props.channel.tone.rxInverted,
    },
    modulation: modulation.value,
    bandwidthHz: bandwidthHz.value,
    power: { mW: level.mW, label: level.label },
    tuningStep: hz(stepHz.value),
    // A channel that arrived receive-only keeps the reason it arrived with. A
    // rename used to replace it with "Marked receive-only", telling the next
    // reader somebody had marked it when a preset or the clamp had.
    ...(txAllowed.value
      ? {}
      : { txInhibitReason: (props.channel.txAllowed ? undefined : props.channel.txInhibitReason) ?? 'Marked receive-only' }),
    ...(supportsEncryption.value
      ? {
          extras: {
            ...props.channel.extras,
            vendor: {
              ...props.channel.extras.vendor,
              encryptionKeyId: String(encKeyId.value),
              // A channel encrypts only with a key slot and the enable bit both
              // set, so picking a key turns encryption on and picking None
              // turns it off. Leaving the picker alone leaves the bit as read.
              ...(encKeyId.value !== savedKeyId ? { encryptEnabled: encKeyId.value !== 0 ? '1' : '0' } : {}),
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
    <!--
      Pinned on a phone so a thumb reaches Apply without scrolling to the end of
      a form it did not need to read. `-mx-4 -mt-4` pulls it out of the modal's
      own padding so it spans the sheet, and `sticky` keeps it there while the
      body scrolls under it.
    -->
    <div
      v-if="phone"
      class="sticky z-10 -mx-4 -mt-4 mb-4 flex items-center"
      style="
        top: 0;
        height: 52px;
        padding: env(safe-area-inset-top) 6px 0;
        box-sizing: content-box;
        background: var(--pn);
        border-bottom: 1px solid var(--ln);
      "
    >
      <button
        type="button"
        style="height: 44px; padding: 0 12px; font-size: 15px; color: var(--mu)"
        @click="emit('close')"
      >Cancel</button>
      <span class="ms-auto me-auto text-center">
        <span style="display: block; font-size: 15px; font-weight: 600; color: var(--tx)">Slot {{ channel.index }}</span>
        <span style="display: block; font-size: 11.5px; color: var(--fn)">{{ name || 'unnamed' }}</span>
      </span>
      <button
        type="button"
        :disabled="!canSave"
        style="height: 44px; padding: 0 14px; font-size: 15px; font-weight: 600"
        :style="{ color: canSave ? 'var(--acTx)' : 'var(--ln2)' }"
        @click="save"
      >Apply</button>
    </div>
    <div :class="pair" class="space-y-4 sm:space-y-0">
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
        <span v-if="!txAllowed && arrivedReason" class="text-warning">{{ arrivedReason }}</span>
        <span v-else-if="!txAllowed" class="text-warning">
          Receive-only. {{ schema.rf.txInhibit ? schema.rf.txInhibit.mechanism : '' }}
        </span>
        <span v-else-if="txWarning" class="text-warning">{{ txWarning }}</span>
      </template>
    </UFormField>

    <div v-if="txAllowed" :class="pair" class="space-y-4 sm:space-y-0">
      <UFormField label="Shift">
        <USelect v-model="duplex" class="w-full" :items="shiftItems" />
        <!--
          Said, not enforced. The UV-K5's encoder refuses a split at write time
          with the same advice, and refusing Apply here would trap a rename
          behind a shift nobody came to change.
        -->
        <template v-if="duplex === 'split' && !splitStorable" #help>
          <span class="text-warning">
            This radio stores a shift, not a separate transmit frequency, so a write will refuse this channel
            as it stands. Pick Plus or Minus, or mark it receive-only.
          </span>
        </template>
      </UFormField>
      <UFormField v-if="duplex === 'plus' || duplex === 'minus'" label="Offset (MHz)" :error="txError ?? undefined">
        <UInput v-model="offsetText" class="w-full tabular" />
      </UFormField>
      <UFormField v-else-if="duplex === 'split'" label="Transmit (MHz)" :error="txError ?? undefined">
        <UInput v-model="txText" class="w-full tabular" />
      </UFormField>
    </div>

    <div :class="triple" class="space-y-4 sm:space-y-0">
      <UFormField label="Mode">
        <USelect
          v-model="modulation"
          class="w-full"
          :items="rf.modulations.map((m) => ({ value: m, label: m }))"
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

    <div :class="pair" class="space-y-4 sm:space-y-0">
      <UFormField label="Receive tone (opens squelch)">
        <div class="flex gap-2">
          <USelect v-model="rxToneKind" class="w-32" :items="toneKindOptions" />
          <USelect v-if="rxToneKind === 'ctcss'" v-model="rxCtcss" class="flex-1" :items="ctcssOptions" />
          <USelect v-else-if="rxToneKind === 'dtcs'" v-model="rxDtcs" class="flex-1" :items="dtcsOptions" />
        </div>
        <template #help>
          <span class="text-muted">
            Also called a privacy code or PL tone. Leave as None unless the repeater lists one.
          </span>
        </template>
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
            The talk group this channel calls. Analog channels have none.
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
            { value: 0, label: 'None (unencrypted)' },
            ...availableKeys.map((k) => ({ value: k.slot, label: `Slot ${k.slot} · ${k.name || 'unnamed'}` })),
          ]"
        />
        <template #help>
          <span v-if="availableKeys.length === 0" class="text-muted">
            No keys are defined yet. Add one on the Encryption keys page first.
          </span>
        </template>
      </UFormField>

      <!--
        Amber either way. A red alert is an error, and an error is what stops
        a save or a write here. This stops neither, so the icon and the title
        carry the difference instead.
      -->
      <UAlert
        v-if="encKeyId !== 0 && legality"
        :icon="legality.allowed ? 'i-lucide-shield' : 'i-lucide-shield-alert'"
        color="warning"
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
        :items="rf.tuningSteps.map((s) => ({ value: s as number, label: `${(s as number) / 1000} kHz` }))"
      />
    </UFormField>

    <div class="flex items-center gap-2 pt-2">
      <!--
        Apply and Cancel are in the pinned header on a phone. Delete is not:
        destructive, and sitting it beside Apply under a thumb is a mis-tap
        that cannot be undone from inside the app.
      -->
      <UButton v-if="!phone" icon="i-lucide-circle-check" label="Apply" :disabled="!canSave" @click="save" />
      <UButton v-if="!phone" label="Cancel" color="neutral" variant="ghost" @click="emit('close')" />
      <UButton
        :class="phone ? 'w-full justify-center' : 'ms-auto'"
        icon="i-lucide-trash-2"
        label="Delete channel"
        color="error"
        variant="subtle"
        @click="remove"
      />
    </div>
  </div>
</template>

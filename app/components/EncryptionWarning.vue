<script setup lang="ts">
/**
 * The encryption notice, and the gate it had to become.
 *
 * Encryption is an ordinary feature of licensed land-mobile operation and is
 * flatly prohibited on the amateur and personal radio services. The radio will
 * do it either way, so the tool is the only thing in the chain that can say so.
 *
 * It used to say so in a banner above the key slots, which is the same as not
 * saying it: a notice that sits in the same place every visit stops being read
 * within a week, and the slots underneath it were editable the whole time.
 * Unmissable and permanent are different things. So the notice now stands
 * between the user and the key editor and asks one question it cannot answer
 * itself - which service this radio operates under. Three of the four answers
 * end the screen. There is no override, because an override is what the
 * question is for.
 *
 * The `bar` variant is the same notice compressed to one line, for the screen
 * behind the gate: the citations have to stay visible while keys are being
 * typed, not just while the gate is being passed.
 */
const props = withDefaults(defineProps<{ variant?: 'gate' | 'bar' }>(), { variant: 'gate' })

const emit = defineEmits<{ unlock: [] }>()

const isGate = computed(() => props.variant === 'gate')

/**
 * The bar keeps the full notice one click away rather than restating it.
 *
 * The three paragraphs below are the same nodes in both variants, so the copy
 * behind the gate and the copy after it cannot drift apart.
 */
const expanded = ref(false)
const showBody = computed(() => isGate.value || expanded.value)

interface Service {
  id: string
  label: string
  icon: string
  /** How the refusal names the service in a sentence. */
  inSentence: string
}

const SERVICES: readonly Service[] = [
  { id: 'amateur', label: 'Amateur', icon: 'i-lucide-antenna', inSentence: 'amateur radio' },
  { id: 'gmrs', label: 'GMRS / FRS', icon: 'i-lucide-users', inSentence: 'GMRS and FRS' },
  { id: 'murs', label: 'MURS', icon: 'i-lucide-radio', inSentence: 'MURS' },
  { id: 'part90', label: 'Part 90 business', icon: 'i-lucide-scale', inSentence: 'Part 90 business' },
]

const service = ref<string | null>(null)
const chosen = computed(() => SERVICES.find((s) => s.id === service.value) ?? null)

/**
 * Everything except Part 90 is a refusal, and the refusal is final.
 *
 * There is no "continue anyway", no expander, no second click that opens the
 * slots. A gate with a way past it is a speed bump, and the thing on the other
 * side of this one is a federal offence rather than a broken codeplug.
 */
const refused = computed(() => chosen.value !== null && chosen.value.id !== 'part90')
const declared = computed(() => chosen.value?.id === 'part90')
</script>

<template>
  <div
    :style="{
      border: '1px solid var(--cnL)',
      background: isGate ? 'var(--pn)' : 'var(--cnB)',
      borderRadius: isGate ? '8px' : '6px',
      overflow: 'hidden',
    }"
  >
    <!-- Gate: the header band that has to be read before anything else on the screen. -->
    <div
      v-if="isGate"
      class="flex items-start gap-3"
      style="background: var(--cnB); border-bottom: 1px solid var(--cnL); padding: 14px 18px"
    >
      <UIcon
        name="i-lucide-shield-alert"
        class="shrink-0"
        style="width: 20px; height: 20px; color: var(--cn); margin-top: 1px"
      />
      <div>
        <div
          style="
            font-size: 10.5px;
            letter-spacing: 0.08em;
            text-transform: uppercase;
            color: var(--cn);
            font-weight: 600;
            margin-bottom: 4px;
          "
        >
          Licensed business and commercial use only
        </div>
        <h1 style="font-size: 17px; font-weight: 600; letter-spacing: -0.01em; color: var(--tx)">
          Encryption is unlawful on the services most of these radios are used on
        </h1>
      </div>
    </div>

    <!-- Bar: the same notice at one line, kept on screen while keys are edited. -->
    <div
      v-else
      class="flex items-center gap-2 flex-wrap"
      style="padding: 9px 12px"
    >
      <UIcon name="i-lucide-shield-alert" class="shrink-0" style="width: 13px; height: 13px; color: var(--cn)" />
      <span style="font-size: 12px; color: var(--cn); font-weight: 600">
        Unlawful on amateur, GMRS, FRS and MURS.
      </span>
      <span class="font-mono tabular" style="font-size: 11.5px; color: var(--mu)">
        47 CFR 97.113(a)(4) · 95.587 · 95.2731
      </span>
      <button
        type="button"
        class="ms-auto"
        style="font-size: 11.5px; color: var(--in)"
        :aria-expanded="expanded"
        @click="expanded = !expanded"
      >
        {{ expanded ? 'Hide the full notice' : 'Read the full notice' }}
      </button>
    </div>

    <div
      v-if="showBody"
      :style="{
        padding: '17px 18px',
        background: isGate ? 'transparent' : 'var(--pn)',
        borderTop: isGate ? 'none' : '1px solid var(--cnL)',
      }"
    >
      <div class="grid" style="gap: 9px" :style="{ marginBottom: isGate ? '16px' : '0' }">
        <p style="font-size: 13px; line-height: 1.6; color: var(--mu); max-width: 74ch">
          Encryption is permitted only where your licence authorises it — typically a
          <strong style="color: var(--tx); font-weight: 600">Part 90 land-mobile licence</strong>
          for business, industrial or public-safety operation.
        </p>
        <p style="font-size: 13px; line-height: 1.6; color: var(--mu); max-width: 74ch">
          It is <strong style="color: var(--tx); font-weight: 600">prohibited on amateur radio</strong>, which
          forbids transmissions encoded to obscure their meaning
          (<span class="font-mono tabular" style="font-size: 12px">47 CFR 97.113(a)(4)</span>), and on
          <strong style="color: var(--tx); font-weight: 600">GMRS, FRS and MURS</strong>. Programming an
          encrypted channel on those frequencies is unlawful even if the radio allows it.
        </p>
        <p style="font-size: 12.5px; line-height: 1.6; color: var(--fn); max-width: 74ch">
          boofwang does not check your licence. You are responsible for what you transmit.
        </p>
      </div>

      <div v-if="isGate" style="border-top: 1px solid var(--ln); padding-top: 15px">
        <div style="font-size: 12px; color: var(--mu); margin-bottom: 9px">
          Name the service this radio operates under:
        </div>

        <div class="flex flex-wrap gap-1.5" style="margin-bottom: 13px">
          <button
            v-for="s in SERVICES"
            :key="s.id"
            type="button"
            class="inline-flex items-center rounded-[6px]"
            style="height: 29px; padding: 0 12px; gap: 7px; font-size: 12.5px"
            :style="service === s.id
              ? { border: '1px solid var(--ln2)', background: 'var(--pn3)', color: 'var(--tx)', fontWeight: 600 }
              : { border: '1px solid var(--ln)', background: 'var(--pn)', color: 'var(--mu)', fontWeight: 400 }"
            :aria-pressed="service === s.id"
            @click="service = s.id"
          >
            <UIcon
              :name="s.icon"
              class="shrink-0"
              style="width: 13px; height: 13px"
              :style="{ color: service === s.id ? 'var(--tx)' : 'var(--fn)' }"
            />
            {{ s.label }}
          </button>
        </div>

        <div
          v-if="refused && chosen"
          class="flex items-start gap-2.5"
          style="border: 1px solid var(--dgL); background: var(--dgB); border-radius: 6px; padding: 11px 13px"
          role="alert"
        >
          <UIcon
            name="i-lucide-lock"
            class="shrink-0"
            style="width: 14px; height: 14px; color: var(--dg); margin-top: 1px"
          />
          <div>
            <div style="font-size: 12.5px; font-weight: 600; color: var(--dg); margin-bottom: 3px">
              Key slots stay locked on {{ chosen.inSentence }}
            </div>
            <p style="font-size: 12px; line-height: 1.55; color: var(--mu)">
              Encryption is prohibited on this service. You can still read, edit and write channels; the key
              editor is not available.
            </p>
          </div>
        </div>

        <RiskAction
          v-else-if="declared"
          risk="neutral"
          size="lg"
          icon="i-lucide-lock-open"
          label="I hold a Part 90 licence — open key slots"
          @click="emit('unlock')"
        />
      </div>
    </div>
  </div>
</template>

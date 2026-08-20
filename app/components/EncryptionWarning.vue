<script setup lang="ts">
/**
 * The encryption notice.
 *
 * Encryption is an ordinary feature of licensed land-mobile operation and is
 * flatly prohibited on the amateur and personal radio services. The radio will
 * do it either way, so the tool is the only thing in the chain that can say
 * which is which - and saying it is the whole job. The operator holds the
 * licence and decides; boofwang states the rule and the citation, and gets out
 * of the way.
 *
 * The `bar` variant is the same notice compressed to one line, so the citations
 * stay on screen while keys are being typed rather than only on the way in.
 */
const props = withDefaults(defineProps<{ variant?: 'gate' | 'bar' }>(), { variant: 'gate' })

const isGate = computed(() => props.variant === 'gate')

/**
 * The bar keeps the full notice one click away rather than restating it.
 *
 * The three paragraphs below are the same nodes in both variants, so the copy
 * behind the gate and the copy after it cannot drift apart.
 */
const expanded = ref(false)
const showBody = computed(() => isGate.value || expanded.value)

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
            font-size: 12px;
            letter-spacing: 0.08em;
            text-transform: uppercase;
            color: var(--cn);
            font-weight: 600;
            margin-bottom: 4px;
          "
        >
          Licensed business and commercial use only
        </div>
        <h1 style="font-size: 19px; font-weight: 600; letter-spacing: -0.01em; color: var(--tx)">
          Encryption is unlawful on the services most of these radios are used on
        </h1>
      </div>
    </div>

    <!-- Bar: the same notice at one line, kept on screen while keys are edited. -->
    <div
      v-else
      class="flex items-center gap-2 flex-wrap"
      style="padding: 12px 15px"
    >
      <UIcon name="i-lucide-shield-alert" class="shrink-0" style="width: 13px; height: 13px; color: var(--cn)" />
      <span style="font-size: 13.5px; color: var(--cn); font-weight: 600">
        Unlawful on amateur, GMRS, FRS and MURS.
      </span>
      <span class="font-mono tabular" style="font-size: 13px; color: var(--mu)">
        47 CFR 97.113(a)(4) · 95.587 · 95.2731
      </span>
      <button
        type="button"
        class="ms-auto"
        style="font-size: 13px; color: var(--in)"
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
      <div class="grid" style="gap: 9px">
        <p style="font-size: 14.5px; line-height: 1.6; color: var(--mu); max-width: 74ch">
          Encryption is permitted only where your licence authorises it — typically a
          <strong style="color: var(--tx); font-weight: 600">Part 90 land-mobile licence</strong>
          for business, industrial or public-safety operation.
        </p>
        <p style="font-size: 14.5px; line-height: 1.6; color: var(--mu); max-width: 74ch">
          It is <strong style="color: var(--tx); font-weight: 600">prohibited on amateur radio</strong>, which
          forbids transmissions encoded to obscure their meaning
          (<span class="font-mono tabular" style="font-size: 13.5px">47 CFR 97.113(a)(4)</span>), and on
          <strong style="color: var(--tx); font-weight: 600">GMRS, FRS and MURS</strong>. Programming an
          encrypted channel on those frequencies is unlawful even if the radio allows it.
        </p>
        <p style="font-size: 14px; line-height: 1.6; color: var(--fn); max-width: 74ch">
          boofwang does not check your licence. You are responsible for what you transmit.
        </p>
      </div>

    </div>
  </div>
</template>

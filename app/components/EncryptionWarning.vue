<script setup lang="ts">
/**
 * The notice that has to be impossible to miss.
 *
 * Encryption is an ordinary feature of licensed land-mobile operation and is
 * flatly prohibited on the amateur and personal radio services. The radio will
 * do it either way, so the tool is the only thing in the chain that can say so.
 */
defineProps<{ compact?: boolean }>()
</script>

<template>
  <UAlert
    icon="i-lucide-shield-alert"
    color="warning"
    variant="subtle"
    title="Licensed business and commercial use only"
  >
    <template #description>
      <div class="space-y-1.5 text-sm">
        <p>
          Encryption is permitted only where your licence authorises it — typically a
          <strong>Part 90 land-mobile licence</strong> for business, industrial or public-safety operation.
        </p>
        <p v-if="!compact">
          It is <strong>prohibited on amateur radio</strong>, which forbids transmissions encoded to obscure
          their meaning (47 CFR 97.113(a)(4)), and on <strong>GMRS, FRS and MURS</strong>. Programming an
          encrypted channel on those frequencies is unlawful even if the radio allows it.
        </p>
        <p class="text-muted">
          boofwang does not check your licence. You are responsible for what you transmit.
        </p>
      </div>
    </template>
  </UAlert>
</template>

<script setup lang="ts">
import type { Diagnostic } from '#core/radio/driver.js'

const props = defineProps<{ diagnostics: readonly Diagnostic[] }>()

/**
 * Grouped by rule rather than listed.
 *
 * A codeplug with 29 channels on the same receive-only band produces 29
 * identical sentences; printing the first three of them tells the reader
 * nothing except that something is repetitive. One line per rule, with a count
 * and the affected slots, is the same information in a form that can be acted
 * on.
 */
const groups = computed(() => {
  const byRule = new Map<string, Diagnostic[]>()
  for (const d of props.diagnostics) {
    const list = byRule.get(d.ruleId)
    if (list) list.push(d)
    else byRule.set(d.ruleId, [d])
  }
  const rank = { error: 0, warning: 1, info: 2 } as const
  return [...byRule.values()]
    .map((list) => {
      const slots = list.map((d) => d.channel).filter((n): n is number => n !== undefined)
      return {
        ruleId: list[0]!.ruleId,
        severity: list[0]!.severity,
        message: list[0]!.message,
        count: list.length,
        slots,
      }
    })
    .sort((a, b) => rank[a.severity] - rank[b.severity] || b.count - a.count)
})

function slotSummary(slots: number[]): string {
  if (slots.length === 0) return ''
  const shown = slots.slice(0, 8).join(', ')
  return slots.length > 8 ? `channels ${shown} and ${slots.length - 8} more` : `channel${slots.length > 1 ? 's' : ''} ${shown}`
}

const errors = computed(() => props.diagnostics.filter((d) => d.severity === 'error').length)
const warnings = computed(() => props.diagnostics.filter((d) => d.severity === 'warning').length)
</script>

<template>
  <UAlert
    v-if="diagnostics.length"
    :icon="errors ? 'i-lucide-circle-alert' : 'i-lucide-triangle-alert'"
    :color="errors ? 'error' : 'warning'"
    variant="subtle"
    :title="[errors ? `${errors} error${errors === 1 ? '' : 's'}` : '', warnings ? `${warnings} warning${warnings === 1 ? '' : 's'}` : ''].filter(Boolean).join(' · ')"
  >
    <template #description>
      <ul class="space-y-1.5 mt-1">
        <li v-for="g in groups" :key="g.ruleId" class="text-sm">
          <span v-if="g.count > 1" class="font-medium">{{ g.count }}× </span>
          {{ g.message }}
          <span v-if="g.slots.length" class="text-muted"> · {{ slotSummary(g.slots) }}</span>
        </li>
      </ul>
    </template>
  </UAlert>
</template>

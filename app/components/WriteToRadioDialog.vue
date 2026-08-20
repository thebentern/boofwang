<script setup lang="ts">
import { evaluateWriteGate } from '#core/radio/write-gate.js'

/**
 * What stands between an edit and the radio.
 *
 * Shows exactly what will be sent, refuses when anything is wrong, and never
 * lets the user click through a blocker. The driver enforces the important
 * checks again on its own; this exists to explain the situation rather than to
 * be the thing that prevents it.
 */
const emit = defineEmits<{ close: [] }>()

const codeplug = useCodeplugStore()
const device = useDeviceStore()
const session = useRadioSession()

const backup = ref<{ identHash: string } | null>(null)
onMounted(async () => {
  backup.value = await session.sessionBackup()
})

const gate = computed(() => {
  const pending = codeplug.pendingWrite
  return evaluateWriteGate({
    schema: codeplug.schema!,
    ident: device.ident,
    imageVariant: codeplug.image?.variant ?? null,
    imageRadioId: codeplug.image?.radioId ?? null,
    backup: backup.value,
    diagnostics: codeplug.diagnostics,
    encodeError: codeplug.encodeError,
    changedBytes: pending?.changedBytes ?? 0,
    unownedRanges: pending?.unowned ?? [],
  })
})

const changedChannels = computed(() => {
  const base = codeplug.image
  const driver = codeplug.driverRef
  if (!base || !driver) return []
  const before = driver.decode(base)
  const out: { index: number; from: string; to: string }[] = []
  const describe = (c: { name: string; rxFreq: number; txAllowed: boolean } | undefined) =>
    c ? `${c.name || '(unnamed)'} · ${(c.rxFreq / 1e6).toFixed(5)} MHz${c.txAllowed ? '' : ' · RX only'}` : '(empty)'

  const slots = new Set([...before.channels.keys(), ...(codeplug.doc?.channels.keys() ?? [])])
  for (const slot of [...slots].sort((a, b) => a - b)) {
    const a = before.channels.get(slot)
    const b = codeplug.doc?.channels.get(slot)
    if (JSON.stringify(a) === JSON.stringify(b)) continue
    out.push({ index: slot, from: describe(a), to: describe(b) })
  }
  return out
})

const busy = ref(false)
async function write() {
  busy.value = true
  try {
    await session.writeToRadio()
    emit('close')
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="space-y-4">
    <div v-if="gate.blockers.length" class="space-y-2">
      <UAlert
        v-for="b in gate.blockers"
        :key="b.code"
        icon="i-lucide-shield-alert"
        color="error"
        variant="subtle"
        :title="b.message"
        :description="b.remedy"
      />
    </div>

    <template v-else>
      <UAlert
        icon="i-lucide-circle-check"
        color="success"
        variant="subtle"
        title="Ready to write"
        :description="`${codeplug.pendingWrite?.changedBlocks.length ?? 0} block(s), ${codeplug.pendingWrite?.changedBytes ?? 0} byte(s) will be sent. Everything else on the radio is left untouched, including calibration.`"
      />

      <div v-if="changedChannels.length" class="space-y-1">
        <h3 class="text-sm font-medium">What changes</h3>
        <div class="rounded-md border border-default divide-y divide-default max-h-56 overflow-y-auto">
          <div v-for="c in changedChannels" :key="c.index" class="px-3 py-2 text-sm flex items-baseline gap-2">
            <span class="tabular text-muted w-10 shrink-0">{{ c.index }}</span>
            <span class="text-muted line-through">{{ c.from }}</span>
            <UIcon name="i-lucide-chevron-right" class="size-3.5 shrink-0 text-muted" />
            <span>{{ c.to }}</span>
          </div>
        </div>
      </div>

      <UAlert
        v-for="w in gate.warnings"
        :key="w.code"
        icon="i-lucide-triangle-alert"
        color="warning"
        variant="subtle"
        :title="w.message"
      />

      <p class="text-xs text-muted">
        A backup of this radio from this session is on file, and every block is read back and compared
        after writing. Leave the cable connected and the radio switched on until it finishes.
      </p>
    </template>

    <div class="flex items-center gap-2 pt-1">
      <UButton
        icon="i-lucide-upload"
        label="Write to radio"
        color="warning"
        :disabled="!gate.allowed || busy"
        :loading="busy"
        @click="write"
      />
      <UButton label="Cancel" color="neutral" variant="ghost" :disabled="busy" @click="emit('close')" />
    </div>
  </div>
</template>

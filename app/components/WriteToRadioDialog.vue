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

const backup = ref<{ identHash: string; createdAt?: string } | null>(null)

/**
 * How old the way back actually is.
 *
 * This used to assert the backup was "from this session", which was never
 * checked and often untrue - the newest stored backup of this radio wins,
 * whenever it was taken. Anything the radio has been told by other software
 * since then is not in it, so the age is the part worth showing.
 */
const backupAge = computed(() => {
  const at = backup.value?.createdAt
  if (!at) return 'A backup of this radio is on file.'
  const days = Math.floor((Date.now() - new Date(at).getTime()) / 86_400_000)
  if (days < 1) return 'A backup of this radio, taken today, is on file.'
  if (days === 1) return 'The newest backup of this radio is from yesterday.'
  return `The newest backup of this radio is ${days} days old. Anything changed on the radio since then is not in it.`
})
onMounted(async () => {
  backup.value = await session.latestBackupForOpenCodeplug()
})

const gate = computed(() => {
  const pending = codeplug.pendingWrite
  return evaluateWriteGate({
    schema: codeplug.schema!,
    // Null while disconnected, which is normal: the write flow connects when it
    // runs, and the driver re-checks identity against the radio on the cable.
    ident: device.ident,
    imageVariant: codeplug.image?.variant ?? null,
    imageRadioId: codeplug.image?.radioId ?? null,
    backup: backup.value,
    diagnostics: codeplug.diagnostics,
    encodeError: codeplug.encodeError,
    changedBytes: pending?.changedBytes ?? 0,
    unownedRanges: pending?.unowned ?? [],
    documentDirty: codeplug.dirty,
    transport: device.lastKind,
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
        {{ backupAge }} Every block is read back and compared after writing. {{ device.keepLinkUp }}
        until it finishes.
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

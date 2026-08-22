<script setup lang="ts">
/**
 * What am I working on, and is it safe?
 *
 * The old interface scattered this: connection state on one page, unsaved edits
 * implied by a button becoming enabled, and whether a backup existed only
 * discoverable by opening the write dialog. Someone three edits deep had no way
 * to answer the question without navigating away from their work.
 *
 * Four segments, always in the same order, always present while a codeplug is
 * open. The write button lives here because this is the only place that knows
 * all four answers at once - and it stays disabled while any error-severity
 * diagnostic exists, so the bar cannot invite an action the gate will refuse.
 *
 * The two document-wide actions sit to the right of the segments rather than
 * inside them, so that what the bar reports and what it offers stay separable:
 * undo and redo belong here for the same reason the write button does, which
 * is that they act on the whole codeplug rather than on whatever page happens
 * to be open.
 */
const codeplug = useCodeplugStore()
const session = useRadioSession()

/**
 * The keyboard half of the undo control below.
 *
 * Installed here rather than in the layout so that the shortcut and the two
 * buttons are mounted by the same component: they are one affordance, and a
 * keyboard path that outlives its buttons is how the pair drifts apart.
 */
useUndoShortcut()

const backup = ref<{ identHash: string; createdAt?: string } | null>(null)
const backupPending = ref(true)

async function refreshBackup() {
  backupPending.value = true
  try {
    backup.value = await session.latestBackupForOpenCodeplug()
  } finally {
    backupPending.value = false
  }
}

onMounted(refreshBackup)
watch(() => codeplug.image, refreshBackup)

const radioName = computed(() => {
  const s = codeplug.schema
  return s ? `${s.vendor} ${s.model}` : ''
})

const firmware = computed(() => codeplug.image?.variant ?? '')

/** Time only: the date is noise when the backup is from this session. */
const backupTime = computed(() => {
  const at = backup.value?.createdAt
  if (!at) return null
  const d = new Date(at)
  return Number.isNaN(d.getTime()) ? null : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
})

const errors = computed(() => codeplug.errorCount)
const canWrite = computed(() => codeplug.schema?.capabilities.write === true)

/**
 * The hint names the single next thing to do.
 *
 * An error outranks a missing backup because it is the one the user can fix
 * without touching hardware.
 */
const hint = computed(() => {
  if (errors.value > 0) return 'Fix the error first'
  if (!backup.value) return 'Read the radio to get a way back'
  if (!codeplug.dirty) return 'No unwritten edits'
  return 'Backup on file · diff before send'
})
</script>

<template>
  <!--
    Not printed: every segment here is about the live session - whether a port
    is open, whether there are unwritten edits, whether a way back exists - and
    all four are stale the moment the page leaves the screen.
  -->
  <!--
    Wraps. At 375px the single 36px row measured 659px wide and the document
    scrolled sideways, with undo and "Write to radio" off the right edge - on
    the phone that is the one place the Bluetooth flow is meant to run.
    `min-height` instead of `height` lets a second row exist; the segments keep
    their own height so the single-row case looks exactly as it did.
  -->
  <div
    v-if="codeplug.isOpen"
    class="flex items-center flex-wrap print-hide"
    style="min-height: 36px; background: var(--pn2); border-bottom: 1px solid var(--ln)"
  >
    <div class="mx-auto w-full max-w-[1400px] px-4 flex items-center flex-wrap gap-y-1" style="min-height: 36px">
      <!-- Radio -->
      <div class="flex items-center gap-2 pe-3.5" style="height: 36px; border-right: 1px solid var(--ln)">
        <UIcon name="i-lucide-radio" class="size-3.5 shrink-0" style="color: var(--fn)" />
        <span style="font-size: 14px; font-weight: 600; color: var(--tx)">{{ radioName }}</span>
        <span v-if="firmware" class="font-mono tabular" style="font-size: 12.5px; color: var(--fn)">{{ firmware }}</span>
      </div>

      <!-- Edits -->
      <div class="flex items-center gap-2 px-3.5" style="height: 36px; border-right: 1px solid var(--ln)">
        <span class="label-xs">Edits</span>
        <span
          class="chip"
          :style="codeplug.dirty
            ? { background: 'var(--inB)', color: 'var(--in)' }
            : { background: 'var(--pn3)', color: 'var(--fn)' }"
        >{{ codeplug.dirty ? 'unwritten' : 'none' }}</span>
      </div>

      <!-- Way back -->
      <div class="flex items-center gap-2 px-3.5" style="height: 36px; border-right: 1px solid var(--ln)">
        <span class="label-xs">Way back</span>
        <span
          v-if="backupPending"
          class="chip"
          style="background: var(--pn3); color: var(--fn)"
        >checking…</span>
        <span
          v-else-if="backupTime"
          class="chip"
          style="background: var(--okB); color: var(--ok)"
        >backup {{ backupTime }}</span>
        <span
          v-else
          class="chip"
          style="background: var(--dgB); color: var(--dg)"
        >none</span>
      </div>

      <!-- Checks -->
      <div class="flex items-center gap-2 px-3.5 h-full">
        <span class="label-xs">Checks</span>
        <span
          v-if="errors > 0"
          class="chip"
          style="background: var(--dgB); color: var(--dg)"
        >{{ errors }} error{{ errors === 1 ? '' : 's' }}</span>
        <span
          v-else
          class="chip"
          style="background: var(--okB); color: var(--ok)"
        >clear</span>
      </div>

      <div class="ms-auto flex items-center gap-3">
        <!--
          Undo and redo sit here rather than on any one page because the
          history is one stack over the whole document. An import of eight
          hundred talk groups is made on the DMR page, and before this the only
          way to take it back was to navigate to the channel table and press
          the button that happened to live there.
        -->
        <UndoRedo />
        <span class="hidden md:inline" style="font-size: 13px; color: var(--fn)">{{ hint }}</span>
        <RiskAction
          v-if="canWrite"
          risk="caution"
          label="Write to radio"
          icon="i-lucide-upload"
          size="sm"
          :disabled="errors > 0 || !codeplug.dirty"
          @click="navigateTo('/write')"
        />
      </div>
    </div>
  </div>
</template>

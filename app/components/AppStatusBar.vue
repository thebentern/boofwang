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

/**
 * Three forms of one bar, because four labelled segments do not fit a phone.
 *
 * At 375px the segments plus undo/redo plus the write button measured 659px and
 * wrapped to two rows. Wrapping was the stopgap; this is the fix. Below 640 the
 * bar is one 48px line that opens, between 640 and 1024 it is one 40px row of
 * chips with no uppercase labels, and above 1024 it is exactly what it was.
 */
const { phone, medium } = useFormFactor()

/** Collapsed by default: the bar is a status line, not a panel. */
const open = ref(false)

/**
 * The model without its vendor, for the collapsed line.
 *
 * "Baofeng DM-32UV" and a firmware string do not both fit beside three chips
 * and a write button. The vendor is the half a person already knows - they are
 * holding the radio - so the model is what stays.
 */
const shortName = computed(() => codeplug.schema?.model ?? radioName.value)

/*
 * The uppercase segment labels are gone below 1024 rather than shrunk. They
 * were a 96px fixed column naming chips that already read "unwritten",
 * "backup 19:46" and "checks clear" - the label and the chip said the same
 * thing twice, and only one of them fitted.
 */
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
  <!--
    The phone form: one line that opens.

    A status bar earns its height by being glanceable, and four labelled
    segments are not glanceable on a 375px screen - they are a paragraph. So
    the line carries the model, whether there are unwritten edits, whether a
    way back exists, and the one button that acts. Everything else is behind a
    tap, which is the right price for a detail nobody reads every time.
  -->
  <div v-if="codeplug.isOpen" class="print-hide">
    <div
      v-if="phone"
      style="background: var(--pn2); border-bottom: 1px solid var(--ln)"
    >
    <button
      type="button"
      class="flex items-center w-full"
      style="min-height: 48px; padding: 0 8px 0 14px; gap: 9px; text-align: left"
      :aria-expanded="open"
      aria-label="Session status"
      @click="open = !open"
    >
      <UIcon name="i-lucide-radio" class="shrink-0" style="width: 14px; height: 14px; color: var(--fn)" />
      <span
        class="whitespace-nowrap"
        style="flex: none; font-size: 13.5px; font-weight: 600; color: var(--tx)"
      >{{ shortName }}</span>
      <UIcon
        :name="open ? 'i-lucide-chevron-up' : 'i-lucide-chevron-down'"
        class="shrink-0"
        style="width: 14px; height: 14px; color: var(--fn)"
      />

      <span
        v-if="codeplug.dirty"
        class="inline-flex items-center whitespace-nowrap"
        style="flex: none; gap: 4px; font-size: 11.5px; padding: 2.5px 7px; border-radius: 4px; background: var(--inB); color: var(--in)"
      >
        <UIcon name="i-lucide-pencil" style="width: 12px; height: 12px" />
        unwritten
      </span>

      <span
        class="inline-flex items-center whitespace-nowrap"
        style="flex: none; gap: 4px; font-size: 11.5px; padding: 2.5px 7px; border-radius: 4px; margin-right: auto"
        :style="backupTime
          ? { background: 'var(--okB)', color: 'var(--ok)' }
          : { background: 'var(--dgB)', color: 'var(--dg)' }"
      >
        <UIcon name="i-lucide-check" style="width: 12px; height: 12px" />
        {{ backupPending ? 'checking' : backupTime ? backupTime : 'none' }}
      </span>

      <RiskAction
        v-if="canWrite"
        risk="caution"
        label="Write"
        icon="i-lucide-upload"
        size="sm"
        :disabled="errors > 0 || !codeplug.dirty"
        @click.stop="navigateTo('/write')"
      />
    </button>

    <div v-if="open" style="padding: 10px 14px 12px; border-top: 1px solid var(--ln)">
      <div class="flex items-center flex-wrap" style="gap: 6px; margin-bottom: 10px">
        <span v-if="firmware" class="font-mono tabular" style="font-size: 12px; color: var(--fn)">{{ firmware }}</span>
        <span
          v-if="codeplug.dirty"
          class="inline-flex items-center"
          style="gap: 5px; font-size: 12px; padding: 4px 9px; border-radius: 5px; background: var(--inB); color: var(--in)"
        >
          <UIcon name="i-lucide-pencil" style="width: 12px; height: 12px" />
          unwritten
        </span>
        <span
          class="inline-flex items-center"
          style="gap: 5px; font-size: 12px; padding: 4px 9px; border-radius: 5px"
          :style="backupTime ? { background: 'var(--okB)', color: 'var(--ok)' } : { background: 'var(--dgB)', color: 'var(--dg)' }"
        >
          <UIcon name="i-lucide-history" style="width: 12px; height: 12px" />
          {{ backupTime ? `backup ${backupTime}` : 'no backup' }}
        </span>
        <span
          class="inline-flex items-center"
          style="gap: 5px; font-size: 12px; padding: 4px 9px; border-radius: 5px"
          :style="errors > 0 ? { background: 'var(--dgB)', color: 'var(--dg)' } : { background: 'var(--okB)', color: 'var(--ok)' }"
        >
          <UIcon :name="errors > 0 ? 'i-lucide-circle-alert' : 'i-lucide-circle-check'" style="width: 12px; height: 12px" />
          {{ errors > 0 ? `${errors} error${errors === 1 ? '' : 's'}` : 'checks clear' }}
        </span>
      </div>

      <!--
        Undo keeps its word. lucide's offline bundle has no undo arrow, so the
        two icons are approximations of each other and the label is the only
        thing telling them apart.
      -->
      <div class="flex items-center" style="gap: 8px">
        <UndoRedo roomy />
        <RiskAction
          v-if="canWrite"
          class="grow justify-center"
          style="height: 48px; border-radius: 8px; font-size: 14.5px"
          risk="caution"
          label="Write to radio"
          icon="i-lucide-upload"
          :disabled="errors > 0 || !codeplug.dirty"
          @click="navigateTo('/write')"
        />
      </div>
    </div>
  </div>

  <!--
    The middle band: one 40px row of the same chips, no uppercase labels.

    A tablet has room for the facts on one line but not for a 96px column
    naming each of them. The labels went rather than the chips because the chip
    already reads "unwritten" or "backup 19:46" - the label was saying it twice.
  -->
    <div
      v-else-if="medium"
      style="background: var(--pn2); border-bottom: 1px solid var(--ln)"
    >
    <div class="mx-auto w-full max-w-[1400px] px-4 flex items-center" style="height: 40px; gap: 8px">
      <UIcon name="i-lucide-radio" class="shrink-0" style="width: 14px; height: 14px; color: var(--fn)" />
      <span class="whitespace-nowrap" style="flex: none; font-size: 14px; font-weight: 600; color: var(--tx)">
        {{ radioName }}
      </span>
      <span
        v-if="firmware"
        class="font-mono tabular whitespace-nowrap"
        style="flex: none; font-size: 12.5px; color: var(--fn)"
      >{{ firmware }}</span>

      <span
        v-if="codeplug.dirty"
        class="chip whitespace-nowrap"
        style="flex: none; background: var(--inB); color: var(--in)"
      >unwritten</span>
      <span
        class="chip whitespace-nowrap"
        style="flex: none"
        :style="backupTime ? { background: 'var(--okB)', color: 'var(--ok)' } : { background: 'var(--dgB)', color: 'var(--dg)' }"
      >{{ backupPending ? 'checking' : backupTime ? `way back ${backupTime}` : 'no way back' }}</span>
      <span
        class="chip whitespace-nowrap"
        style="flex: none"
        :style="errors > 0 ? { background: 'var(--dgB)', color: 'var(--dg)' } : { background: 'var(--okB)', color: 'var(--ok)' }"
      >{{ errors > 0 ? `${errors} error${errors === 1 ? '' : 's'}` : 'checks clear' }}</span>

      <div class="ms-auto flex items-center" style="gap: 8px">
        <UndoRedo />
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

    <div
      v-else
      class="flex items-center flex-wrap"
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
  </div>
</template>

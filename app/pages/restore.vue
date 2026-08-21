<script setup lang="ts">
import type { StoredBackup } from '#core/storage/db.js'
import { fromStoredBackup } from '#core/storage/db.js'
import { SCHEMAS, isImplemented } from '#core/radio/registry.js'

/**
 * The restore confirmation, on its own screen.
 *
 * A dialog over the backup list would put the most consequential action in the
 * app in the same frame as three routine ones, and leave it one stray click
 * from dismissal. Giving it a screen costs a navigation and buys the thing the
 * risk register is for: restoring cannot happen by accident.
 *
 * There is deliberately no diff here. A write shows one because divergence
 * between the image and the radio is unintended; a restore is the opposite -
 * the radio is expected to differ, and making it match again is the whole
 * request - so a diff would invite a decision that is already made.
 */
useSeoMeta({ title: 'Restore' })

const route = useRoute()
const db = useBoofwangDb()
const session = useRadioSession()
const transfer = useTransferStore()

const backup = ref<StoredBackup | null>(null)
const loading = ref(true)
const restoring = ref(false)

const id = computed(() => (typeof route.query.id === 'string' ? route.query.id : ''))

onMounted(async () => {
  backup.value = id.value ? ((await db.getBackup(id.value)) ?? null) : null
  loading.value = false
})

const schema = computed(() => (backup.value ? SCHEMAS[backup.value.radioId] : null))
const hasDriver = computed(() => (backup.value ? isImplemented(backup.value.radioId) : false))
const canWrite = computed(() => hasDriver.value && schema.value?.capabilities.write === true)

/**
 * What a write on this radio can actually reach, when it is not everything.
 *
 * The DM-32UV driver reaches channels, zones, talk groups, scan list names, RX
 * groups, settings, the DMR address book and key slots, but not scan list
 * membership or the twenty-odd blocks nothing has decoded; every other byte is
 * read,
 * preserved and never written back. Calling that a restore without saying so
 * would leave someone believing their whole radio had been rolled back when
 * only part of it was.
 */
const writeScope = computed(() => schema.value?.capabilities.writeScope ?? null)

const takenAt = computed(() => {
  const at = backup.value?.createdAt
  if (!at) return ''
  const d = new Date(at)
  return Number.isNaN(d.getTime())
    ? at
    : d.toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
})

async function confirmRestore() {
  const b = backup.value
  if (!b || restoring.value) return
  restoring.value = true
  try {
    // The composable owns the sequence - reconnect, write, verify - and reports
    // what was actually sent rather than what was asked for. This page's job
    // ends at the decision.
    await session.restoreToRadio(fromStoredBackup(b))
  } finally {
    restoring.value = false
  }
  await navigateTo('/backups')
}
</script>

<template>
  <div v-if="restoring" class="mx-auto" style="max-width: 520px; padding: 80px 16px">
    <div style="border: 1px solid var(--dgL); background: var(--pn); border-radius: 8px; padding: 20px">
      <div class="flex items-center gap-2" style="margin-bottom: 7px">
        <UIcon name="i-lucide-triangle-alert" class="size-3.5 shrink-0" style="color: var(--dg)" />
        <span style="font-size: 12px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--dg); font-weight: 600">
          Do not unplug
        </span>
      </div>
      <h1 style="font-size: 19px; font-weight: 600; margin-bottom: 14px">Restoring the radio</h1>

      <div style="height: 4px; border-radius: 2px; background: var(--pn3); overflow: hidden; margin-bottom: 9px">
        <div
          style="height: 100%; background: var(--dg); transition: width 120ms linear"
          :style="{ width: `${transfer.percent}%` }"
        />
      </div>
      <div class="flex items-center justify-between" style="font-size: 13px; color: var(--mu); margin-bottom: 14px">
        <span>{{ transfer.phase ?? 'connecting' }}</span>
        <span v-if="transfer.total" class="font-mono tabular">
          {{ transfer.done.toLocaleString() }} / {{ transfer.total.toLocaleString() }} bytes
        </span>
      </div>

      <p style="font-size: 13px; line-height: 1.55; color: var(--fn)">
        Each block is written, read back and compared. Leave the cable connected and the radio switched on.
      </p>
    </div>
  </div>

  <div v-else class="mx-auto" style="max-width: 560px; padding: 70px 16px">
    <USkeleton v-if="loading" class="h-48" />

    <div
      v-else-if="!backup"
      style="border: 1px solid var(--ln); background: var(--pn); border-radius: 8px; padding: 22px"
    >
      <h1 style="font-size: 17.5px; font-weight: 600; margin-bottom: 6px">That backup is not in this browser</h1>
      <p style="font-size: 14px; line-height: 1.6; color: var(--mu); margin-bottom: 14px">
        Backups live in this browser only, so a link to one does not travel. Pick it from the list instead.
      </p>
      <RiskAction risk="neutral" ghost icon="i-lucide-history" label="Back to backups" @click="navigateTo('/backups')" />
    </div>

    <!--
      The card only wears the destructive tone when the action is actually on
      offer. A red frame and "overwrites the radio" above a refusal would spend
      the strongest colour in the system on something that cannot happen, which
      is how a warning stops being read.
    -->
    <div
      v-else
      style="background: var(--pn); border-radius: 8px; overflow: hidden"
      :style="{ border: `1px solid var(${canWrite ? '--dgL' : '--ln'})` }"
    >
      <div
        class="flex items-start gap-3"
        style="padding: 13px 17px"
        :style="canWrite
          ? { background: 'var(--dgB)', borderBottom: '1px solid var(--dgL)' }
          : { background: 'var(--pn2)', borderBottom: '1px solid var(--ln)' }"
      >
        <UIcon
          :name="canWrite ? 'i-lucide-triangle-alert' : 'i-lucide-lock'"
          class="size-4 shrink-0"
          :style="{ color: `var(${canWrite ? '--dg' : '--fn'})`, marginTop: '2px' }"
        />
        <div>
          <div
            style="font-size: 12px; letter-spacing: 0.08em; text-transform: uppercase; font-weight: 600; margin-bottom: 3px"
            :style="{ color: `var(${canWrite ? '--dg' : '--fn'})` }"
          >
            {{ canWrite ? 'Overwrites the radio' : 'Nothing will be sent' }}
          </div>
          <h1 style="font-size: 17.5px; font-weight: 600">
            {{ canWrite ? `Restore the radio to ${takenAt}` : 'This image cannot be put back' }}
          </h1>
        </div>
      </div>

      <div style="padding: 16px 17px">
        <p v-if="canWrite" style="font-size: 14px; line-height: 1.6; color: var(--mu); margin-bottom: 13px">
          Whatever is on the radio now is replaced by this image. Anything programmed since that read — by boofwang or
          by anything else — is gone. There is no diff here on purpose: a restore expects the radio to differ.
        </p>

        <div
          class="grid"
          style="border: 1px solid var(--ln); border-radius: 6px; background: var(--pn2); padding: 10px 12px; margin-bottom: 15px; gap: 6px"
        >
          <div class="flex items-center gap-2">
            <UIcon name="i-lucide-cpu" class="size-3.5 shrink-0" style="color: var(--fn)" />
            <span class="font-mono tabular" style="font-size: 13px; color: var(--mu)">
              {{ backup.radioId }} · {{ backup.variant }} · {{ backup.byteLength.toLocaleString() }} bytes
            </span>
          </div>
          <div class="flex items-center gap-2 min-w-0">
            <UIcon name="i-lucide-hash" class="size-3.5 shrink-0" style="color: var(--fn)" />
            <span class="font-mono tabular truncate" style="font-size: 13px; color: var(--fn)" :title="backup.sha256">
              sha256 {{ backup.sha256.slice(0, 16) }}…
            </span>
          </div>
        </div>

        <p v-if="!canWrite" style="font-size: 14px; line-height: 1.6; color: var(--mu); margin-bottom: 15px">
          <template v-if="!hasDriver">
            There is no driver for the {{ backup.radioId }} yet, so boofwang cannot put this image back.
          </template>
          <template v-else>
            boofwang can read the {{ schema?.model }} but cannot write to it, so this image cannot be put back.
          </template>
          The image is still yours: save it from the backups list and program it with something that can.
        </p>

        <div
          v-else-if="writeScope"
          class="flex items-start gap-2.5"
          style="border: 1px solid var(--cnL); background: var(--cnB); border-radius: 6px; padding: 17px 19px; margin-bottom: 15px"
        >
          <UIcon name="i-lucide-circle-dot" class="size-3.5 shrink-0" style="color: var(--cn); margin-top: 2px" />
          <p style="font-size: 14px; line-height: 1.6; color: var(--mu)">
            <strong style="font-weight: 600; color: var(--tx)">
              The {{ schema?.model }} only accepts writes to its {{ writeScope }}.
            </strong>
            Those are put back and nothing else. The radio's own ordering of its talk group list, roaming
            zone membership, and the twenty-odd memory blocks nobody has decoded stay exactly as the radio
            has them now — as do the individual settings inside other structures whose meaning is a guess. The count at the end is of what was actually sent, so this is
            not the full rollback the word restore usually promises.
          </p>
        </div>

        <ConfirmTyped
          v-if="canWrite"
          token="RESTORE"
          risk="destructive"
          icon="i-lucide-upload"
          label="Restore now"
          @confirm="confirmRestore()"
        >
          <template #secondary>
            <RiskAction risk="neutral" ghost label="Cancel" @click="navigateTo('/backups')" />
          </template>
        </ConfirmTyped>

        <RiskAction
          v-else
          risk="neutral"
          ghost
          icon="i-lucide-history"
          label="Back to backups"
          @click="navigateTo('/backups')"
        />

        <p v-if="canWrite" style="margin-top: 14px; font-size: 13px; line-height: 1.6; color: var(--fn)">
          No base image is supplied for a restore, so the driver reads the radio and sends only the blocks that differ,
          reading each one back before sending the next. A block that fails verification stops the restore there and
          the radio keeps the blocks already confirmed.
        </p>
      </div>
    </div>
  </div>
</template>

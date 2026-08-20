<script setup lang="ts">
import type { StoredBackup } from '#core/storage/db.js'
import { fromStoredBackup } from '#core/storage/db.js'
import { encodeBwp } from '#core/io/bwp.js'
import { SCHEMAS, createDriver, isImplemented } from '#core/radio/registry.js'

useSeoMeta({ title: 'Backups' })

const db = useBoofwangDb()
const codeplug = useCodeplugStore()
const toast = useToast()

const backups = ref<StoredBackup[]>([])
const loading = ref(true)
const persisted = ref<boolean | null>(null)
const canAskToPersist = ref(false)

async function refresh() {
  backups.value = await db.listBackups()
  loading.value = false
}

onMounted(async () => {
  await refresh()
  // Whether the browser exposes the request at all is a separate question from
  // whether it has already granted it, and offering a button that cannot do
  // anything is worse than saying nothing.
  canAskToPersist.value = typeof navigator.storage?.persist === 'function'
  persisted.value = (await navigator.storage?.persisted?.()) ?? null
})

/**
 * Where a stored image came from, in the user's words.
 *
 * A pre-write backup is the one taken because something was about to change,
 * so it is the only origin that spends colour: it marks the point a radio was
 * last altered, which is exactly what someone hunting for a way back is after.
 */
const ORIGIN = {
  download: { label: 'Read from radio', icon: 'i-lucide-download', caution: false },
  'pre-write': { label: 'Taken before a write', icon: 'i-lucide-upload', caution: true },
  import: { label: 'Imported', icon: 'i-lucide-file-down', caution: false },
} as const

/**
 * The image the open codeplug was decoded from.
 *
 * Matched on the content hash rather than the record id, because a write
 * reloads the store from the encoded image while keeping the base hash - so
 * the row that is still the baseline stays marked as one after a write.
 */
function isBaseline(b: StoredBackup) {
  const open = codeplug.image
  return open !== null && open.sha256 === b.sha256 && b.radioId === codeplug.doc?.radio
}

function canRestore(b: StoredBackup) {
  return isImplemented(b.radioId) && SCHEMAS[b.radioId]?.capabilities.write === true
}

async function openBackup(b: StoredBackup) {
  if (!isImplemented(b.radioId)) {
    toast.add({ title: 'No driver', description: `boofwang cannot decode ${b.radioId} images yet.`, color: 'warning' })
    return
  }
  codeplug.load(fromStoredBackup(b), createDriver(b.radioId))
  await navigateTo('/channels')
}

async function download(b: StoredBackup) {
  await saveFile(await encodeBwp(fromStoredBackup(b)), `${b.label.replace(/[^\w.-]+/g, '_')}.bwp`, 'application/octet-stream')
}

/**
 * Restore is a screen, not a button.
 *
 * It overwrites the radio, so it belongs in the same register as a write and
 * asks the same way. Handing off the record id rather than the image keeps this
 * page from holding a second copy of hundreds of kilobytes, and means a
 * bookmarked or reloaded confirm screen re-reads the image it is about to send
 * instead of confirming against nothing.
 */
function goToRestore(b: StoredBackup) {
  return navigateTo({ path: '/restore', query: { id: b.id } })
}

/**
 * Deleting is destructive, so it asks - but not with a typed token.
 *
 * Typing a word is reserved for the two actions that change the radio. Losing a
 * stored image is recoverable by reading the radio again, so the cost here is a
 * second click and a sentence naming what goes, which is enough to stop the
 * misclick without training anyone to type through prompts.
 */
const pendingDelete = ref<string | null>(null)

async function remove(b: StoredBackup) {
  await db.deleteBackup(b.id)
  pendingDelete.value = null
  await refresh()
}

async function askPersist() {
  persisted.value = await db.requestPersistence()
  toast.add(
    persisted.value
      ? { title: 'Storage will be kept', description: 'The browser has agreed to keep your backups.', color: 'success' }
      : { title: 'Not granted', description: 'The browser declined. Download anything you cannot afford to lose.', color: 'warning' },
  )
}
</script>

<template>
  <div class="mx-auto" style="max-width: 900px; padding: 22px 16px 48px">
    <div class="flex items-center flex-wrap gap-x-2.5 gap-y-1" style="margin-bottom: 11px">
      <UIcon name="i-lucide-history" class="size-4 shrink-0" style="color: var(--mu)" />
      <h1 style="font-size: 19px; font-weight: 600; letter-spacing: -0.02em">Backups</h1>
      <span style="font-size: 13.5px; color: var(--fn)">
        Every read is saved here automatically, in this browser only.
      </span>
    </div>

    <div
      v-if="persisted !== true"
      class="flex items-center flex-wrap gap-2.5"
      style="border: 1px solid var(--cnL); background: var(--cnB); border-radius: 6px; padding: 13px 16px; margin-bottom: 11px"
    >
      <UIcon name="i-lucide-triangle-alert" class="size-3.5 shrink-0" style="color: var(--cn)" />
      <span style="font-size: 14px; color: var(--tx)">
        <strong style="font-weight: 600">These backups can be evicted.</strong>
        <span style="color: var(--mu)">
          Browsers discard script-created storage under pressure, and Safari drops it after a week without a visit.
        </span>
      </span>
      <RiskAction
        v-if="canAskToPersist"
        class="ms-auto"
        risk="caution"
        size="sm"
        icon=""
        label="Ask the browser to keep it"
        @click="askPersist()"
      />
    </div>

    <USkeleton v-if="loading" class="h-24" />

    <div
      v-else-if="!backups.length"
      class="flex items-center gap-3"
      style="border: 1px solid var(--ln); background: var(--pn); border-radius: 7px; padding: 19px 21px"
    >
      <UIcon name="i-lucide-history" class="size-4 shrink-0" style="color: var(--fn)" />
      <div>
        <p style="font-size: 15px; font-weight: 600">Nothing saved yet</p>
        <p style="font-size: 14px; color: var(--mu)">Read a radio and its codeplug will appear here.</p>
      </div>
    </div>

    <div v-else style="border: 1px solid var(--ln); background: var(--pn); border-radius: 7px; overflow: hidden">
      <div
        v-for="(b, i) in backups"
        :key="b.id"
        style="padding: 11px 14px"
        :style="{ borderBottom: i < backups.length - 1 ? '1px solid var(--ln)' : 'none' }"
      >
        <div class="flex items-center flex-wrap gap-3">
          <UIcon
            :name="ORIGIN[b.origin].icon"
            class="size-3.5 shrink-0"
            :style="{ color: ORIGIN[b.origin].caution ? 'var(--cn)' : 'var(--fn)' }"
          />

          <div class="min-w-0 flex-1">
            <div class="flex items-baseline flex-wrap gap-2" style="margin-bottom: 3px">
              <span style="font-size: 14px; font-weight: 600">{{ b.label }}</span>
              <span
                class="chip"
                :style="ORIGIN[b.origin].caution
                  ? { background: 'var(--cnB)', color: 'var(--cn)', border: '1px solid var(--cnL)' }
                  : { background: 'var(--pn2)', color: 'var(--mu)', border: '1px solid var(--ln)' }"
              >{{ ORIGIN[b.origin].label }}</span>
              <span
                v-if="isBaseline(b)"
                class="chip"
                style="background: var(--okB); color: var(--ok); border: 1px solid var(--okL)"
              >current baseline</span>
            </div>
            <div class="font-mono tabular truncate" style="font-size: 12.5px; color: var(--fn)" :title="b.sha256">
              {{ b.radioId }} · {{ b.byteLength.toLocaleString() }} bytes · sha256 {{ b.sha256.slice(0, 16) }}…
            </div>
          </div>

          <div class="flex items-center gap-1.5 shrink-0">
            <RiskAction
              risk="neutral"
              size="sm"
              ghost
              icon="i-lucide-pencil"
              label="Open"
              :disabled="!isImplemented(b.radioId)"
              :title="isImplemented(b.radioId) ? undefined : `boofwang cannot decode ${b.radioId} images yet.`"
              @click="openBackup(b)"
            />
            <RiskAction
              risk="neutral"
              size="sm"
              ghost
              icon="i-lucide-download"
              label="Save"
              @click="download(b)"
            />
            <RiskAction
              risk="destructive"
              size="sm"
              ghost
              icon="i-lucide-upload"
              label="Restore"
              :disabled="!canRestore(b)"
              :title="canRestore(b) ? undefined : `boofwang can read the ${b.radioId} but cannot write to it, so this image cannot be put back.`"
              @click="goToRestore(b)"
            />
            <RiskAction
              risk="destructive"
              size="sm"
              ghost
              icon="i-lucide-trash-2"
              :title="`Delete ${b.label}`"
              @click="pendingDelete = pendingDelete === b.id ? null : b.id"
            />
          </div>
        </div>

        <!--
          The confirmation gets its own line rather than the row's spare width:
          four actions and a sentence do not fit side by side, and a row that
          reflows on click moves the thing being confirmed out from under the
          cursor.
        -->
        <div
          v-if="pendingDelete === b.id"
          class="flex items-center flex-wrap gap-2.5"
          style="margin-top: 9px; border: 1px solid var(--dgL); background: var(--dgB); border-radius: 6px; padding: 8px 10px"
        >
          <UIcon name="i-lucide-triangle-alert" class="size-3.5 shrink-0" style="color: var(--dg)" />
          <span style="font-size: 13px; line-height: 1.5; color: var(--mu)">
            <template v-if="isBaseline(b)">
              This is the image the open codeplug came from. Delete it and the way back is only on the radio.
            </template>
            <template v-else>
              Nothing here can get this image back. Only reading the radio again can.
            </template>
          </span>
          <div class="ms-auto flex items-center gap-1.5">
            <RiskAction
              risk="destructive"
              size="sm"
              icon="i-lucide-trash-2"
              label="Delete for good"
              @click="remove(b)"
            />
            <RiskAction risk="neutral" size="sm" ghost label="Keep" @click="pendingDelete = null" />
          </div>
        </div>
      </div>
    </div>

    <p v-if="backups.length" style="margin-top: 11px; font-size: 13px; line-height: 1.6; color: var(--fn); max-width: 78ch">
      Restore overwrites what is on the radio right now with the image above — the same register as a write, and it
      asks the same way. A read that has never been written from is the safest thing in this list.
    </p>
  </div>
</template>

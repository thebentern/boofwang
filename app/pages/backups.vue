<script setup lang="ts">
import type { StoredBackup } from '#core/storage/db.js'
import { fromStoredBackup } from '#core/storage/db.js'
import { encodeBwp } from '#core/io/bwp.js'
import { createDriver, isImplemented } from '#core/radio/registry.js'

useSeoMeta({ title: 'Backups' })

const db = useBoofwangDb()
const codeplug = useCodeplugStore()
const toast = useToast()

const backups = ref<StoredBackup[]>([])
const persisted = ref<boolean | null>(null)
const loading = ref(true)

async function refresh() {
  backups.value = await db.listBackups()
  loading.value = false
}

onMounted(async () => {
  await refresh()
  persisted.value = (await navigator.storage?.persisted?.()) ?? null
})

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

async function remove(b: StoredBackup) {
  await db.deleteBackup(b.id)
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

const ORIGIN_LABEL = { download: 'Read from radio', 'pre-write': 'Taken before a write', import: 'Imported' } as const
</script>

<template>
  <div class="mx-auto max-w-5xl px-4 py-8 space-y-6">
    <div>
      <h1 class="text-2xl font-semibold tracking-tight">Backups</h1>
      <p class="text-sm text-muted">
        Every read is saved here automatically, in this browser only.
      </p>
    </div>

    <UAlert
      v-if="persisted === false"
      icon="i-lucide-shield-alert"
      color="warning"
      variant="subtle"
      title="These backups can be evicted"
      description="Browsers discard script-created storage under pressure, and Safari drops it after a week without a visit. Download anything you would be sorry to lose."
    >
      <template #actions>
        <UButton size="sm" color="warning" variant="solid" label="Ask to keep it" @click="askPersist()" />
      </template>
    </UAlert>

    <USkeleton v-if="loading" class="h-24" />

    <UAlert
      v-else-if="!backups.length"
      icon="i-lucide-history"
      color="neutral"
      variant="subtle"
      title="Nothing saved yet"
      description="Read a radio and its codeplug will appear here."
    />

    <div v-else class="space-y-3">
      <UCard v-for="b in backups" :key="b.id" :ui="{ body: 'flex flex-wrap items-center gap-4' }">
        <div class="min-w-0">
          <p class="font-medium truncate">{{ b.label }}</p>
          <p class="text-xs text-muted tabular">
            {{ b.radioId }} · {{ b.layout }} · {{ b.byteLength.toLocaleString() }} bytes ·
            {{ new Date(b.createdAt).toLocaleString() }}
          </p>
          <p class="text-xs text-muted font-mono truncate" :title="b.sha256">sha256 {{ b.sha256.slice(0, 16) }}…</p>
        </div>
        <UBadge :label="ORIGIN_LABEL[b.origin]" color="neutral" variant="subtle" size="sm" class="shrink-0" />
        <div class="ms-auto flex items-center gap-2 shrink-0">
          <UButton size="sm" icon="i-lucide-pencil" label="Open" variant="subtle" @click="openBackup(b)" />
          <UButton size="sm" icon="i-lucide-download" label="Save" variant="subtle" color="neutral" @click="download(b)" />
          <UButton size="sm" icon="i-lucide-trash-2" color="error" variant="ghost" @click="remove(b)" />
        </div>
      </UCard>
    </div>
  </div>
</template>

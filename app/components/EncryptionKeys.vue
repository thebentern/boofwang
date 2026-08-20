<script setup lang="ts">
import type { EncryptionType } from '#core/model/codeplug.js'
import {
  KEY_BYTES,
  KEY_TYPE_LABELS,
  isBlankKey,
  maskKey,
  validateKeyHex,
} from '#core/model/encryption.js'

/**
 * The eight key slots.
 *
 * Keys are masked by default and revealed one slot at a time, deliberately:
 * they are the most sensitive thing in a codeplug, and a screen-share or a
 * screenshot of this page should not hand them over wholesale.
 */
const codeplug = useCodeplugStore()

const schema = computed(() => codeplug.schema)
const slots = computed(() => schema.value?.features.encryption)

const revealed = ref<Set<number>>(new Set())
const editing = ref<number | null>(null)
const draftType = ref<EncryptionType>('aes256')
const draftName = ref('')
const draftHex = ref('')

const TYPES: EncryptionType[] = ['aes256', 'aes128', 'arc4', 'custom']

const rows = computed(() => {
  const max = slots.value ? slots.value.slots : 0
  const byslot = new Map(codeplug.doc?.encryptionKeys.map((k) => [k.slot, k]) ?? [])
  return Array.from({ length: max }, (_, i) => {
    const slot = i + 1
    const key = byslot.get(slot)
    return {
      slot,
      key,
      // A slot read from a radio whose key material was all zeros is present
      // but carries nothing usable; saying so beats showing a row of dots.
      blank: key ? isBlankKey(key.keyHex) : false,
    }
  })
})

const validation = computed(() => validateKeyHex(draftType.value, draftHex.value))

function startEdit(slot: number) {
  const existing = codeplug.doc?.encryptionKeys.find((k) => k.slot === slot)
  editing.value = slot
  draftType.value = (existing?.type ?? 'aes256') as EncryptionType
  draftName.value = existing?.name ?? `Key ${slot}`
  // Never pre-fill the key: entering a new one should be deliberate, and this
  // avoids a stored key being revealed simply by opening the editor.
  draftHex.value = ''
}

function save() {
  if (!validation.value.ok || editing.value === null || !codeplug.doc) return
  codeplug.setEncryptionKey({
    id: `key-${editing.value}`,
    slot: editing.value,
    name: draftName.value.slice(0, slots.value ? slots.value.nameLength : 10),
    type: draftType.value,
    keyHex: validation.value.normalised,
  })
  editing.value = null
  draftHex.value = ''
}

function clearSlot(slot: number) {
  codeplug.removeEncryptionKey(slot)
  revealed.value.delete(slot)
}

function toggleReveal(slot: number) {
  const next = new Set(revealed.value)
  if (next.has(slot)) next.delete(slot)
  else next.add(slot)
  revealed.value = next
}
</script>

<template>
  <div v-if="slots" class="space-y-4">
    <EncryptionWarning />

    <UAlert
      v-if="!codeplug.schema?.capabilities.write"
      icon="i-lucide-info"
      color="neutral"
      variant="subtle"
      title="Keys can be edited here but not yet sent to this radio"
      description="Writing to the DM-32UV is not implemented. Keys you enter are held in this codeplug and in files you save, ready for when it is."
    />

    <div class="rounded-md border border-default divide-y divide-default">
      <div v-for="row in rows" :key="row.slot" class="p-3 space-y-2">
        <div class="flex items-center gap-3">
          <span class="tabular text-muted w-6 shrink-0">{{ row.slot }}</span>

          <template v-if="row.key">
            <div class="min-w-0 flex-1">
              <div class="flex items-center gap-2">
                <span class="font-medium truncate">{{ row.key.name || '(unnamed)' }}</span>
                <UBadge :label="KEY_TYPE_LABELS[row.key.type]" color="neutral" variant="subtle" size="sm" />
                <UBadge v-if="row.blank" label="no key material" color="warning" variant="subtle" size="sm" />
              </div>
              <code class="text-xs text-muted tabular break-all">
                {{ revealed.has(row.slot) ? row.key.keyHex : maskKey(row.key.keyHex) }}
              </code>
            </div>
            <UButton
              :icon="revealed.has(row.slot) ? 'i-lucide-eye-off' : 'i-lucide-eye'"
              size="xs"
              color="neutral"
              variant="ghost"
              :aria-label="revealed.has(row.slot) ? 'Hide key' : 'Reveal key'"
              @click="toggleReveal(row.slot)"
            />
            <UButton icon="i-lucide-pencil" size="xs" color="neutral" variant="ghost" @click="startEdit(row.slot)" />
            <UButton icon="i-lucide-trash-2" size="xs" color="error" variant="ghost" @click="clearSlot(row.slot)" />
          </template>

          <template v-else>
            <span class="flex-1 text-sm text-muted">Empty</span>
            <UButton icon="i-lucide-plus" size="xs" label="Set a key" variant="subtle" @click="startEdit(row.slot)" />
          </template>
        </div>

        <div v-if="editing === row.slot" class="pl-9 space-y-3 pb-1">
          <div class="grid grid-cols-2 gap-3">
            <UFormField label="Name">
              <UInput v-model="draftName" :maxlength="slots.nameLength" class="w-full" />
            </UFormField>
            <UFormField label="Type">
              <USelect
                v-model="draftType"
                class="w-full"
                :items="TYPES.map((t) => ({ value: t, label: `${KEY_TYPE_LABELS[t]} (${KEY_BYTES[t]} bytes)` }))"
              />
            </UFormField>
          </div>
          <UFormField
            :label="`Key — ${KEY_BYTES[draftType] * 2} hex characters`"
            :error="draftHex.length > 0 && !validation.ok ? validation.error : undefined"
          >
            <UInput
              v-model="draftHex"
              class="w-full font-mono"
              placeholder="paste hex; spaces and colons are fine"
              autocomplete="off"
              spellcheck="false"
            />
          </UFormField>
          <div class="flex items-center gap-2">
            <UButton label="Save key" icon="i-lucide-circle-check" size="sm" :disabled="!validation.ok" @click="save" />
            <UButton label="Cancel" size="sm" color="neutral" variant="ghost" @click="editing = null" />
          </div>
        </div>
      </div>
    </div>

    <p class="text-xs text-muted">
      Keys are held in this browser and written into any codeplug file you save. Anyone with access to
      that file or this browser profile can read them. boofwang has no server and sends them nowhere.
    </p>
  </div>

  <UAlert
    v-else
    icon="i-lucide-info"
    color="neutral"
    variant="subtle"
    title="This radio has no encryption"
    description="Only the DM-32UV in this build supports encryption keys."
  />
</template>

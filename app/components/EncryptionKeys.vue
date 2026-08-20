<script setup lang="ts">
import type { EncryptionType } from '#core/model/codeplug.js'
import { evaluateWriteGate } from '#core/radio/write-gate.js'
import {
  KEY_BYTES,
  KEY_TYPE_LABELS,
  isBlankKey,
  maskKey,
  resolveKeyEdit,
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

const session = useRadioSession()
const device = useDeviceStore()
const writing = ref(false)

/**
 * The same gate the channel editor uses.
 *
 * Writing from here used to bypass it entirely, which meant a key slot could be
 * cleared and sent while channels still referenced it - the validator had
 * already flagged every affected channel, and nothing consulted it.
 */
const backup = ref<{ identHash: string } | null>(null)
onMounted(async () => {
  backup.value = await session.latestBackupForOpenCodeplug()
})

const gate = computed(() =>
  evaluateWriteGate({
    schema: codeplug.schema!,
    ident: device.ident,
    imageVariant: codeplug.image?.variant ?? null,
    imageRadioId: codeplug.image?.radioId ?? null,
    backup: backup.value,
    diagnostics: codeplug.diagnostics,
    encodeError: codeplug.encodeError,
    changedBytes: codeplug.pendingWrite?.changedBytes ?? 0,
    unownedRanges: codeplug.pendingWrite?.unowned ?? [],
  }),
)

async function writeKeys() {
  writing.value = true
  try {
    await session.writeToRadio()
  } finally {
    writing.value = false
  }
}

const revealed = ref<Set<number>>(new Set())
const editing = ref<number | null>(null)
const draftType = ref<EncryptionType>('aes256')
const draftName = ref('')
const draftHex = ref('')
/**
 * The key already in the slot being edited, snapshotted when the editor opens.
 *
 * Held here rather than looked up on save so that an edit commits the key the
 * user was actually shown, and so an empty key field can mean "leave it alone".
 */
const editingExisting = ref<{ type: EncryptionType; keyHex: string } | null>(null)

const TYPES: EncryptionType[] = ['aes256', 'aes128', 'arc4', 'custom']

const rows = computed(() => {
  // `doc` is a shallowRef holding a markRaw'd object, and the key mutations
  // edit that object in place and bump `revision`. Without reading `revision`
  // this computed has no dependency that ever changes, so it stays cached for
  // the life of the mount: renaming a slot, or deleting one, left the list
  // showing the pre-edit values while the write button - which does read
  // `revision` - offered to send the new ones. The list is the only preview of
  // what is about to be written, so it has to track the document.
  void codeplug.revision
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
  editingExisting.value = existing ? { type: existing.type, keyHex: existing.keyHex } : null
  // Never pre-fill the key: entering a new one should be deliberate, and this
  // avoids a stored key being revealed simply by opening the editor.
  draftHex.value = ''
}

/**
 * What an edit would commit, decided in the core rather than here.
 *
 * A blank key field keeps the stored key, so a slot can be renamed without
 * retyping it. `resolveKeyEdit` owns that rule and is unit-tested; this
 * component only renders the answer.
 */
const resolution = computed(() =>
  resolveKeyEdit({ type: draftType.value, hex: draftHex.value }, editingExisting.value),
)

const keepsExistingKey = computed(() => resolution.value.ok && resolution.value.keptExisting)

/**
 * Every type except AES-256 is unverified against hardware.
 *
 * Only AES-256 has been round-tripped, because that is what all 22 slots on the
 * radio this was developed against hold. The specification says a short key
 * sits at one end of the 32-byte field and a full one at the other - and it was
 * demonstrably wrong about AES-256, which occupies the whole field from +0x0C.
 * There is no reason to extend it more credit for the rest, and a mis-placed
 * key produces a slot that looks programmed and cannot decrypt. Say so rather
 * than implying equal confidence.
 */
const shortTypeUnverified = computed(() => draftType.value !== 'aes256')
const canSave = computed(() => resolution.value.ok)

function save() {
  const decided = resolution.value
  if (!decided.ok || editing.value === null || !codeplug.doc) return
  codeplug.setEncryptionKey({
    id: `key-${editing.value}`,
    slot: editing.value,
    name: draftName.value.slice(0, slots.value ? slots.value.nameLength : 10),
    type: draftType.value,
    keyHex: decided.keyHex,
  })
  editing.value = null
  draftHex.value = ''
  editingExisting.value = null
}

function cancelEdit() {
  editing.value = null
  draftHex.value = ''
  editingExisting.value = null
}

/**
 * Close the editor when the codeplug underneath it is replaced.
 *
 * A read, a restore or opening a file swaps the whole document. The snapshot in
 * `editingExisting` would then belong to the previous radio, and a blank save
 * would copy its key into the new one.
 */
watch(
  () => codeplug.doc,
  () => {
    if (editing.value !== null) cancelEdit()
  },
)

function clearSlot(slot: number) {
  codeplug.removeEncryptionKey(slot)
  revealed.value.delete(slot)
  // Close the editor if it was open on this slot. Leaving it open kept the
  // pre-clear snapshot in `editingExisting`, so a blank save - the gesture that
  // means "keep the current key" - wrote the deleted key straight back.
  if (editing.value === slot) cancelEdit()
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
      title="Keys can be edited here but not sent to this radio"
      description="Writing is not enabled for this radio. Keys you enter are held in this codeplug and in files you save."
    />

    <div v-else-if="codeplug.dirty" class="space-y-3">
      <UAlert
        v-for="b in gate.blockers"
        :key="b.code"
        icon="i-lucide-shield-alert"
        color="error"
        variant="subtle"
        :title="b.message"
        :description="b.remedy"
      />
      <div class="flex items-center gap-3">
        <UButton
          icon="i-lucide-upload"
          label="Write keys to radio"
          color="warning"
          :loading="writing"
          :disabled="writing || !gate.allowed"
          @click="writeKeys"
        />
        <span class="text-sm text-muted">
          Only the eight key slots are sent. Everything else on the radio is left exactly as it is.
        </span>
      </div>
    </div>

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
              :aria-label="`${revealed.has(row.slot) ? 'Hide' : 'Reveal'} key slot ${row.slot}`"
              @click="toggleReveal(row.slot)"
            />
            <UButton
              icon="i-lucide-pencil"
              size="xs"
              color="neutral"
              variant="ghost"
              :aria-label="`Edit key slot ${row.slot}`"
              @click="startEdit(row.slot)"
            />
            <UButton
              icon="i-lucide-trash-2"
              size="xs"
              color="error"
              variant="ghost"
              :aria-label="`Clear key slot ${row.slot}`"
              @click="clearSlot(row.slot)"
            />
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
            <UFormField
              label="Type"
              :description="
                shortTypeUnverified
                  ? `Where a ${KEY_TYPE_LABELS[draftType]} key sits inside the 32-byte field has not been confirmed against hardware — only AES-256 has. If the radio will not decrypt with it, that is the first thing to suspect.`
                  : undefined
              "
            >
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
            :hint="keepsExistingKey ? 'leave blank to keep the current key' : undefined"
            :description="
              draftHex.length === 0 && !resolution.ok ? resolution.error : undefined
            "
          >
            <UInput
              v-model="draftHex"
              class="w-full font-mono"
              :placeholder="
                editingExisting
                  ? 'leave blank to keep the current key, or paste a new one'
                  : 'paste hex; spaces and colons are fine'
              "
              autocomplete="off"
              spellcheck="false"
            />
          </UFormField>
          <div class="flex items-center gap-2">
            <UButton label="Save key" icon="i-lucide-circle-check" size="sm" :disabled="!canSave" @click="save" />
            <UButton label="Cancel" size="sm" color="neutral" variant="ghost" @click="cancelEdit" />
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

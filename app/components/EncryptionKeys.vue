<script setup lang="ts">
import type { EncryptionType } from '#core/model/codeplug.js'
import {
  KEY_BYTES,
  KEY_TYPE_LABELS,
  isBlankKey,
  maskKey,
  resolveKeyEdit,
  validateKeyHex,
} from '#core/model/encryption.js'

/**
 * The key slots, on the far side of the gate.
 *
 * Reached only after a Part 90 declaration, so this component never argues the
 * law again - the citation bar restates it in one line and the gate owns the
 * rest. What is left here is the handling of the material itself.
 *
 * Keys are masked by default and revealed one slot at a time, deliberately:
 * they are the most sensitive thing in a codeplug, and a screen-share or a
 * screenshot of this page should not hand them over wholesale. Revealing a
 * second slot hides the first, so at most one key is ever on screen.
 */

const codeplug = useCodeplugStore()

const schema = computed(() => codeplug.schema)
const slots = computed(() => schema.value?.features.encryption || null)

/**
 * The types this radio actually has, rather than every type the format knows.
 *
 * `none` is not an editable choice: a slot with no type is an empty slot, and
 * emptying one is what Clear is for.
 */
const types = computed<EncryptionType[]>(
  () => (slots.value?.types ?? []).filter((t): t is EncryptionType => t !== 'none'),
)

/** At most one slot is unmasked at a time; null means everything is masked. */
const revealed = ref<number | null>(null)
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
const canSave = computed(() => resolution.value.ok)

/** The message under the key field: a bad key first, then why a blank one will not do. */
const keyProblem = computed(() => {
  if (draftHex.value.length > 0) return validation.value.ok ? null : validation.value.error ?? null
  return resolution.value.ok ? null : resolution.value.error
})

/*
 * A note for whoever maintains this, not for the screen.
 *
 * Only AES-256 has been round-tripped against a radio; the specification's
 * placement rules for the shorter types were demonstrably wrong about AES-256,
 * so they are not trusted for the rest either. If a short key turns out to be
 * mis-placed that is a bug to fix in the layout, not a disclaimer to show
 * someone who is trying to enter a key.
 */

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
 * would copy its key into the new one. The revealed slot is dropped for the
 * same reason: slot 3 of the radio just read is not the key that was on screen.
 */
watch(
  () => codeplug.doc,
  () => {
    revealed.value = null
    if (editing.value !== null) cancelEdit()
  },
)

function clearSlot(slot: number) {
  codeplug.removeEncryptionKey(slot)
  if (revealed.value === slot) revealed.value = null
  // Close the editor if it was open on this slot. Leaving it open kept the
  // pre-clear snapshot in `editingExisting`, so a blank save - the gesture that
  // means "keep the current key" - wrote the deleted key straight back.
  if (editing.value === slot) cancelEdit()
}

/** Revealing a slot hides whichever one was already open. */
function toggleReveal(slot: number) {
  revealed.value = revealed.value === slot ? null : slot
}

/**
 * How the key column reads for a row.
 *
 * A slot holding all zeros gets the same words as an empty one but a caution
 * colour, because it is the more dangerous of the two: it looks programmed in
 * every menu on the radio and will not decrypt anything.
 */
function keyText(row: { key: { keyHex: string } | undefined; blank: boolean; slot: number }) {
  if (!row.key || row.blank) return 'no key material'
  return revealed.value === row.slot ? row.key.keyHex : maskKey(row.key.keyHex)
}

const INPUT_STYLE =
  'height: 33px; background: var(--pn); border: 1px solid var(--ln2); color: var(--tx); font-size: 14px'
</script>

<template>
  <div v-if="slots">
    <div class="flex items-center gap-2.5 flex-wrap" style="margin-bottom: 11px">
      <UIcon name="i-lucide-key-round" class="shrink-0" style="width: 17px; height: 17px; color: var(--cn)" />
      <h1 style="font-size: 19px; font-weight: 600; letter-spacing: -0.02em; color: var(--tx)">
        Encryption keys
      </h1>
      <span style="font-size: 13.5px; color: var(--fn)">
        {{ schema?.vendor }} {{ schema?.model }} · {{ slots.slots }} slots
      </span>

    </div>


    <div style="border: 1px solid var(--ln); background: var(--pn); border-radius: 7px; overflow: hidden">
      <div v-for="row in rows" :key="row.slot">
        <!--
          Wrapping rather than scrolling: the row's fixed columns cannot fit a
          phone, and a horizontally scrolling table hides the Clear button
          behind a gesture. The action group keeps `ms-auto`, so on a narrow
          screen it drops to its own line still right-aligned.
        -->
        <div
          class="flex items-center flex-wrap"
          style="gap: 9px; padding: 12px 16px; border-bottom: 1px solid var(--ln)"
        >
          <span
            class="font-mono tabular text-right shrink-0"
            style="font-size: 13px; color: var(--fn); width: 18px"
          >{{ row.slot }}</span>

          <UIcon
            :name="!row.key
              ? 'i-lucide-circle-minus'
              : revealed === row.slot ? 'i-lucide-unlock' : 'i-lucide-lock'"
            class="shrink-0"
            style="width: 13px; height: 13px"
            :style="{ color: !row.key ? 'var(--ln2)' : revealed === row.slot ? 'var(--cn)' : 'var(--fn)' }"
          />

          <span
            class="shrink-0 truncate"
            style="font-size: 14px; width: 86px"
            :style="row.key
              ? { fontWeight: 600, color: 'var(--tx)' }
              : { fontWeight: 400, color: 'var(--fn)' }"
          >{{ row.key ? row.key.name || '(unnamed)' : 'Empty' }}</span>

          <span
            v-if="row.key"
            class="chip shrink-0"
            :style="row.key.type === 'aes256'
              ? { border: '1px solid var(--ln)', background: 'var(--pn2)', color: 'var(--mu)' }
              : { border: '1px solid var(--cnL)', background: 'var(--cnB)', color: 'var(--cn)' }"
          >{{ KEY_TYPE_LABELS[row.key.type] }}</span>

          <!--
            The masked form is one line and elides, because a row of bullets
            carries no information past the first few. The revealed form wraps
            instead: a key you have to scroll to finish reading is a key nobody
            can check against the one on the paper in their hand, which is the
            only reason to reveal it at all. One row growing is the cost, and
            only one row can ever be open.
          -->
          <span
            class="font-mono tabular"
            :class="revealed === row.slot ? 'break-all' : 'truncate'"
            style="font-size: 12.5px; min-width: 0"
            :style="{
              color: !row.key ? 'var(--ln2)' : row.blank ? 'var(--cn)' : revealed === row.slot ? 'var(--tx)' : 'var(--fn)',
              letterSpacing: revealed === row.slot ? '0' : '0.5px',
              lineHeight: revealed === row.slot ? '1.5' : 'normal',
            }"
          >{{ keyText(row) }}</span>

          <div class="ms-auto flex shrink-0" style="gap: 5px">
            <template v-if="row.key">
              <RiskAction
                v-if="!row.blank"
                risk="neutral"
                ghost
                size="sm"
                :icon="revealed === row.slot ? 'i-lucide-eye-off' : 'i-lucide-eye'"
                :label="revealed === row.slot ? 'Hide' : 'Reveal'"
                @click="toggleReveal(row.slot)"
              />
              <RiskAction
                risk="neutral"
                ghost
                size="sm"
                icon="i-lucide-pencil"
                label="Edit"
                @click="startEdit(row.slot)"
              />
              <RiskAction
                risk="destructive"
                ghost
                size="sm"
                icon="i-lucide-trash-2"
                label="Clear"
                @click="clearSlot(row.slot)"
              />
            </template>
            <RiskAction
              v-else
              risk="neutral"
              ghost
              size="sm"
              icon="i-lucide-plus"
              label="Set"
              @click="startEdit(row.slot)"
            />
          </div>
        </div>

        <div
          v-if="editing === row.slot"
          style="background: var(--pn2); border-bottom: 1px solid var(--ln); padding: 16px 16px 14px 40px"
        >
          <div class="grid gap-3 sm:grid-cols-2" style="margin-bottom: 11px">
            <label class="grid gap-1.5">
              <span class="label-xs">Name</span>
              <input
                v-model="draftName"
                type="text"
                class="rounded-[6px] px-2.5 outline-none w-full"
                :style="INPUT_STYLE"
                :maxlength="slots.nameLength"
                autocomplete="off"
                spellcheck="false"
              >
            </label>

            <label class="grid gap-1.5">
              <span class="label-xs">Type</span>
              <select
                v-model="draftType"
                class="rounded-[6px] px-2 outline-none w-full"
                :style="INPUT_STYLE"
              >
                <option v-for="t in types" :key="t" :value="t">
                  {{ KEY_TYPE_LABELS[t] }} ({{ KEY_BYTES[t] }} bytes)
                </option>
              </select>
            </label>
          </div>

          <label class="grid gap-1.5" style="margin-bottom: 11px">
            <span class="flex items-baseline gap-2 flex-wrap">
              <span class="label-xs">Key, {{ KEY_BYTES[draftType] * 2 }} hex characters</span>
              <!-- Not part of the label: shouting the escape hatch makes it read as the instruction. -->
              <span v-if="keepsExistingKey" style="font-size: 13px; color: var(--fn)">
                leave blank to keep the current key
              </span>
            </span>
            <input
              v-model="draftHex"
              type="text"
              class="font-mono tabular rounded-[6px] px-2.5 outline-none w-full"
              :style="INPUT_STYLE"
              :placeholder="editingExisting
                ? 'leave blank to keep the current key, or paste a new one'
                : 'paste hex; spaces and colons are fine'"
              autocomplete="off"
              spellcheck="false"
            >
            <span v-if="keyProblem" style="font-size: 13px; color: var(--dg)">{{ keyProblem }}</span>
          </label>

          <div class="flex items-center gap-2">
            <RiskAction
              risk="neutral"
              icon="i-lucide-circle-check"
              label="Save key"
              :disabled="!canSave"
              @click="save"
            />
            <RiskAction risk="neutral" ghost label="Cancel" @click="cancelEdit" />
          </div>
        </div>
      </div>
    </div>

    <p style="font-size: 13px; line-height: 1.6; color: var(--fn); max-width: 78ch; margin-top: 11px">
      Keys are held in this browser and written into any codeplug file you save. Anyone with access to that
      file or this browser profile can read them. boofwang has no server and sends them nowhere.
    </p>
  </div>
</template>

<script setup lang="ts">
import type { Progress } from '#core/radio/driver.js'
import { diffChannels } from '#core/radio/channel-diff.js'
import { evaluateWriteGate } from '#core/radio/write-gate.js'

/**
 * The write flow, as a page rather than a dialog.
 *
 * The old modal put a byte count and a block count in front of someone and
 * called that consent. It was the wrong information: nobody can look at "1,792
 * bytes across 14 blocks" and know whether a weather channel just became
 * transmit-capable. So the diff *is* the confirmation step here, which is why
 * this is a page - there is room for the account of what changes, and there is
 * one fewer dialog rather than one more.
 *
 * Three cards in a fixed order, and the order is the argument: a way back
 * exists, here is what changes, now say the word. A write is never one click
 * from idle.
 */
useSeoMeta({ title: 'Write to radio' })

const codeplug = useCodeplugStore()
const device = useDeviceStore()
const transfer = useTransferStore()
const session = useRadioSession()

type View = 'form' | 'sending' | 'written'
const view = ref<View>('form')

/**
 * The backup lookup hits IndexedDB, so there is a moment where "none found" and
 * "not looked yet" are indistinguishable. They are held apart because the write
 * gate reads a missing backup as a blocker, and flashing "there is no way back"
 * at someone who has one is the kind of false alarm that teaches people to
 * ignore the real one.
 */
const backup = ref<{ identHash: string; createdAt?: string } | null>(null)
const checking = ref(true)

onMounted(async () => {
  try {
    backup.value = await session.latestBackupForOpenCodeplug()
  } finally {
    checking.value = false
  }
})

const model = computed(() => codeplug.schema?.model ?? 'radio')

/**
 * The codeplug as it came off the radio, decoded once.
 *
 * Kept apart from the diff below so that editing does not re-decode the
 * baseline: the baseline only changes when a different image is loaded, and
 * decoding a few hundred channel records to answer a question whose answer has
 * not moved is pure waste.
 */
const baseline = computed(() => {
  const driver = codeplug.driverRef
  const image = codeplug.image
  return driver && image ? driver.decode(image) : null
})

/**
 * What changes, in the user's terms.
 *
 * `revision` is the dependency that matters: the open document is mutated in
 * place behind a `shallowRef`, so nothing else here would notice an edit.
 */
const diff = computed(() => {
  void codeplug.revision
  const before = baseline.value
  const after = codeplug.doc
  return before && after ? diffChannels(before, after) : null
})

/**
 * What actually goes down the wire.
 *
 * Bytes are counted as whole blocks rather than as changed bytes, because that
 * is what the radio is sent. Changing one byte of a DM-32UV key slot really
 * does put 4096 bytes on the cable, and a confirmation that said "1 byte" would
 * be describing the edit rather than the write.
 */
const blockBytes = computed(() => codeplug.driverRef?.writeBlockBytes ?? 0)

/**
 * Blocks the radio will actually receive, which is not always the diff.
 *
 * A radio that erases a flash page before programming cannot take a sparse
 * write - it gets the whole image every time. Counting the diff there would
 * promise "1 block" and then send five hundred.
 */
const wholeImage = computed(() => codeplug.schema?.capabilities.writesWholeImage === true)
const imageBlocks = computed(() => {
  const size = codeplug.image?.regions.reduce((n, r) => n + r.data.length, 0) ?? 0
  return blockBytes.value > 0 ? Math.ceil(size / blockBytes.value) : 0
})
const blocks = computed(() =>
  wholeImage.value ? imageBlocks.value : (codeplug.pendingWrite?.changedBlocks.length ?? 0),
)
const bytes = computed(() => blocks.value * blockBytes.value)

const gate = computed(() => {
  const schema = codeplug.schema
  if (!schema) return null
  const pending = codeplug.pendingWrite
  return evaluateWriteGate({
    schema,
    // Null while disconnected, which is the normal case here: reading
    // disconnects when it finishes, and the write reconnects when it runs.
    ident: device.ident,
    imageVariant: codeplug.image?.variant ?? null,
    imageRadioId: codeplug.image?.radioId ?? null,
    backup: backup.value,
    diagnostics: codeplug.diagnostics,
    encodeError: codeplug.encodeError,
    changedBytes: pending?.changedBytes ?? 0,
    unownedRanges: pending?.unowned ?? [],
    documentDirty: codeplug.dirty,
  })
})

/** The two blockers the first card is responsible for explaining. */
const BACKUP_CODES = new Set(['no-backup', 'backup-other-radio'])
const backupBlocker = computed(() => gate.value?.blockers.find((b) => BACKUP_CODES.has(b.code)) ?? null)
const otherBlockers = computed(() => gate.value?.blockers.filter((b) => !BACKUP_CODES.has(b.code)) ?? [])

const blocked = computed(() => !checking.value && gate.value !== null && !gate.value.allowed)
const ready = computed(() => !checking.value && gate.value?.allowed === true)

/**
 * One row per rule, not per warning.
 *
 * A codeplug with nine receive-only channels produces nine warnings with the
 * same rule id, and printing nine near-identical sentences above the confirm
 * button is how a page teaches someone to skip the text above the confirm
 * button.
 */
const warnings = computed(() => {
  const byRule = new Map<string, { code: string; message: string; count: number }>()
  for (const w of gate.value?.warnings ?? []) {
    const seen = byRule.get(w.code)
    if (seen) seen.count++
    else byRule.set(w.code, { code: w.code, message: w.message, count: 1 })
  }
  return [...byRule.values()]
})

/**
 * How old the way back is, and what it does not contain.
 *
 * The newest stored backup of this radio wins, whenever it was taken. Anything
 * the radio has been told by other software since then is not in it, which is
 * the part worth saying out loud when the backup is not from today.
 */
const backupBody = computed(() => {
  const at = backup.value?.createdAt
  if (!at) return null
  const taken = new Date(at)
  if (Number.isNaN(taken.getTime())) return 'A backup of this radio is stored in this browser. It includes calibration.'

  const time = taken.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  const days = Math.floor((Date.now() - taken.getTime()) / 86_400_000)
  if (days < 1) {
    return (
      `A backup of this radio, read today at ${time}, is stored in this browser. It includes calibration. ` +
      'Nothing about this write can put the radio somewhere that image cannot recover.'
    )
  }
  const when = days === 1 ? `yesterday at ${time}` : `${days} days ago, on ${taken.toLocaleDateString()}`
  return (
    `The newest backup of this radio was read ${when} and is stored in this browser. It includes calibration. ` +
    'Anything the radio has been told by other software since then is not in it.'
  )
})

const PHASE_WORDS: Record<Progress['phase'], string> = {
  handshake: 'identifying the radio',
  scan: 'looking for the radio',
  read: 'checking what the radio holds now',
  encode: 'preparing the image',
  write: 'writing and verifying',
  verify: 'reading back and comparing',
}
const phaseWords = computed(() => (transfer.phase ? PHASE_WORDS[transfer.phase] : 'getting ready'))

/**
 * The progress counter, in blocks, because bytes are not what the write is
 * measured in.
 *
 * The driver reports bytes against the whole programmable region and sweeps
 * every block - writing the ones that differ and skipping the rest - so this
 * counts the sweep rather than the blocks sent. The two are different numbers
 * on purpose and the sweep is the one that moves smoothly.
 */
const sweepTotal = computed(() => (blockBytes.value > 0 ? Math.ceil(transfer.total / blockBytes.value) : 0))
const sweepDone = computed(() =>
  blockBytes.value > 0 ? Math.min(sweepTotal.value, Math.floor(transfer.done / blockBytes.value)) : 0,
)

/**
 * What was sent, captured before the write rather than reported by it.
 *
 * The driver refuses outright when the radio has drifted from the image the
 * edit was based on, so a write that succeeds sends exactly the blocks the diff
 * counted. That is what makes it honest to show this number afterwards.
 */
const sentBlocks = ref(0)

async function send() {
  const before = codeplug.image
  sentBlocks.value = blocks.value
  view.value = 'sending'
  try {
    await session.writeToRadio()
  } finally {
    // `writeToRadio` returns nothing and reports its own outcome by toast, so
    // the one reliable signal that bytes landed is the baseline being replaced:
    // it calls `codeplug.load` with what it sent, and does so on no other path.
    view.value = codeplug.image !== before ? 'written' : 'form'
  }
}
</script>

<template>
  <div v-if="!codeplug.isOpen" class="mx-auto px-4 py-10" style="max-width: 880px">
    <h1 style="font-size: 19px; font-weight: 600; letter-spacing: -0.02em">There is no codeplug to write</h1>
    <p class="mt-2" style="font-size: 12.5px; line-height: 1.6; color: var(--mu); max-width: 70ch">
      Read a radio first. The read changes nothing, and it saves the backup this page will not write without.
    </p>
    <div class="mt-4">
      <RiskAction risk="safe" icon="i-lucide-usb" label="Go to Connect" size="lg" @click="navigateTo('/')" />
    </div>
  </div>

  <section v-else-if="view === 'form'" class="mx-auto" style="max-width: 880px; padding: 24px 16px 48px">
    <!-- The only view with anything to decide; the other two are reports. -->
    <div class="flex items-center flex-wrap" style="gap: 9px; margin-bottom: 5px">
      <UIcon name="i-lucide-upload" style="width: 16px; height: 16px; color: var(--cn)" />
      <h1 style="font-size: 19px; font-weight: 600; letter-spacing: -0.02em">Write to the {{ model }}</h1>
      <span style="font-size: 12px; color: var(--fn)">3 steps · nothing sent yet</span>
    </div>
    <p style="margin-bottom: 18px; font-size: 12.5px; color: var(--mu); max-width: 78ch">
      Three things stand between an edit and the radio, in this order: a way back, an account of what changes,
      and your word.
    </p>

    <div class="grid" style="gap: 9px">
      <!-- Card 1. A way back. -->
      <div
        class="rounded-[7px] overflow-hidden"
        :style="{
          background: 'var(--pn)',
          border: `1px solid ${backupBlocker ? 'var(--dgL)' : 'var(--okL)'}`,
        }"
      >
        <div class="flex items-start gap-3" style="padding: 14px 16px">
          <span
            class="flex items-center justify-center shrink-0 rounded-[6px]"
            :style="{
              width: '26px',
              height: '26px',
              marginTop: '1px',
              border: `1px solid ${backupBlocker ? 'var(--dgL)' : 'var(--okL)'}`,
              background: backupBlocker ? 'var(--dgB)' : 'var(--okB)',
            }"
          >
            <UIcon
              name="i-lucide-history"
              class="size-3.5"
              :style="{ color: backupBlocker ? 'var(--dg)' : 'var(--ok)' }"
            />
          </span>

          <div class="min-w-0 flex-1">
            <div class="flex items-baseline flex-wrap" style="gap: 9px">
              <span style="font-size: 13.5px; font-weight: 600">A way back</span>

              <span v-if="checking" class="chip" style="background: var(--pn3); color: var(--fn)">checking…</span>
              <span
                v-else-if="backupBlocker"
                class="chip"
                style="background: var(--dgB); color: var(--dg)"
              >
                <UIcon name="i-lucide-circle-x" class="size-3" />
                None on file
              </span>
              <span v-else class="chip" style="background: var(--okB); color: var(--ok)">
                <UIcon name="i-lucide-circle-check" class="size-3" />
                On file
              </span>
            </div>

            <p style="margin-top: 5px; font-size: 12.5px; line-height: 1.55; color: var(--mu); max-width: 70ch">
              <template v-if="checking">Looking for a stored backup of this radio…</template>
              <template v-else-if="backupBlocker">
                {{ backupBlocker.message }}
                <template v-if="backupBlocker.remedy"> {{ backupBlocker.remedy }}</template>
                A write cannot be offered without one.
              </template>
              <template v-else>{{ backupBody }}</template>
            </p>
          </div>
        </div>
      </div>

      <!-- Card 2. What changes. This is the confirmation step; the typed token below only records it. -->
      <div class="rounded-[7px] overflow-hidden" style="background: var(--pn); border: 1px solid var(--ln)">
        <div class="flex items-start gap-3" style="padding: 14px 16px">
          <span
            class="flex items-center justify-center shrink-0 rounded-[6px]"
            style="width: 26px; height: 26px; margin-top: 1px; border: 1px solid var(--ln); background: var(--pn2)"
          >
            <UIcon name="i-lucide-scale" class="size-3.5" style="color: var(--mu)" />
          </span>

          <div class="min-w-0 flex-1">
            <div class="flex items-baseline flex-wrap" style="gap: 9px">
              <span style="font-size: 13.5px; font-weight: 600">What changes</span>

              <span
                v-if="diff && diff.changed > 0"
                class="chip"
                style="background: var(--cnB); color: var(--cn)"
              >
                <UIcon name="i-lucide-scale" class="size-3" />
                {{ diff.changed }} channel{{ diff.changed === 1 ? '' : 's' }}
              </span>
              <span v-else class="chip" style="background: var(--pn3); color: var(--fn)">no channel changes</span>

              <!--
                The two consequences that outrank their size sit in the header
                rather than only in the totals bar, so a long diff cannot scroll
                them out of sight. A channel quietly gaining transmit is the
                failure that puts a public-safety frequency into a radio someone
                can key up.
              -->
              <span
                v-if="diff && diff.gainsTransmit > 0"
                class="chip"
                style="background: var(--cnB); color: var(--cn)"
              >
                <UIcon name="i-lucide-lock-open" class="size-3" />
                {{ diff.gainsTransmit }} gains transmit
              </span>
              <span v-if="diff && diff.erased > 0" class="chip" style="background: var(--dgB); color: var(--dg)">
                <UIcon name="i-lucide-trash-2" class="size-3" />
                {{ diff.erased }} slot{{ diff.erased === 1 ? '' : 's' }} erased
              </span>
              <span
                v-if="diff && diff.receiveOnlyLost > 0"
                class="chip"
                style="background: var(--dgB); color: var(--dg)"
              >
                <UIcon name="i-lucide-lock" class="size-3" />
                {{ diff.receiveOnlyLost }} receive-only lost
              </span>
            </div>

            <p style="margin-top: 5px; font-size: 12.5px; line-height: 1.55; color: var(--mu); max-width: 70ch">
              Not a byte count. One line per channel, and the two that carry more than their size are called out
              by name: a channel gaining transmit, and a slot being erased.
            </p>
          </div>
        </div>

        <div v-if="diff && diff.changed > 0" style="border-top: 1px solid var(--ln)">
          <div style="max-height: 340px; overflow-y: auto; padding: 12px 14px">
            <DiffList :diff="diff" :blocks="blocks" :bytes="bytes" />
          </div>
        </div>

        <!--
          Channels are the only thing boofwang can narrate. A key-slot or
          settings edit encodes to real blocks with no row to show for it, and
          saying so is better than an empty list that reads as "nothing".
        -->
        <div
          v-else-if="blocks > 0"
          style="border-top: 1px solid var(--ln); padding: 12px 14px; background: var(--pn2)"
        >
          <p style="font-size: 11.5px; line-height: 1.6; color: var(--fn); max-width: 74ch">
            Nothing in the channel list changes. The
            <span class="font-mono tabular">{{ bytes.toLocaleString() }} bytes</span>
            about to be sent are elsewhere in the codeplug — key slots or radio settings — and boofwang has no
            line-by-line account of those yet.
          </p>
        </div>
      </div>

      <!-- Warnings sit between the account and the confirmation, where they are still on the way past. -->
      <div
        v-for="w in warnings"
        :key="w.code"
        class="flex items-start gap-2.5 rounded-[6px]"
        style="padding: 9px 13px; border: 1px solid var(--cnL); background: var(--cnB)"
      >
        <UIcon name="i-lucide-triangle-alert" class="size-3.5 shrink-0" style="color: var(--cn); margin-top: 2px" />
        <p style="font-size: 12.5px; line-height: 1.55; color: var(--mu); max-width: 74ch">
          {{ w.message }}
          <span v-if="w.count > 1" style="color: var(--fn)"> · {{ w.count }} channels</span>
        </p>
      </div>

      <!-- Card 3. Your word. -->
      <div class="rounded-[7px] overflow-hidden" style="background: var(--pn); border: 1px solid var(--cnL)">
        <div class="flex items-start gap-3" style="padding: 14px 16px">
          <span
            class="flex items-center justify-center shrink-0 rounded-[6px]"
            style="width: 26px; height: 26px; margin-top: 1px; border: 1px solid var(--cnL); background: var(--cnB)"
          >
            <UIcon name="i-lucide-type" class="size-3.5" style="color: var(--cn)" />
          </span>

          <div class="min-w-0 flex-1">
            <div class="flex items-baseline flex-wrap" style="gap: 9px">
              <span style="font-size: 13.5px; font-weight: 600">Your word</span>
              <span v-if="blocked" class="chip" style="background: var(--dgB); color: var(--dg)">
                <UIcon name="i-lucide-circle-x" class="size-3" />
                Blocked
              </span>
              <span v-else class="chip" style="background: var(--cnB); color: var(--cn)">
                <UIcon name="i-lucide-type" class="size-3" />
                Confirm to send
              </span>
            </div>

            <p style="margin-top: 5px; font-size: 12.5px; line-height: 1.55; color: var(--mu); max-width: 70ch">
              Writing is the only action in boofwang that asks you to type. It is also the only one that can leave
              a radio unusable.
            </p>
          </div>
        </div>

        <!--
          A blocked write is not offered at a lower confidence - it is not
          offered. The gate explains here; `writeImage` refuses regardless, and
          if the two ever disagree the driver wins.
        -->
        <div v-if="blocked" style="border-top: 1px solid var(--ln); padding: 14px 16px">
          <div
            class="flex items-start gap-2.5 rounded-[6px]"
            style="padding: 11px 13px; border: 1px solid var(--dgL); background: var(--dgB)"
          >
            <UIcon
              name="i-lucide-shield-alert"
              class="size-3.5 shrink-0"
              style="color: var(--dg); margin-top: 2px"
            />
            <div class="min-w-0" style="display: grid; gap: 6px">
              <p
                v-for="b in otherBlockers"
                :key="b.code"
                style="font-size: 12.5px; line-height: 1.55; color: var(--tx); max-width: 74ch"
              >
                {{ b.message }}
                <span v-if="b.remedy" style="color: var(--mu)">{{ b.remedy }}</span>
              </p>
              <p
                v-if="otherBlockers.length === 0"
                style="font-size: 12.5px; line-height: 1.55; color: var(--tx); max-width: 74ch"
              >
                A way back has to exist before anything is sent. The first card says what is missing.
              </p>
            </div>
          </div>

          <div class="mt-3">
            <RiskAction risk="neutral" ghost label="Back to channels" @click="navigateTo('/channels')" />
          </div>
        </div>

        <div v-else style="border-top: 1px solid var(--ln); padding: 14px 16px">
          <ConfirmTyped
            token="WRITE"
            :label="`Send ${blocks} block${blocks === 1 ? '' : 's'}`"
            risk="caution"
            icon="i-lucide-upload"
            :disabled="!ready"
            @confirm="send"
          >
            <template #secondary>
              <RiskAction risk="neutral" ghost label="Back to channels" @click="navigateTo('/channels')" />
            </template>
          </ConfirmTyped>
        </div>
      </div>
    </div>

    <p style="margin-top: 14px; font-size: 11.5px; line-height: 1.6; color: var(--fn); max-width: 74ch">
      Every block is read back and compared before the next is sent. If a block fails verification the write stops
      there and the radio keeps the blocks already confirmed — the backup above is what puts it back.
    </p>
  </section>

  <section v-else-if="view === 'sending'" class="mx-auto" style="max-width: 520px; padding: 80px 16px">
    <!-- Non-dismissible by construction: there is nothing on it to click. -->
    <div class="rounded-[8px]" style="border: 1px solid var(--cnL); background: var(--pn); padding: 20px">
      <div class="flex items-center gap-2" style="margin-bottom: 7px">
        <UIcon name="i-lucide-triangle-alert" class="size-3.5" style="color: var(--cn)" />
        <span class="label-xs" style="color: var(--cn); letter-spacing: 0.08em">Do not unplug</span>
      </div>

      <h1 style="margin-bottom: 14px; font-size: 17px; font-weight: 600">Writing to the radio</h1>

      <div style="height: 4px; border-radius: 2px; background: var(--pn3); overflow: hidden; margin-bottom: 9px">
        <div
          :style="{
            height: '100%',
            width: `${transfer.percent}%`,
            background: 'var(--cn)',
            transition: 'width .18s linear',
          }"
        />
      </div>

      <div
        class="flex items-center justify-between gap-3"
        style="font-size: 11.5px; color: var(--mu); margin-bottom: 14px"
      >
        <span>{{ phaseWords }}</span>
        <span v-if="sweepTotal > 0" class="font-mono tabular">{{ sweepDone }} / {{ sweepTotal }} blocks</span>
      </div>

      <p style="font-size: 11.5px; line-height: 1.55; color: var(--fn)">
        Each block is written, read back and compared. Leave the cable connected and the radio switched on.
      </p>
    </div>
  </section>

  <section v-else class="mx-auto" style="max-width: 560px; padding: 80px 16px">
    <div class="rounded-[8px]" style="border: 1px solid var(--okL); background: var(--pn); padding: 20px">
      <div class="flex items-center gap-2" style="margin-bottom: 7px">
        <UIcon name="i-lucide-circle-check" class="size-3.5" style="color: var(--ok)" />
        <span class="label-xs" style="color: var(--ok); letter-spacing: 0.08em">Verified</span>
      </div>

      <h1 style="margin-bottom: 8px; font-size: 17px; font-weight: 600">
        {{ sentBlocks }} block{{ sentBlocks === 1 ? '' : 's' }} written, all read back and matched
      </h1>

      <!--
        Deliberately not "the pre-write backup": nothing new was stored by this
        write. The backup on file is the one the read left behind, and claiming
        a fresher one exists would be exactly the sort of comfortable lie the
        rest of this page refuses to tell.
      -->
      <p style="margin-bottom: 16px; font-size: 12.5px; line-height: 1.6; color: var(--mu)">
        The radio now holds what you were shown. That state is the new baseline, and the backup you started from
        is still on file under Backups.
      </p>

      <div class="flex flex-wrap gap-2">
        <RiskAction risk="neutral" icon="i-lucide-list" label="Back to channels" @click="navigateTo('/channels')" />
        <RiskAction risk="neutral" ghost icon="i-lucide-history" label="See backups" @click="navigateTo('/backups')" />
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import type { Channel } from '#core/model/channel.js'

/**
 * The channel table and nothing else.
 *
 * Everything that used to crowd this page has moved to where it belongs: the
 * radio, the edit count, the backup and the write button live in the status bar
 * above, the write itself is its own three-card flow, and the exports sit in the
 * table's own toolbar. What is left is the work.
 */
useSeoMeta({ title: 'Channels' })

const codeplug = useCodeplugStore()

const editing = ref<Channel | null>(null)

/**
 * Program an empty slot and open it for editing straight away.
 *
 * The row is created with schema defaults rather than left blank, because an
 * editor opened on nothing has no frequency to validate and no power level to
 * select. The user lands on a real channel they can change, which is also what
 * makes the diff show something.
 */
function onCreate(index: number) {
  const created = codeplug.createChannel(index)
  if (created) editing.value = created
}
</script>

<template>
  <div class="mx-auto max-w-[1400px]" style="padding: 13px 14px 30px">
    <div
      v-if="!codeplug.isOpen"
      class="max-w-2xl"
      style="background: var(--pn); border: 1px solid var(--ln); border-radius: 8px; padding: 19px 21px"
    >
      <h1 style="font-size: 19px; font-weight: 600; letter-spacing: -0.02em">No codeplug open</h1>
      <p style="margin-top: 6px; font-size: 14.5px; line-height: 1.6; color: var(--mu); max-width: 62ch">
        Read one from a radio, or open a <code class="font-mono">.bwp</code> file you saved earlier. Reading
        changes nothing on the radio and saves a backup before you edit anything.
      </p>
      <div class="flex flex-wrap items-center gap-3" style="margin-top: 14px">
        <RiskAction
          risk="neutral"
          icon="i-lucide-usb"
          label="Connect a radio"
          size="lg"
          @click="navigateTo('/')"
        />
        <OpenCodeplugButton />
      </div>
    </div>

    <template v-else>
      <ChannelTable @edit="editing = $event" @create="onCreate" />

      <!--
        The table edits a name and a receive frequency in place; everything else
        about a channel - tone, mode, power, the transmit gate - needs the room
        this dialog gives it.
      -->
      <UModal
        :open="editing !== null"
        :title="editing ? `Slot ${editing.index}` : ''"
        :ui="{ content: 'max-w-2xl' }"
        @update:open="(v: boolean) => { if (!v) editing = null }"
      >
        <template #body>
          <ChannelEditor v-if="editing" :key="editing.index" :channel="editing" @close="editing = null" />
        </template>
      </UModal>
    </template>
  </div>
</template>

<script setup lang="ts">
import type { RadioId } from '#core/model/codeplug.js'
import type { RadioSchema } from '#core/radio/schema.js'
import { RADIO_IDS, SCHEMAS, isImplemented } from '#core/radio/registry.js'
import { serviceFor } from '#core/model/bands.js'

/**
 * What boofwang knows how to talk to, and how far it has been taken.
 *
 * This replaced a read/write/hardware matrix, deliberately. Three of four rows
 * said a variation of "yes", so the one column meant to carry a warning became
 * furniture - the reader learned to skim a grid of confident ticks and the
 * caveat went with it. One chip per driver instead, so a narrowed or untested
 * driver is the only thing on the screen spending colour.
 *
 * The chip is computed from `SCHEMAS[id].capabilities` and nothing else, which
 * is the point: a driver that stops writing stops being described as writing on
 * the same deploy, and this page has no way to say otherwise. The prose below
 * is editorial and can only add caveats, never capability.
 *
 * The rows are also the chooser, which they did not used to be. This list once
 * carried a note saying "the handshake identifies what is on the cable, so the
 * rows are not choices" - and the handshake does, but only once it is talking
 * to something. Deciding *for* the user which handshake to send first meant
 * guessing, the guess was a hardcoded UV-K5, and getting it wrong looks exactly
 * like a broken cable: the port opens, the radio says nothing, and the screen
 * blames the lead.
 *
 * So the radio is picked here, by name, and nothing infers it. A driver that is
 * not implemented yet is listed but cannot be selected - it has no handshake to
 * send.
 */
const props = withDefaults(
  defineProps<{
    activeRadio?: RadioId | null
    selected?: RadioId | null
    /**
     * Whether this device can drive a cable at all. False only on an iPhone or
     * iPad, where it changes the order of the list rather than its contents.
     */
    usbHost?: boolean
  }>(),
  { activeRadio: null, selected: null, usbHost: true },
)
const emit = defineEmits<{ choose: [RadioId] }>()

/*
 * `statusOf` and `CHIP_STYLES` used to be here: one chip per row reading "Read
 * and write", "Read only" or "Not supported yet", computed from `capabilities`
 * and nothing else.
 *
 * The computation was right and the placement was wrong. Every driver in the
 * registry is built with `enableWrite: true`, so all five chips read "Read and
 * write" - five identical ticks, which is the column meant to carry a warning
 * turning into furniture. That is the same failure this file's header records
 * about the read/write/hardware matrix it replaced, recurring one shape later,
 * and it recurred because the fact was still per row.
 *
 * It is said once above the list instead. The day a driver stops writing, that
 * sentence stops being true and has to change, which is a louder failure than
 * one chip in five going quiet.
 */

/**
 * The service a radio transmits on, when every band it may key up in is the
 * same one.
 *
 * Derived from the numbers through `serviceFor`, not from the band labels. The
 * UV-5G's labels happen to read "GMRS 462 MHz", and sniffing that substring
 * would be reading a display string as data - it would break the day somebody
 * translated it, and it would silently answer nothing for a radio whose labels
 * are worded differently.
 *
 * Only transmit bands count. Every one of these radios receives far outside
 * what it may transmit in, so including receive would make them all "land
 * mobile" and say nothing. Null when the answer is mixed, which is the honest
 * result for a radio that keys up on two services.
 */
function serviceOf(schema: RadioSchema | null): string | null {
  const tx = schema?.rf.bands.filter((b) => b.txAllowed) ?? []
  if (tx.length === 0) return null
  const services = new Set(tx.map((b) => serviceFor(b.loHz).service))
  if (services.size !== 1) return null
  const only = [...services][0]!
  // "land mobile" is the catch-all rather than a claim, and "amateur" is what
  // four of these are - neither distinguishes one row from another here.
  return only === 'land mobile' || only === 'amateur' ? null : only
}

/**
 * Channels, then whatever else this radio's memory actually holds.
 *
 * The locale is pinned. `toLocaleString()` with no argument formats to the
 * host's locale, so a German browser rendered the DM-32UV as "4.000 channels" -
 * a thousands separator that reads as a decimal point to everybody else looking
 * at a channel count.
 *
 * Every token comes from the schema. The design's table asked for "999
 * channels" on the UV-5R Mini and this prints 1,000, which is the schema's
 * number and deliberately so: 999 belongs to one of the two radios that share
 * that name, 1000 to the other, and which one is present is decided by the
 * handshake that has not happened yet. The row's own caveat says exactly that.
 * A list printed before connect cannot know, so it prints the number the schema
 * holds rather than picking a radio.
 */
function memoryOf(schema: RadioSchema | null): string {
  if (!schema) return ''
  const service = serviceOf(schema)
  const parts = [
    `${schema.memory.channelCount.toLocaleString('en-US')} channels`,
    schema.features.dmr ? 'DMR' : (service ?? 'analog'),
  ]
  if (schema.features.zones) parts.push('zones')
  if (schema.features.encryption) parts.push('AES')
  return parts.join(' · ')
}

/**
 * Whether this row can be reached without a cable.
 *
 * Read off the schema rather than named here, so the day a second radio gets a
 * Bluetooth profile this list is already right. The header used to say "pick
 * the one on your cable", which was the whole truth until one of these stopped
 * needing one.
 */
function wirelessOf(schema: RadioSchema | null): boolean {
  return schema?.capabilities.transports.includes('bluetooth') === true
}

/**
 * Whether this row can be reached through a clip-on Bluetooth dongle.
 *
 * A different claim from `wirelessOf` and kept apart deliberately: that one
 * means the radio has a BLE module in it, this one means its programming port
 * takes a BLE-to-serial bridge. The chip only shows where the built-in module
 * chip does not, so a radio with both says the stronger, verified thing.
 */
function dongleOf(schema: RadioSchema | null): boolean {
  return schema?.capabilities.dongle !== undefined && !wirelessOf(schema)
}

/**
 * The one thing about a radio that a schema cannot state.
 *
 * Everything else on a row is derived. These are editorial, which is why they
 * are here in one place rather than scattered: a claim about somebody's radio
 * that no field backs has to be visible as such, and reviewable in one read.
 *
 * Each one is a fact the code actually has. The UV-K5's egzumer layout really
 * is refused a write by `variants.ts`, the Mini really does have two radios
 * behind one name resolved by the handshake, and the DM-32UV's three export
 * formats are the ones `session` offers. Nothing here promises a capability -
 * that is what the derived line above it is for.
 */
const CAVEATS: Partial<Record<RadioId, string>> = {
  uvk5: 'Reads egzumer custom firmware as well. That layout is read-only.',
  uv5rmini: 'Two variants share this name. boofwang identifies which one on connect.',
  dm32uv: 'Exports as .bwp, CSV or raw .bin.',
}


const rows = computed(() =>
  RADIO_IDS.map((id) => {
    const schema = SCHEMAS[id]
    return {
      id,
      name: schema ? `${schema.vendor} ${schema.model}` : id,
      memory: memoryOf(schema),
      wireless: wirelessOf(schema),
      dongle: dongleOf(schema),
      caveat: CAVEATS[id] ?? '',
      /** A row you can pick. A driver with no implementation has no handshake to send. */
      usable: isImplemented(id) && schema?.capabilities.read === true,
    }
  }),
)

type Row = (typeof rows.value)[number]

/**
 * On a device with no cable, order the list by what it can actually reach.
 *
 * The deciding fact on an iPhone is not whether boofwang supports a radio, it
 * is whether there is any route to it from here - so the list stops being the
 * registry's order and becomes three groups. The three at the bottom cannot be
 * programmed from this device at all, which the heading says once instead of
 * every row carrying a disabled badge.
 *
 * Derived from `transports`, `dongle` and the `usbHost` capability the page
 * already reads. There is no iOS-specific list anywhere.
 */
const groups = computed<{ key: string; icon: string; tone: string; title: string; note: string; rows: Row[]; unreachable: boolean }[]>(() => {
  if (props.usbHost) return []
  const own = rows.value.filter((r) => r.wireless)
  const viaDongle = rows.value.filter((r) => !r.wireless && r.dongle)
  const cabled = rows.value.filter((r) => !r.wireless && !r.dongle)
  return [
    {
      key: 'module',
      icon: 'i-lucide-bluetooth',
      tone: 'var(--ok)',
      title: 'Reads and writes over Bluetooth',
      note: '',
      rows: own,
      unreachable: false,
    },
    {
      key: 'dongle',
      icon: 'i-lucide-bluetooth-searching',
      tone: 'var(--cn)',
      title: 'Reads through a clip-on dongle',
      note:
        'A dongle clips onto the programming port and connects over Bluetooth. Read, back up, edit and ' +
        'export here. Writing needs a cable, so a computer or an Android phone.',
      rows: viaDongle,
      unreachable: false,
    },
    {
      key: 'cabled',
      icon: 'i-lucide-cable',
      tone: 'var(--fn)',
      title: 'Needs a cable · not this device',
      note:
        'A dongle does not reach these, and this device cannot drive a cable. A computer or an Android ' +
        'phone is the way to program them.',
      rows: cabled,
      unreachable: true,
    },
  ].filter((g) => g.rows.length > 0)
})
</script>

<template>
  <div>
    <!--
      Said once, above the list, instead of five times inside it.

      Every driver is built with `enableWrite: true`, so a per-row capability
      chip read "Read and write" on all five - and the column meant to carry a
      warning became furniture for the second time. This file's own header
      records that failure about the matrix it replaced; it recurred because the
      chip was still per-row. A fact true of every row belongs above the list.
    -->
    <h2 style="font-size: 16px; font-weight: 600; letter-spacing: -0.015em; color: var(--tx)">
      {{ usbHost ? 'Which radio is on the cable?' : 'Which radio are you connecting?' }}
    </h2>
    <p style="font-size: 13px; line-height: 1.55; color: var(--fn); margin-top: 4px">
      {{ usbHost
        ? 'All five can be read and written. Pick the one on the cable so boofwang sends the right handshake.'
        : 'Ordered by what this device can reach, not by what boofwang supports.' }}
    </p>

    <!-- Flat, in registry order, wherever a cable is a route. -->
    <div
      v-if="usbHost"
      style="border: 1px solid var(--ln); background: var(--pn); border-radius: 7px; overflow: hidden; margin-top: 11px"
    >
      <ConnectDriverRow
        v-for="row in rows"
        :key="row.id"
        :row="row"
        :selected="selected"
        :active-radio="activeRadio"
        @choose="emit('choose', $event)"
      />
    </div>

    <!-- Grouped by reach where it is not. -->
    <template v-else>
      <div v-for="g in groups" :key="g.key">
        <div class="flex items-center" style="gap: 7px; margin-top: 16px; margin-bottom: 7px">
          <UIcon :name="g.icon" :style="{ width: '13px', height: '13px', color: g.tone }" />
          <span style="font-size: 12px; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase; color: var(--fn)">
            {{ g.title }}
          </span>
        </div>
        <p v-if="g.note" style="font-size: 12.5px; line-height: 1.5; color: var(--fn); margin-bottom: 7px">
          {{ g.note }}
        </p>
        <div
          style="background: var(--pn); border-radius: 7px; overflow: hidden"
          :style="{ border: g.unreachable ? '1px dashed var(--ln)' : '1px solid var(--ln)' }"
        >
          <ConnectDriverRow
            v-for="(row, i) in g.rows"
            :key="row.id"
            :row="row"
            :selected="selected"
            :active-radio="activeRadio"
            :dimmed="g.unreachable"
            :last="i === g.rows.length - 1"
            @choose="emit('choose', $event)"
          />
        </div>
      </div>
    </template>

    <!--
      The two wireless routes are different claims and the note keeps them
      apart. `transports` including bluetooth means the radio has a module;
      `dongle` means its programming port takes a clip-on bridge. An earlier
      draft of this copy collapsed them and was wrong.
    -->
    <p v-if="usbHost" style="font-size: 12px; line-height: 1.5; color: var(--fn); margin: 9px 2px 0">
      A clip-on Bluetooth dongle fits the programming port on four of these and reads them over
      Bluetooth. The UV-5R Mini has a Bluetooth module of its own and needs no dongle.
    </p>

    <!--
      Every list of supported hardware is also a list of hardware someone owns
      and cannot use. Saying where to ask costs one row.
    -->
    <a
      href="https://github.com/thebentern/boofwang/issues/new?title=Radio%20support%3A%20&body=Which%20radio%2C%20and%20what%20programming%20software%20it%20uses%20today%3A"
      target="_blank"
      rel="noopener"
      class="w-full flex items-center gap-3"
      style="height: 44px; padding: 0 15px; color: var(--acTx)"
    >
      <UIcon name="i-lucide-plus" class="shrink-0" style="width: 14px; height: 14px" />
      <span style="font-size: 14px; font-weight: 600">Add support for your radio</span>
      <span class="hidden sm:inline" style="font-size: 13px; color: var(--fn)">
        Tell us which one, on GitHub
      </span>
      <UIcon name="i-lucide-arrow-up-right" class="ms-auto shrink-0" style="width: 14px; height: 14px" />
    </a>
  </div>
</template>

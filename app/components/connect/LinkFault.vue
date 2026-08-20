<script setup lang="ts">
import type { Risk } from '~/components/RiskAction.vue'
import type { HopLink, HopTone } from '~/components/connect/HopTrail.vue'

/**
 * Everything that is not the healthy state.
 *
 * One card, one tone, and a trail that says which of the three hops gave way.
 * The copy lives here rather than in the page because these are the sentences
 * the tool is judged on: a person whose radio will not read is deciding whether
 * the fault is theirs, their cable's, or ours, and "could not read the radio"
 * sends all three of them to the same dead end.
 *
 * Two rules the wording follows. It never blames a layer it has not tested -
 * the port chooser is the browser's own and we say so instead of pretending to
 * drive it. And it never prints bytes it did not see: the protocol log is
 * whatever the transport actually recorded, passed in by the page, so an empty
 * log means an empty log rather than a plausible-looking sample.
 */
export type FaultState =
  | 'first'
  | 'picking'
  | 'reading'
  | 'empty'
  | 'echo'
  | 'off'
  | 'desync'
  | 'wrong'
  | 'unsupported'
  | 'insecure'

interface ActionSpec {
  readonly key: string
  readonly label: string
  readonly icon: string
  readonly risk?: Risk
  readonly ghost?: boolean
}

interface FaultCopy {
  readonly tone: 'dg' | 'cn' | 'in'
  readonly title: string
  readonly body: string
  readonly browser?: HopTone
  readonly adapter: HopTone
  readonly radio: HopTone
  readonly links: readonly [HopLink, HopLink]
  /** Reference data that is true regardless of what happened on this cable. */
  readonly staticLog?: string
  readonly steps?: readonly (readonly [string, string])[]
  readonly progress?: boolean
  readonly actions?: readonly ActionSpec[]
}

const props = defineProps<{
  state: FaultState
  /** The radio the read is aimed at, for the sentences that name one. */
  model: string
  /** The browser's own name, for the sentence about its port chooser. */
  browserName: string
  /** Why Web Serial is unavailable, when it is. */
  advice?: string
  /** The transport's own record of this failure. Never invented here. */
  log?: string | null
  progress?: { phase: string; done: number; total: number; percent: number } | null
  traceAvailable?: boolean
}>()

const emit = defineEmits<{ action: [key: string] }>()

const RETRY: ActionSpec = { key: 'read', label: 'Try again', icon: 'i-lucide-arrow-right' }
const SAVE_LOG: ActionSpec = { key: 'trace', label: 'Save the protocol log', icon: 'i-lucide-file-down', ghost: true }

const STATES: Record<FaultState, FaultCopy> = {
  first: {
    tone: 'in',
    adapter: 'neutral',
    radio: 'neutral',
    links: ['none', 'none'],
    title: 'Program your radio from the browser',
    body:
      'Nothing to install, no account, no server — your codeplug never leaves this machine. Web Serial will ' +
      'not let us look for your cable until you ask us to, so the first step is always yours.',
    actions: [{ key: 'pick', label: 'Connect a radio', icon: 'i-lucide-usb' }],
  },

  picking: {
    tone: 'in',
    adapter: 'in',
    radio: 'neutral',
    links: ['work', 'none'],
    title: '{browser} is showing its own port list',
    body:
      'We cannot style that list, read it, or tell whether your cable is in it. So here is the one useful ' +
      'thing we can say: a programming cable appears as its USB-serial chip, never as a radio.',
    // The four bridges `USB_BRIDGES` in useWebSerial knows by name, which are
    // the four a programming cable is realistically built around.
    staticLog:
      'CH340 · USB Serial         1a86:7523\n' +
      'CP2102 USB to UART         10c4:ea60\n' +
      'Prolific PL2303            067b:2303\n' +
      'FTDI FT232R                0403:6001',
  },

  reading: {
    tone: 'in',
    adapter: 'ok',
    radio: 'in',
    links: ['ok', 'work'],
    title: 'Reading the {model}',
    body: 'The memory is copied block by block. The backup is written the moment the last block lands.',
    progress: true,
    actions: [{ key: 'cancel', label: 'Cancel', icon: 'i-lucide-x', ghost: true }],
  },

  empty: {
    tone: 'dg',
    adapter: 'dg',
    radio: 'neutral',
    links: ['bad', 'none'],
    title: 'The port list was empty',
    body:
      'Your browser found no serial ports at all, which means the operating system has not seen the cable. ' +
      'This is physical or a driver, and never something boofwang can fix from here.',
    steps: [
      ['i-lucide-usb', 'Unplug and replug. A CH340 that is not seated shows nothing at all.'],
      ['i-lucide-laptop', 'On macOS a counterfeit CH340 may need the vendor driver; the genuine chip does not.'],
      ['i-lucide-cable', 'Try the other end — some cables carry data on only one of two identical plugs.'],
    ],
    actions: [{ key: 'pick', label: 'Try again', icon: 'i-lucide-arrow-right' }],
  },

  echo: {
    tone: 'dg',
    adapter: 'dg',
    radio: 'neutral',
    links: ['bad', 'none'],
    title: 'That adapter is echoing our own bytes back',
    body:
      'Every byte we sent came straight back, byte for byte, with no radio in the loop. That is a loopback — ' +
      'a counterfeit adapter with TX bridged to RX, or a cable with nothing on the far end. boofwang stops ' +
      'rather than treating its own output as a reply.',
    steps: [
      ['i-lucide-usb', 'A counterfeit CH340 or PL2303. Genuine chips are cheap; the fakes do this.'],
      ['i-lucide-cable', 'A cable plugged into the computer with nothing on the radio end.'],
      ['i-lucide-cpu', 'A serial adapter with a loopback jumper still fitted.'],
    ],
    actions: [{ key: 'pick', label: 'Try a different port', icon: 'i-lucide-usb' }, SAVE_LOG],
  },

  off: {
    tone: 'dg',
    adapter: 'ok',
    radio: 'dg',
    links: ['ok', 'bad'],
    title: 'The port opened, but nothing answered',
    body:
      'boofwang sent the {model} handshake and got silence. The cable is fine — the radio is not listening.',
    steps: [
      ['i-lucide-radio', 'Switch the radio on. It does not need any special mode.'],
      ['i-lucide-cable', 'Push the plug in until it clicks. Half-seated is the commonest cause by far.'],
      ['i-lucide-zap', 'Turn the volume up — on some radios the programming pin shares the speaker jack.'],
    ],
    actions: [RETRY, SAVE_LOG],
  },

  desync: {
    tone: 'dg',
    adapter: 'ok',
    radio: 'dg',
    links: ['ok', 'bad'],
    title: 'A late reply arrived and the line can no longer be trusted',
    body:
      'One command timed out, and its answer turned up while boofwang was waiting for the next one. Every ' +
      'frame after that is shifted by a few bytes. Continuing would write plausible-looking garbage, so the ' +
      'transport refuses everything until it resynchronises.',
    steps: [
      ['i-lucide-history', 'boofwang closes the port and reopens it. Nothing was written.'],
      ['i-lucide-cable', 'If it recurs on the same cable, that cable is dropping bytes under load.'],
      ['i-lucide-file-down', 'The protocol log is the useful thing to attach to a bug report.'],
    ],
    actions: [{ key: 'read', label: 'Resynchronise and retry', icon: 'i-lucide-history' }, SAVE_LOG],
  },

  wrong: {
    tone: 'cn',
    adapter: 'ok',
    radio: 'cn',
    links: ['ok', 'warn'],
    // Not "this is a UV-5R Mini": the handshake failed, so the one thing we do
    // not know is what did answer. Naming a model we have not identified would
    // be the same overclaim the rest of this screen exists to avoid.
    title: 'Something answered, but not as a {model}',
    body:
      'Bytes came back, and they are not the shape the {model} driver expects, so nothing was read. Reading ' +
      'with the wrong memory map produces a codeplug that looks plausible and is wrong throughout.',
    steps: [
      [
        'i-lucide-users',
        'Radios ship under near-identical names and answer different handshakes. Pick the driver that matches ' +
          'the label on the radio, not the one that matches the cable.',
      ],
    ],
    actions: [RETRY, SAVE_LOG],
  },

  unsupported: {
    tone: 'dg',
    browser: 'dg',
    adapter: 'neutral',
    radio: 'neutral',
    links: ['none', 'none'],
    title: 'This browser cannot talk to a radio',
    body: '{advice}',
  },

  insecure: {
    tone: 'dg',
    browser: 'dg',
    adapter: 'neutral',
    radio: 'neutral',
    links: ['none', 'none'],
    title: 'This page needs a secure connection',
    body: '{advice}',
  },
}

/**
 * Copy is stored as whole sentences with `{model}`-style holes rather than
 * assembled from fragments, so a translator or an editor reads the same string
 * the user does.
 */
function fill(text: string): string {
  return text
    .replaceAll('{model}', props.model)
    .replaceAll('{browser}', props.browserName)
    .replaceAll('{advice}', props.advice ?? '')
}

const copy = computed(() => STATES[props.state])

const TONE_BORDER = { dg: 'var(--dgL)', cn: 'var(--cnL)', in: 'var(--inL)' } as const
const TONE_BACKGROUND = { dg: 'var(--dgB)', cn: 'var(--cnB)', in: 'var(--inB)' } as const
const TONE_COLOUR = { dg: 'var(--dg)', cn: 'var(--cn)', in: 'var(--in)' } as const
const TONE_ICON = {
  dg: 'i-lucide-circle-alert',
  cn: 'i-lucide-triangle-alert',
  in: 'i-lucide-info',
} as const

/** The log is only ever what was recorded; a state with nothing to show shows nothing. */
const logText = computed(() => copy.value.staticLog ?? props.log ?? '')

/** `handshake`, `read` and friends are protocol words; the bar is read by people. */
const PHASES: Record<string, string> = {
  handshake: 'saying hello',
  scan: 'scanning memory',
  read: 'reading blocks',
  encode: 'encoding',
  write: 'writing blocks',
  verify: 'reading back',
}

const phaseLabel = computed(() => {
  const phase = props.progress?.phase
  return phase ? (PHASES[phase] ?? phase) : 'starting'
})

/** Actions that need a trace are hidden when there is none, rather than failing on click. */
const actions = computed(() => (copy.value.actions ?? []).filter((a) => a.key !== 'trace' || props.traceAvailable))
</script>

<template>
  <div
    style="border-radius: 8px; overflow: hidden"
    :style="{ border: `1px solid ${TONE_BORDER[copy.tone]}`, background: TONE_BACKGROUND[copy.tone] }"
  >
    <div class="flex items-start gap-3" style="padding: 15px 17px">
      <span
        class="flex items-center justify-center shrink-0"
        style="width: 30px; height: 30px; border-radius: 7px; background: var(--pn)"
        :style="{ border: `1px solid ${TONE_BORDER[copy.tone]}` }"
      >
        <UIcon
          :name="TONE_ICON[copy.tone]"
          style="width: 17px; height: 17px"
          :style="{ color: TONE_COLOUR[copy.tone] }"
        />
      </span>

      <div class="min-w-0 flex-1">
        <div style="font-size: 16.5px; font-weight: 600; letter-spacing: -0.015em; line-height: 1.3; margin-bottom: 8px">
          {{ fill(copy.title) }}
        </div>

        <ConnectHopTrail
          class="mb-2.5"
          :browser="copy.browser"
          :adapter="copy.adapter"
          :radio="copy.radio"
          :links="copy.links"
        />

        <p style="margin: 0; font-size: 14px; line-height: 1.6; color: var(--mu); max-width: 78ch">
          {{ fill(copy.body) }}
        </p>

        <pre
          v-if="logText"
          class="font-mono tabular mt-[11px] overflow-auto"
          style="
            font-size: 13px;
            color: var(--fn);
            background: var(--pn2);
            border: 1px solid var(--ln);
            border-radius: 6px;
            padding: 9px 11px;
            line-height: 1.65;
            white-space: pre;
          "
        >{{ logText }}</pre>

        <div v-if="copy.progress" class="mt-3">
          <div style="height: 4px; border-radius: 2px; background: var(--pn3); overflow: hidden">
            <div
              style="height: 100%; background: var(--in); transition: width 0.18s linear"
              :style="{ width: `${progress?.percent ?? 0}%` }"
            />
          </div>
          <div class="flex justify-between mt-[7px]" style="font-size: 13px; color: var(--mu)">
            <span>{{ phaseLabel }}</span>
            <span class="font-mono tabular">
              {{ (progress?.done ?? 0).toLocaleString() }} / {{ (progress?.total ?? 0).toLocaleString() }} bytes
            </span>
          </div>
        </div>

        <div v-if="copy.steps" class="mt-3 grid gap-1.5">
          <div v-for="[icon, text] in copy.steps" :key="text" class="flex gap-2 items-baseline">
            <UIcon :name="icon" class="shrink-0" style="width: 13px; height: 13px; color: var(--fn)" />
            <span style="font-size: 14px; line-height: 1.55; color: var(--mu)">{{ text }}</span>
          </div>
        </div>

        <div v-if="actions.length || $slots.actions" class="mt-3.5 flex items-center gap-2 flex-wrap">
          <RiskAction
            v-for="action in actions"
            :key="action.key"
            :risk="action.risk ?? 'neutral'"
            :ghost="action.ghost"
            :label="action.label"
            :icon="action.icon"
            @click="emit('action', action.key)"
          />
          <slot name="actions" />
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { Risk } from '~/components/RiskAction.vue'
import type { HopLink, HopTone, HopVia } from '~/components/connect/HopTrail.vue'

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
  /*
   * The mobile shell on an iPhone or iPad. Not a fault in the browser sense -
   * nothing is missing or misconfigured - but the cable route does not exist
   * on that hardware and the card has to say what does.
   */
  | 'no-cable'
  /*
   * The Bluetooth states.
   *
   * Separate rather than reusing the cable ones because the remedies are
   * different sentences, and one of them is a sentence no cable state has to
   * say: the reason a Bluetooth attempt most likely failed is that boofwang is
   * filtering the chooser on a service UUID nobody has ever read off one of
   * these radios. Telling a user to push the plug in further would be worse
   * than useless there.
   */
  | 'ble-picking'
  | 'ble-empty'
  | 'ble-off'

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
  /** What the middle hop is, when the state is only ever about one carrier. */
  readonly via?: HopVia
  /** Reference data that is true regardless of what happened on this cable. */
  readonly staticLog?: string
  readonly steps?: readonly (readonly [string, string])[]
  readonly progress?: boolean
  readonly actions?: readonly ActionSpec[]
  /**
   * Whether to print where Bluetooth stands.
   *
   * Only on the card that has just told someone their browser cannot talk to a
   * radio, because that is the one place the answer changes what they do next -
   * and where it would otherwise contradict itself. Android Chrome lands there
   * (no Web Serial on any mobile browser) and is the one platform where
   * Bluetooth is the *only* route, so a flat "this browser cannot" would be
   * both discouraging and wrong.
   *
   * Everywhere else it is noise: a Firefox user whose cable works does not need
   * to hear about an API they will never reach for.
   */
  readonly showBleNote?: boolean
}

const props = defineProps<{
  state: FaultState
  /** The radio the read is aimed at, for the sentences that name one. */
  model: string
  /** The browser's own name, for the sentence about its port chooser. */
  browserName: string
  /** What the first hop of the trail is called: 'browser', or 'app' in a shell. */
  firstHop?: string
  /** Why Web Serial is unavailable, when it is. */
  advice?: string
  /** Where Bluetooth stands for this browser: an alternative, or why not. */
  bleNote?: string
  /**
   * What the radio calls itself in the browser's device list.
   *
   * Needed because the chooser cannot be filtered for this radio, so the list
   * is every Bluetooth device in range and the name is the only thing telling
   * someone which row is theirs.
   */
  bleName?: string
  /** What the middle hop is for this session, unless the state overrides it. */
  via?: HopVia
  /** The transport's own record of this failure. Never invented here. */
  log?: string | null
  progress?: { phase: string; done: number; total: number; percent: number } | null
  traceAvailable?: boolean
}>()

const emit = defineEmits<{ action: [key: string] }>()

const RETRY: ActionSpec = { key: 'read', label: 'Try again', icon: 'i-lucide-arrow-right' }
const SAVE_LOG: ActionSpec = { key: 'trace', label: 'Save the protocol log', icon: 'i-lucide-file-down', ghost: true }
/**
 * The way back to the other carrier.
 *
 * Every Bluetooth fault used to offer only its own retry, which left anyone
 * whose radio will not pair with nowhere to go but the browser's back button.
 * Bluetooth is the newer and less certain of the two routes, so the cable has
 * to stay one click away from every one of its dead ends.
 */
const USE_CABLE: ActionSpec = { key: 'cable', label: 'Use a cable instead', icon: 'i-lucide-usb', ghost: true }

const STATES: Record<FaultState, FaultCopy> = {
  first: {
    tone: 'in',
    adapter: 'neutral',
    radio: 'neutral',
    links: ['none', 'none'],
    title: 'Program your radio from the browser',
    body:
      'Nothing to install, no account, no server. Your codeplug never leaves this machine. Web Serial will ' +
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
    // The four bridges `KNOWN_BRIDGE_VENDORS` in lib/transport/usb-bridges.ts
    // knows by name, which are the four a programming cable is realistically
    // built around.
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
      ['i-lucide-cable', 'Try the other end. Some cables carry data on only one of two identical plugs.'],
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
      'Every byte we sent came straight back, byte for byte, with no radio in the loop. That is a loopback: ' +
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
      'boofwang sent the {model} handshake and got silence. The cable is fine; the radio is not listening.',
    steps: [
      ['i-lucide-radio', 'Switch the radio on. It does not need any special mode.'],
      ['i-lucide-cable', 'Push the plug in until it clicks. Half-seated is the commonest cause by far.'],
      ['i-lucide-zap', 'Turn the volume up. On some radios the programming pin shares the speaker jack.'],
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
    showBleNote: true,
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

  'no-cable': {
    tone: 'in',
    browser: 'neutral',
    adapter: 'neutral',
    radio: 'neutral',
    via: 'bluetooth',
    links: ['none', 'none'],
    title: 'Bluetooth is the way in on this device',
    body: '{advice}',
    showBleNote: true,
  },

  'ble-picking': {
    tone: 'in',
    adapter: 'in',
    radio: 'neutral',
    via: 'bluetooth',
    links: ['work', 'none'],
    title: '{browser} is showing its own Bluetooth device list',
    body:
      'That list belongs to the browser and we cannot style it, read it, or tell whether your radio is in ' +
      'it. It shows devices named like a UV-5R Mini in wireless CPS mode, or advertising the service one ' +
      'was read on. A radio that is switched off or already paired to a phone will not be there at all.',
  },

  'ble-empty': {
    tone: 'cn',
    adapter: 'cn',
    radio: 'neutral',
    via: 'bluetooth',
    links: ['warn', 'none'],
    title: 'No radio was listed',
    body:
      'The chooser is filtered on the name a UV-5R Mini advertises in wireless CPS mode, and on the ' +
      'service one was read on. Neither has been confirmed to be in this radio’s advertisement, so an ' +
      'empty list may be a filter that cannot match rather than a radio that is not there. "Show every ' +
      'device" removes both and is the way to tell the two apart.',
    steps: [
      ['i-lucide-radio', 'Put the radio into wireless CPS mode, and check it is not already paired to a phone.'],
      ['i-lucide-bluetooth', 'Show every device, and look for {bleName} in the list.'],
      [
        'i-lucide-git-branch',
        'If it only appears that way, this radio advertises nothing that can be filtered on, and ' +
          'lib/transport/bluetooth-uuids.ts is where that belongs.',
      ],
    ],
    actions: [
      { key: 'bluetooth', label: 'Try again', icon: 'i-lucide-arrow-right' },
      { key: 'bluetooth-all', label: 'Show every device', icon: 'i-lucide-bluetooth' },
    ],
  },

  'ble-off': {
    tone: 'dg',
    adapter: 'ok',
    radio: 'dg',
    via: 'bluetooth',
    links: ['ok', 'bad'],
    title: 'The Bluetooth link opened, but nothing answered',
    body:
      'boofwang connected to the radio over Bluetooth, sent the {model} handshake, and got silence. That ' +
      'means the link is up and the bytes are going somewhere that is not the radio’s programming ' +
      'interface: most likely the wrong characteristic, or a service that carries something else entirely. ' +
      'Nobody has proved this path against a radio yet, so treat a failure here as a boofwang problem before ' +
      'a radio one.',
    steps: [
      ['i-lucide-radio', 'Switch the radio on and make sure nothing else is connected to it.'],
      ['i-lucide-search', 'Check the characteristic numbers with a Bluetooth scanner, as above.'],
      ['i-lucide-cable', 'A programming cable is the path that has actually been proved to work.'],
    ],
    actions: [{ key: 'bluetooth', label: 'Try again', icon: 'i-lucide-arrow-right' }, SAVE_LOG],
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
    // On a dongle session the unnamed device is the dongle, not the radio -
    // the radio is on the far side of it and was never in the chooser.
    .replaceAll('{bleName}', props.bleName ?? (via.value === 'dongle' ? 'the dongle' : 'the radio'))
}

const copy = computed(() => STATES[props.state])

/**
 * A state that is only ever about one carrier says so; otherwise the page
 * does. A state that says 'bluetooth' is not wrong on a dongle session - it
 * is the same carrier - but the page knows the more specific fact, so the
 * trail shows the dongle a person can actually reseat.
 */
const via = computed<HopVia>(() => {
  const stated = copy.value.via
  if (stated === 'bluetooth' && props.via === 'dongle') return 'dongle'
  return stated ?? props.via ?? 'adapter'
})

/**
 * The advice lines, with the one substitution a dongle needs.
 *
 * "Put the radio into wireless CPS mode" is the right first move for a radio
 * with a BLE module and a meaningless one for a radio reached through a
 * clip-on bridge - a dongled radio has no such mode, and the thing to check
 * is the dongle itself.
 */
const steps = computed(() => {
  const raw = copy.value.steps ?? []
  if (via.value !== 'dongle') return raw
  return raw.map(([icon, text]) =>
    text.includes('wireless CPS mode')
      ? ([
          'i-lucide-radio',
          'Check the dongle is pushed all the way onto the two-pin port, powered, and the radio is switched on.',
        ] as const)
      : ([icon, text] as const),
  )
})

const bleNote = computed(() => (copy.value.showBleNote ? (props.bleNote ?? '') : ''))

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

/**
 * Nothing is offered while the radio is still being talked to.
 *
 * These two states are waiting on a dialogue or a transfer, and their own
 * actions are the cancel. Offering a change of carrier mid-attempt would be a
 * second thing to click at the moment the screen is least able to act on it.
 */
const IN_PROGRESS: readonly FaultState[] = ['picking', 'reading', 'ble-picking']

/**
 * Actions that need a trace are hidden when there is none, rather than failing
 * on click. Anything reached over Bluetooth also gains a way back to the cable.
 *
 * That last part is a rule rather than an entry in each Bluetooth state,
 * because a Bluetooth attempt can fail into the shared states too - a read that
 * times out lands in `off`, not `ble-off` - and hardcoding it three times would
 * have left exactly those cases stuck.
 */
const actions = computed(() => {
  const listed = (copy.value.actions ?? []).filter((a) => a.key !== 'trace' || props.traceAvailable)
  const stranded = (via.value === 'bluetooth' || via.value === 'dongle') && !IN_PROGRESS.includes(props.state)
  if (!stranded || listed.some((a) => a.key === 'cable')) return listed
  // Before the log, which is the least likely next move.
  const at = listed.findIndex((a) => a.key === 'trace')
  return at < 0 ? [...listed, USE_CABLE] : [...listed.slice(0, at), USE_CABLE, ...listed.slice(at)]
})
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
          :via="via"
          :browser-label="firstHop ?? 'browser'"
        />

        <p style="margin: 0; font-size: 14px; line-height: 1.6; color: var(--mu); max-width: 78ch">
          {{ fill(copy.body) }}
        </p>

        <!--
          Only ever printed when Bluetooth is genuinely unavailable, so it never
          reads as a suggestion the reader cannot act on.
        -->
        <p
          v-if="bleNote"
          style="margin: 9px 0 0; font-size: 14px; line-height: 1.6; color: var(--mu); max-width: 78ch"
        >
          {{ bleNote }}
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

        <div v-if="steps.length" class="mt-3 grid gap-1.5">
          <div v-for="[icon, text] in steps" :key="text" class="flex gap-2 items-baseline">
            <UIcon :name="icon" class="shrink-0" style="width: 13px; height: 13px; color: var(--fn)" />
            <!-- Filled like the title and body: a step carrying {bleName}
                 rendered the hole itself until this went through `fill`. -->
            <span style="font-size: 14px; line-height: 1.55; color: var(--mu)">{{ fill(text) }}</span>
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

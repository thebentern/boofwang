<script setup lang="ts">
import type { RadioId } from '#core/model/codeplug.js'
import { RADIO_IDS, SCHEMAS, isImplemented } from '#core/radio/registry.js'
import type { FaultState } from '~/components/connect/LinkFault.vue'

/**
 * Connect: get a codeplug off a radio.
 *
 * The screen has one job and two audiences - somebody who has never seen it and
 * needs to know there is nothing to install, and somebody who came back to read
 * their radio - and it serves both without asking which they are.
 *
 * The decision that shapes everything here is that `getPorts()` answers without
 * a user gesture. A granted port means the working case is already known before
 * the first paint, so the healthy state is one line and one button and the
 * diagnostics are not on screen at all. Topology, protocol logs and remedies
 * appear when a link actually breaks, which is the only time they are worth the
 * space; the previous landing page put a pitch and four radio cards in front of
 * a button whose answer was already yes.
 *
 * Connection state is derived rather than stored. `getPorts()`, the transfer
 * store and the transport's own error classes already say everything the eight
 * states need, and a second copy of that in a ref is a second thing that can be
 * wrong.
 */
useSeoMeta({ title: 'Connect' })

const support = useSerialSupport()
const device = useDeviceStore()
const codeplug = useCodeplugStore()
const transfer = useTransferStore()
const session = useRadioSession()
const toast = useToast()

/**
 * Only the USB identity of each granted port is kept, never the port objects.
 *
 * A `SerialPort` holds live streams; putting one in a ref wraps it in a
 * reactive proxy, and nothing on this page needs the port itself - the read
 * re-acquires it inside the click handler, which is where transient activation
 * exists.
 */
const adapters = shallowRef<readonly { usbVendorId?: number; usbProductId?: number }[]>([])
const bridged = ref(false)
const picking = ref(false)
/**
 * True from the click until the read is over, which is wider than
 * `transfer.active`: the chooser, the port opening and the handshake all happen
 * before a single byte of the image moves, and a button that sits inert through
 * them reads as one that did not register the click.
 */
const connecting = ref(false)
const fault = ref<FaultState | null>(null)
const mounted = ref(false)

async function refreshAdapters() {
  adapters.value = (await grantedPorts()).map((p) => p.info)
}

let stopDisconnect: (() => void) | null = null

onMounted(async () => {
  bridged.value = bridgeEnabled()
  await refreshAdapters()
  // Unplugging the cable takes the granted port with it, and the screen should
  // fall back to "connect a radio" rather than offering to read a port that is
  // no longer there.
  stopDisconnect = onSerialDisconnect(() => void refreshAdapters())
  mounted.value = true
})

onBeforeUnmount(() => {
  stopDisconnect?.()
  stopDisconnect = null
})

// ------------------------------------------------------------ which radio --

/**
 * The radio a handshake has actually named, if one has.
 *
 * `device.ident` only exists while a port is open, and reading closes it, so
 * the open codeplug is what carries the answer afterwards. Anything else - the
 * last id passed to `connect`, the USB vendor of the cable - is a guess, and
 * this page is careful about the difference.
 */
const confirmed = computed<RadioId | null>(() => device.ident?.radioId ?? codeplug.doc?.radio ?? null)

const chosen = ref<RadioId | null>(null)

const radioId = computed<RadioId>(() => confirmed.value ?? chosen.value ?? device.radioId ?? 'uvk5')

function nameOf(id: RadioId): string {
  const schema = SCHEMAS[id]
  return schema ? `${schema.vendor} ${schema.model}` : id
}

const radioName = computed(() => nameOf(radioId.value))

const radioOptions = computed(() => RADIO_IDS.filter(isImplemented).map((id) => ({ id, label: nameOf(id) })))

const firmware = computed(() => device.ident?.variant ?? (confirmed.value ? codeplug.image?.variant : null))

const adapterLabel = computed(() => {
  if (bridged.value) return 'development serial bridge'
  const first = adapters.value[0]
  return first ? describeAdapter(first) : ''
})

/**
 * The mono sub-line under the radio's name.
 *
 * The design's `CH340 on /dev/ttyUSB0` is one fact more than Web Serial will
 * give us: the API reports a USB vendor and product and never a device path, so
 * the identity is all there is to print. When no handshake has happened the
 * line says so rather than letting a chosen model read as an identified one.
 */
const detail = computed(() => {
  const parts: string[] = []
  if (firmware.value) parts.push(`fw ${firmware.value}`)
  if (adapterLabel.value) parts.push(adapterLabel.value)
  if (!confirmed.value) parts.push('model not confirmed yet')
  return parts.join(' · ')
})

// ------------------------------------------------------------- link state --

const hasPort = computed(() => adapters.value.length > 0 || bridged.value)

/**
 * Which of the ten cards to draw.
 *
 * Ordered by precedence rather than by likelihood: a browser that cannot open a
 * port at all outranks anything about cables, and a transfer in flight outranks
 * a fault left over from the attempt before it.
 */
const link = computed<FaultState | 'ready'>(() => {
  if (!mounted.value) return 'first'
  if (support.value.blocker === 'insecure-context') return 'insecure'
  if (support.value.blocker === 'unsupported-browser') return 'unsupported'
  if (transfer.active) return 'reading'
  if (picking.value) return 'picking'
  if (fault.value) return fault.value
  return hasPort.value ? 'ready' : 'first'
})

/**
 * Which link broke, from the error the transport raised.
 *
 * Matched on the message because that is what survives `connectAndRead`, which
 * reports failures through the store rather than rethrowing. The strings are
 * the ones `lib/transport/errors.ts` and `lib/radio/driver.ts` construct, and
 * every branch below is a distinct remedy: resynchronise, replace the adapter,
 * pick a different driver, switch the radio on.
 *
 * Anything unrecognised falls to `off`, which is the commonest cause by a wide
 * margin - and whose card prints the real message verbatim underneath, so a
 * mismatched headline never hides what actually happened.
 */
function classify(message: string): FaultState {
  if (/out of sync|resynchronise/i.test(message)) return 'desync'
  if (/returning boofwang.s own data/i.test(message)) return 'echo'
  if (/\n\s*(expected|received):/.test(message)) return 'wrong'
  return 'off'
}

/**
 * Cancelling is not a fault, and the transport cannot tell the difference.
 *
 * Pressing Cancel aborts the signal, which surfaces as an ordinary transport
 * error - so without this the screen would answer a deliberate cancellation
 * with three remedies for a radio that is switched off.
 */
function wasCancelled(message: string): boolean {
  return /Transfer aborted|operation was aborted/i.test(message)
}

// ------------------------------------------------------- the protocol log --

const HEX_LABEL_WIDTH = 'received '.length
const ECHO_MAX_BYTES = 16

function spacedHex(hex: string, limit: number): { text: string; truncated: boolean } {
  const bytes = hex.match(/../g) ?? []
  const shown = bytes.slice(0, limit)
  return { text: shown.join(' '), truncated: bytes.length > limit }
}

function identicalPrefixBytes(a: string, b: string): number {
  const left = a.match(/../g) ?? []
  const right = b.match(/../g) ?? []
  let n = 0
  while (n < left.length && n < right.length && left[n] === right[n]) n++
  return n
}

/**
 * The sent bytes above the received bytes, with a caret under the run they share.
 *
 * A loopback is the one failure whose symptom is a structurally perfect frame -
 * right header, right footer, valid checksum - so every layer beneath happily
 * accepts it and the radio looks like it is answering with nonsense. Showing
 * the two lines together is what turns that into an obvious fact, and the bytes
 * come out of the session recording rather than being illustrated: if the trace
 * is gone there is nothing honest to draw, and the card falls back to the
 * error's own words.
 */
function echoLog(): string | null {
  const json = device.traceJson()
  if (!json) return null

  let entries: { dir?: string; hex?: string }[]
  try {
    entries = (JSON.parse(json) as { entries?: { dir?: string; hex?: string }[] }).entries ?? []
  } catch {
    return null
  }

  let rxAt = -1
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i]?.dir === 'rx' && entries[i]?.hex) {
      rxAt = i
      break
    }
  }
  if (rxAt < 0) return null

  let txAt = -1
  for (let i = rxAt - 1; i >= 0; i--) {
    if (entries[i]?.dir === 'tx' && entries[i]?.hex) {
      txAt = i
      break
    }
  }
  if (txAt < 0) return null

  const txHex = entries[txAt]?.hex ?? ''
  const rxHex = entries[rxAt]?.hex ?? ''
  const shared = identicalPrefixBytes(txHex, rxHex)
  if (shared === 0) return null

  const sent = spacedHex(txHex, ECHO_MAX_BYTES)
  const received = spacedHex(rxHex, ECHO_MAX_BYTES)
  const caretBytes = Math.min(shared, ECHO_MAX_BYTES)
  const carets = '^'.repeat(caretBytes * 3 - 1)

  return (
    `sent     ${sent.text}${sent.truncated ? ' …' : ''}\n` +
    `received ${received.text}${received.truncated ? ' …' : ''}\n` +
    `${' '.repeat(HEX_LABEL_WIDTH)}${carets} identical — loopback detected`
  )
}

const log = computed<string | null>(() => {
  if (link.value === 'echo') return echoLog() ?? device.error
  if (link.value === 'off' || link.value === 'desync' || link.value === 'wrong') return device.error
  return null
})

const progress = computed(() =>
  transfer.active
    ? {
        phase: transfer.phase ?? '',
        done: transfer.done,
        total: transfer.total,
        percent: transfer.percent,
      }
    : null,
)

const traceAvailable = computed(() => device.traceJson() !== null)

// ---------------------------------------------------------------- actions --

/**
 * Ask for a port.
 *
 * `requestPort` needs transient activation, so it is the first thing this does
 * and nothing is awaited before it. The chooser it opens belongs to the browser
 * - we cannot style it, read it, or tell whether it had anything in it, which
 * is why `picking` says so instead of pretending to drive it.
 */
async function pickPort() {
  fault.value = null
  picking.value = true
  try {
    const choice = await requestPort()
    await refreshAdapters()
    // A dismissed chooser and an empty one both resolve to null and the browser
    // will not say which. With still nothing granted, the empty list is the case
    // worth explaining - its remedies are physical and they are the same either way.
    if (!choice && !hasPort.value) fault.value = 'empty'
  } catch (e) {
    toast.add({
      title: 'Could not open the port chooser',
      description: e instanceof Error ? e.message : String(e),
      icon: 'i-lucide-cable',
      color: 'error',
      duration: 0,
    })
  } finally {
    picking.value = false
  }
}

/**
 * Read the radio.
 *
 * `connectAndRead` acquires the port itself and reports failure through the
 * device store rather than throwing, so the outcome is read back from there.
 * `device.error` is cleared first because it survives `disconnect()`: without
 * that, a chooser dismissed after an earlier failure would redraw the earlier
 * failure's card as though it had just happened again.
 */
async function readRadio() {
  fault.value = null
  device.error = null
  connecting.value = true
  const before = codeplug.revision

  try {
    await session.connectAndRead(radioId.value)
    await refreshAdapters()
  } finally {
    connecting.value = false
  }

  if (device.error) {
    if (!wasCancelled(device.error)) fault.value = classify(device.error)
    return
  }
  if (codeplug.revision !== before) await navigateTo('/channels')
}

function onAction(key: string) {
  if (key === 'pick') void pickPort()
  else if (key === 'read') void readRadio()
  else if (key === 'cancel') transfer.cancel()
  else if (key === 'trace') void session.downloadTrace()
}

/** The states where reaching for a file instead of a cable is the sensible move. */
const FILE_STATES: readonly FaultState[] = ['first', 'empty', 'unsupported', 'insecure']
const offerFile = computed(() => link.value !== 'ready' && FILE_STATES.includes(link.value))

/**
 * The tint on the driver list marks the radio a read would use, so it needs a
 * port to be about. With nothing plugged in it would be claiming a radio is on
 * a cable that is not there, which is the one thing this screen must not do.
 */
const activeRadio = computed<RadioId | null>(() =>
  confirmed.value ?? (hasPort.value ? radioId.value : null),
)
</script>

<template>
  <div class="mx-auto" style="max-width: 1000px; padding: 26px 16px 48px">
    <ConnectConnectedCard
      v-if="link === 'ready'"
      :radio-id="radioId"
      :title="radioName"
      :detail="detail"
      :confirmed="confirmed !== null"
      :options="radioOptions"
      :busy="connecting"
      @read="readRadio"
      @other-port="pickPort"
      @choose="chosen = $event"
    />

    <ConnectLinkFault
      v-else
      :state="link"
      :model="radioName"
      :browser-name="support.browser"
      :advice="support.advice"
      :log="log"
      :progress="progress"
      :trace-available="traceAvailable"
      @action="onAction"
    >
      <template v-if="offerFile" #actions>
        <OpenCodeplugButton />
      </template>
    </ConnectLinkFault>

    <ConnectDriverList class="mt-4" :active-radio="activeRadio" />
  </div>
</template>

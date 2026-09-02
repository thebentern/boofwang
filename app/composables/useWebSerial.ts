// SPDX-License-Identifier: GPL-3.0-or-later
import type { SerialPortLike } from '#core/transport/transport.js'
import { BridgeSerialPort, listBridgePorts } from '#core/transport/bridge-serial-port.js'
import { hostSupports } from '#core/platform/host.js'
import { KNOWN_BRIDGE_VENDORS } from '#core/transport/usb-bridges.js'

/**
 * The only place in boofwang that touches `navigator.serial`.
 *
 * Everything below the UI depends on `SerialPortLike`, a structural interface,
 * which is what lets the whole driver stack run in Node against a scripted fake.
 */

export interface PortChoice {
  port: SerialPortLike
  info: { usbVendorId?: number; usbProductId?: number }
  /**
   * What to call this connection, when a USB identity is not the answer.
   *
   * A Bluetooth link has no vendor or product id at all, and
   * `describeAdapter({})` would call it "an unidentified serial port" - which
   * is both wrong and the exact phrasing a user reads as a fault.
   */
  label?: string
}

/**
 * Name an adapter by its USB-serial chip, from the one table in
 * `lib/transport/usb-bridges.ts`. Saying "Prolific PL2303" rather than
 * "067b:2303" is the difference between a user replacing a cable and a user
 * filing a bug.
 */
export function describeAdapter(info: { usbVendorId?: number; usbProductId?: number }): string {
  const vid = info.usbVendorId
  const pid = info.usbProductId
  if (vid === undefined) return 'an unidentified serial port'
  const hex = `${vid.toString(16).padStart(4, '0')}:${(pid ?? 0).toString(16).padStart(4, '0')}`
  const name = KNOWN_BRIDGE_VENDORS[vid]
  return name ? `${name} (${hex})` : `USB device ${hex}`
}

export function serialAvailable(): boolean {
  if (nativeSerial()) return true
  return typeof navigator !== 'undefined' && 'serial' in navigator
}

/**
 * Whether the shell, not the browser, supplies the serial port.
 *
 * The Android app's cable lives in `app/mobile/serial.ts`, reached by a
 * dynamic import so a browser never downloads it. The bridge still wins over
 * it below, for the same reason it wins over the real chooser.
 */
function nativeSerial(): boolean {
  return hostSupports(useShell().host, ['nativeSerial'])
}

/**
 * Prompt for a port.
 *
 * Must be called from a user gesture: `requestPort` needs transient activation
 * and throws otherwise. No filters are passed, because these cables use generic
 * USB-serial chips (a CH340 is in countless unrelated devices) and filtering on
 * them would hide legitimate adapters while admitting plenty of irrelevant ones.
 */
export async function requestPort(): Promise<PortChoice | null> {
  if (!serialAvailable()) throw new Error('This browser does not support Web Serial.')
  try {
    const port = await navigator.serial.requestPort()
    return { port: port as unknown as SerialPortLike, info: port.getInfo?.() ?? {} }
  } catch (e) {
    // The user dismissing the picker is not an error worth surfacing.
    if (e instanceof DOMException && e.name === 'NotFoundError') return null
    throw e
  }
}

/** Ports already granted, so a return visit can reconnect without a prompt. */
export async function grantedPorts(): Promise<PortChoice[]> {
  if (nativeSerial()) return (await import('~/mobile/serial')).grantedNativePorts()
  if (!serialAvailable()) return []
  const ports = await navigator.serial.getPorts()
  return ports.map((p) => ({ port: p as unknown as SerialPortLike, info: p.getInfo?.() ?? {} }))
}

/**
 * Fires when a granted device is physically unplugged.
 *
 * The port is null inside the Android app: the plugin reports the device,
 * not a port object, and nothing that listens here keys on the port.
 */
export function onSerialDisconnect(cb: (port: SerialPortLike | null) => void): () => void {
  if (nativeSerial()) {
    let off: (() => void) | null = null
    void import('~/mobile/serial').then((m) => {
      off = m.onNativeDetached(() => cb(null))
    })
    return () => off?.()
  }
  if (!serialAvailable()) return () => {}
  const handler = (ev: Event) => cb((ev.target ?? (ev as unknown as { port: unknown }).port) as SerialPortLike)
  navigator.serial.addEventListener('disconnect', handler)
  return () => navigator.serial.removeEventListener('disconnect', handler)
}

// ---------------------------------------------------------- dev-only bridge --

/**
 * The development serial bridge.
 *
 * `requestPort()` can only be answered by a person clicking a native chooser,
 * which means an automated session cannot get a port at all. That is correct
 * for a tool that talks to hardware, and it is also why bringing up a driver
 * against a real radio otherwise needs a human in the loop on every iteration.
 *
 * With `pnpm bridge` running, adding `?bridge` to the URL routes port selection
 * through a localhost socket instead. Everything below `SerialPortLike` - the
 * transport, framing, protocol, driver, decode and UI - is unchanged, so what
 * gets exercised is the shipping code path rather than a parallel one. The
 * `navigator.serial` glue in this file is the part that is not covered, and it
 * is deliberately kept small for that reason.
 *
 * Guarded three ways: only in a dev build, only with the query parameter, and
 * only against a socket the bridge itself refuses to expose off-box.
 */
const BRIDGE_DEFAULT_URL = 'ws://127.0.0.1:8765'
const BRIDGE_KEY = 'boofwang:bridge'

/**
 * The bridge address, if this session is using one.
 *
 * Remembered in `sessionStorage` after it is first seen in the URL, because
 * client-side navigation drops the query string: arriving at `/?bridge` and
 * then following a link to `/channels` would otherwise silently turn the bridge
 * off half way through a session. That failed quietly rather than loudly -
 * `requestPort` treats a dismissed picker as "the user changed their mind", so
 * the write button simply did nothing - which cost a while to track down.
 *
 * Scoped to the tab and cleared with `?bridge=off`.
 */
export function bridgeUrl(): string | null {
  if (!import.meta.dev) return null
  if (typeof window === 'undefined') return null

  const params = new URLSearchParams(window.location.search)
  if (params.has('bridge')) {
    const value = params.get('bridge')
    if (value === 'off') {
      sessionStorage.removeItem(BRIDGE_KEY)
      return null
    }
    const url = value || BRIDGE_DEFAULT_URL
    sessionStorage.setItem(BRIDGE_KEY, url)
    return url
  }
  return sessionStorage.getItem(BRIDGE_KEY)
}

export function bridgeEnabled(): boolean {
  return bridgeUrl() !== null
}

/**
 * Pick a port through the bridge.
 *
 * Chooses the single adapter when there is only one, which is the case that
 * matters for an iteration loop. With several attached it prefers one whose USB
 * vendor is a known serial bridge, and otherwise refuses to guess.
 */
export async function requestBridgePort(): Promise<PortChoice | null> {
  const url = bridgeUrl()
  if (!url) return null

  const ports = await listBridgePorts(url)
  if (ports.length === 0) throw new Error('The bridge sees no serial adapters. Is the cable plugged in?')

  let chosen = ports[0]!
  if (ports.length > 1) {
    const known = ports.filter((p) => p.vendorId !== null && p.vendorId in KNOWN_BRIDGE_VENDORS)
    if (known.length !== 1) {
      throw new Error(
        `The bridge sees ${ports.length} adapters and cannot choose between them: ` +
          `${ports.map((p) => p.path).join(', ')}.`,
      )
    }
    chosen = known[0]!
  }

  const port = new BridgeSerialPort(url, chosen)
  return {
    port,
    info: {
      ...(chosen.vendorId === null ? {} : { usbVendorId: chosen.vendorId }),
      ...(chosen.productId === null ? {} : { usbProductId: chosen.productId }),
      // A Bluetooth bridge has no USB identity to derive one from, so it says
      // what it is rather than letting `describeAdapter` call a radio over the
      // air "an unidentified serial port" - wrong, and read as a fault.
      ...(chosen.kind === 'bluetooth'
        ? { label: chosen.manufacturer ? `${chosen.manufacturer} over Bluetooth` : 'a radio over Bluetooth' }
        : {}),
    },
  }
}

/** Bridge if it is enabled, then the shell's cable, otherwise the real chooser. */
export async function acquirePort(): Promise<PortChoice | null> {
  if (bridgeEnabled()) return requestBridgePort()
  if (nativeSerial()) return (await import('~/mobile/serial')).requestNativePort()
  return requestPort()
}

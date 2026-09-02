// SPDX-License-Identifier: GPL-3.0-or-later
import { Capacitor, type PluginListenerHandle } from '@capacitor/core'
import { UsbSerial, type UsbSerialDevice } from '@boofwang/usb-serial'
import { NativeSerialPort, type NativeSerialLink, type NativeSerialOpenParams } from '#core/transport/native-serial-port.js'
import { KNOWN_BRIDGE_VENDORS } from '#core/transport/usb-bridges.js'
import { describeAdapter, type PortChoice } from '~/composables/useWebSerial'

/**
 * The only file in boofwang that touches the USB serial plugin.
 *
 * The counterpart of `useWebSerial` for the Android app: this file owns the
 * device list, the permission prompt and the bridge's base64, and hands the
 * rest of the app a `SerialPortLike` through `NativeSerialPort`. Bytes are
 * decoded here, so nothing under `lib/` ever sees a base64 string and the
 * fakes stay bytes-in, bytes-out.
 *
 * There is no chooser to draw. A phone has one OTG port and, almost always,
 * one adapter on it; with several, the one whose vendor is a known serial
 * bridge is taken, exactly as the dev bridge decides, and with several of
 * those the app refuses to guess.
 *
 * Nothing in this file has been run on a phone or against a radio. The port
 * it wraps has been proven equivalent to the browser's against fixtures; the
 * plugin and this glue have not been compiled.
 */

export function nativeSerialAvailable(): boolean {
  return Capacitor.isPluginAvailable('UsbSerial')
}

function toBase64(bytes: Uint8Array): string {
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  return btoa(s)
}

function fromBase64(text: string): Uint8Array {
  const s = atob(text)
  const out = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i)
  return out
}

function hex(n: number): string {
  return n.toString(16).padStart(4, '0')
}

/** A link over one attached adapter. Built before open, alive until close. */
function linkFor(device: UsbSerialDevice): NativeSerialLink {
  let handle: string | null = null
  const dataHandlers = new Set<(bytes: Uint8Array) => void>()
  const lostHandlers = new Set<(reason: string) => void>()
  const subscriptions: Promise<PluginListenerHandle>[] = []

  const lost = (reason: string) => {
    for (const cb of lostHandlers) cb(reason)
  }

  const info = { usbVendorId: device.vendorId, usbProductId: device.productId }

  return {
    info,
    label: describeAdapter(info),

    async open(params: NativeSerialOpenParams) {
      subscriptions.push(
        UsbSerial.addListener('data', (e) => {
          if (e.handle !== handle) return
          // A fresh array per event: the decoder's buffer is ours, but the
          // port copies again regardless, and two copies are cheaper than
          // one shared buffer that a later event overwrites.
          const bytes = fromBase64(e.data)
          for (const cb of dataHandlers) cb(bytes)
        }),
        UsbSerial.addListener('error', (e) => {
          if (e.handle === handle) lost(e.message)
        }),
        UsbSerial.addListener('detached', (e) => {
          if (e.deviceId === device.deviceId) lost('The adapter was unplugged.')
        }),
      )
      const opened = await UsbSerial.open({ deviceId: device.deviceId, ...params })
      handle = opened.handle
    },

    async write(data: Uint8Array) {
      if (handle === null) throw new Error('The port is not open.')
      await UsbSerial.write({ handle, data: toBase64(data) })
    },

    async setSignals(s) {
      if (handle === null) throw new Error('The port is not open.')
      await UsbSerial.setSignals({
        handle,
        ...(s.dataTerminalReady === undefined ? {} : { dtr: s.dataTerminalReady }),
        ...(s.requestToSend === undefined ? {} : { rts: s.requestToSend }),
      })
    },

    async close() {
      const h = handle
      handle = null
      for (const sub of subscriptions) void sub.then((s) => s.remove())
      subscriptions.length = 0
      if (h !== null) await UsbSerial.close({ handle: h })
    },

    onData(cb) {
      dataHandlers.add(cb)
      return () => dataHandlers.delete(cb)
    },

    onLost(cb) {
      lostHandlers.add(cb)
      return () => lostHandlers.delete(cb)
    },
  }
}

function choiceFor(device: UsbSerialDevice): PortChoice {
  const link = linkFor(device)
  return { port: new NativeSerialPort(link), info: link.info, label: link.label ?? describeAdapter(link.info) }
}

/**
 * The adapter on the OTG port, permission asked for if it has not been.
 *
 * Null when the person declined, like a dismissed chooser. Choosing boofwang
 * in the system dialogue on plug-in grants permission implicitly, which is
 * the one path that never prompts again.
 */
export async function requestNativePort(): Promise<PortChoice | null> {
  const { devices } = await UsbSerial.listDevices()
  if (devices.length === 0) {
    throw new Error('No USB serial adapter is attached. Plug the programming cable into the phone through an OTG adapter.')
  }

  let chosen = devices[0]!
  if (devices.length > 1) {
    const known = devices.filter((d) => d.vendorId in KNOWN_BRIDGE_VENDORS)
    if (known.length !== 1) {
      throw new Error(
        `${devices.length} USB serial adapters are attached and boofwang cannot choose between them: ` +
          devices.map((d) => `${hex(d.vendorId)}:${hex(d.productId)}`).join(', ') +
          '. Unplug all but the programming cable.',
      )
    }
    chosen = known[0]!
  }

  if (!chosen.hasPermission) {
    const { granted } = await UsbSerial.requestPermission({ deviceId: chosen.deviceId })
    if (!granted) return null
  }
  return choiceFor(chosen)
}

/** Adapters already granted, so a return visit can reconnect without a prompt. */
export async function grantedNativePorts(): Promise<PortChoice[]> {
  const { devices } = await UsbSerial.listDevices()
  return devices.filter((d) => d.hasPermission).map(choiceFor)
}

/** Fires when any adapter is unplugged. */
export function onNativeDetached(cb: () => void): () => void {
  const sub = UsbSerial.addListener('detached', () => cb())
  return () => void sub.then((s) => s.remove())
}

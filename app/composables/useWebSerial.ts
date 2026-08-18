// SPDX-License-Identifier: GPL-3.0-or-later
import type { SerialPortLike } from '#core/transport/transport.js'

/**
 * The only place in boofwang that touches `navigator.serial`.
 *
 * Everything below the UI depends on `SerialPortLike`, a structural interface,
 * which is what lets the whole driver stack run in Node against a scripted fake.
 */

export interface PortChoice {
  port: SerialPortLike
  info: { usbVendorId?: number; usbProductId?: number }
}

export function serialAvailable(): boolean {
  return typeof navigator !== 'undefined' && 'serial' in navigator
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
  if (!serialAvailable()) return []
  const ports = await navigator.serial.getPorts()
  return ports.map((p) => ({ port: p as unknown as SerialPortLike, info: p.getInfo?.() ?? {} }))
}

/** Fires when a granted device is physically unplugged. */
export function onSerialDisconnect(cb: (port: SerialPortLike) => void): () => void {
  if (!serialAvailable()) return () => {}
  const handler = (ev: Event) => cb((ev.target ?? (ev as unknown as { port: unknown }).port) as SerialPortLike)
  navigator.serial.addEventListener('disconnect', handler)
  return () => navigator.serial.removeEventListener('disconnect', handler)
}

/**
 * Hand the user a file.
 *
 * `showSaveFilePicker` is Chromium-only, and Firefox 151 can drive a radio but
 * cannot use it - so the download fallback is the normal path for a real share
 * of users, not an edge case.
 */
export async function saveFile(data: Uint8Array | string, filename: string, mime: string): Promise<boolean> {
  const blob = new Blob([data as BlobPart], { type: mime })

  const picker = (window as unknown as { showSaveFilePicker?: unknown }).showSaveFilePicker
  if (typeof picker === 'function') {
    try {
      const handle = await (picker as (o: unknown) => Promise<FileSystemFileHandle>)({
        suggestedName: filename,
        types: [{ description: 'boofwang codeplug', accept: { [mime]: [`.${filename.split('.').pop()}`] } }],
      })
      const writable = await handle.createWritable()
      await writable.write(blob)
      await writable.close()
      return true
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') return false
      // Anything else: fall through to the download below rather than failing.
    }
  }

  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
  return true
}

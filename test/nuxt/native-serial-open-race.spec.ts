// SPDX-License-Identifier: GPL-3.0-or-later
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * What the Android app does with bytes that arrive before it has a handle.
 *
 * `app/mobile/serial.ts` subscribes before it opens, deliberately: the comment
 * in `native-serial-port.ts` says a plugin may deliver a byte the moment the
 * port comes up and a subscription taken afterwards would lose it silently.
 * The subscription alone is not enough, because every event carries the
 * handle the plugin assigned and the handle does not reach this side until
 * `open` resolves. The Java starts its reader thread before it resolves the
 * call, so an adapter holding bytes in its FIFO can emit into that window,
 * and the filter that compares against a null handle drops them.
 *
 * It reads as a radio that did not answer, which is also the recorded tell for
 * the DTR-and-RTS-at-open unknown in docs/mobile.md. That is what makes it
 * worth a test rather than a comment: the two failures are indistinguishable
 * on a bench, and only one of them is the radio's fault.
 *
 * The plugin is faked here down to its ordering. Nothing in this spec has
 * touched a phone.
 */

/** Emits `data` between the open call and the promise that resolves it. */
const plugin = {
  listeners: new Map<string, ((e: never) => void)[]>(),
  /** Set by a test: what the fake plugin says the moment the port opens. */
  onOpen: null as null | ((emit: (event: string, payload: unknown) => void) => void),

  emit(event: string, payload: unknown) {
    for (const cb of plugin.listeners.get(event) ?? []) (cb as (e: unknown) => void)(payload)
  },

  addListener(event: string, cb: (e: never) => void) {
    // Registration crosses the bridge, so it does not complete in the same
    // microtask the caller made it in, and it is made slower than open below.
    // Two bridge calls in flight together have no guaranteed order, and a fake
    // that always finished this one first would pass whether or not the caller
    // waited for it.
    return new Promise((resolve) => {
      setTimeout(() => {
        const list = plugin.listeners.get(event) ?? []
        list.push(cb)
        plugin.listeners.set(event, list)
        resolve({ remove: () => void 0 })
      }, 5)
    })
  },

  listDevices: () => Promise.resolve({ devices: [] }),
  requestPermission: () => Promise.resolve({ granted: true }),

  open() {
    // The reader thread starts inside the native open and the call resolves
    // afterwards. Anything said here carries a handle the caller has not been
    // given yet.
    return new Promise((resolve) => {
      setTimeout(() => {
        plugin.onOpen?.(plugin.emit)
        resolve({ handle: '1' })
      }, 0)
    })
  },

  write: () => Promise.resolve(),
  setSignals: () => Promise.resolve(),
  close: () => Promise.resolve(),
  removeAllListeners: () => Promise.resolve(),
}

vi.mock('@capacitor/core', () => ({
  Capacitor: { isPluginAvailable: () => true },
}))

vi.mock('@boofwang/usb-serial', () => ({
  UsbSerial: {
    listDevices: () => plugin.listDevices(),
    requestPermission: () => plugin.requestPermission(),
    open: () => plugin.open(),
    write: () => plugin.write(),
    setSignals: () => plugin.setSignals(),
    close: () => plugin.close(),
    addListener: (event: string, cb: (e: never) => void) => plugin.addListener(event, cb),
    removeAllListeners: () => plugin.removeAllListeners(),
  },
}))

const device = { deviceId: 7, vendorId: 0x1a86, productId: 0x7523, driver: 'Ch34x', hasPermission: true }

/**
 * The link is not exported, so it is reached the way the app reaches it: the
 * port `grantedNativePorts` hands back wraps exactly one.
 */
async function openedPort() {
  plugin.listDevices = () => Promise.resolve({ devices: [device] as never })
  const { grantedNativePorts } = await import('~/mobile/serial')
  const [choice] = await grantedNativePorts()
  return choice!.port
}

describe('the Android app opening a port', () => {
  beforeEach(() => {
    vi.resetModules()
    plugin.listeners = new Map()
    plugin.onOpen = null
  })

  it('keeps bytes the radio sent before the handle came back', async () => {
    // 0x06, the acknowledgement every one of these radios answers with.
    plugin.onOpen = (emit) => emit('data', { handle: '1', data: 'Bg==' })

    const port = await openedPort()
    await port.open({ baudRate: 9600 })

    const reader = port.readable!.getReader()
    const { value } = await reader.read()
    expect(Array.from(value!)).toEqual([0x06])
  })

  it('does not deliver bytes belonging to another handle', async () => {
    plugin.onOpen = (emit) => emit('data', { handle: '99', data: 'Bg==' })

    const port = await openedPort()
    await port.open({ baudRate: 9600 })

    const reader = port.readable!.getReader()
    const race = await Promise.race([
      reader.read().then(() => 'delivered'),
      new Promise((r) => setTimeout(() => r('nothing'), 20)),
    ])
    expect(race).toBe('nothing')
  })

  it('registers its listeners before the plugin opens the device', async () => {
    let registeredAtOpen = 0
    plugin.onOpen = () => {
      registeredAtOpen = (plugin.listeners.get('data') ?? []).length
    }

    const port = await openedPort()
    await port.open({ baudRate: 9600 })

    expect(registeredAtOpen).toBe(1)
  })
})

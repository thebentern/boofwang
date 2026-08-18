// SPDX-License-Identifier: GPL-3.0-or-later
import { defineStore } from 'pinia'
import { SerialTransport } from '#core/transport/serial-transport.js'
import { RecordingTransport } from '#core/transport/recording-transport.js'
import type { IdentifyResult, RadioDriver } from '#core/radio/driver.js'
import type { RadioId } from '#core/model/codeplug.js'
import { createDriver } from '#core/radio/registry.js'
import type { SerialPortLike } from '#core/transport/transport.js'

export type ConnState = 'idle' | 'requesting' | 'opening' | 'identifying' | 'connected' | 'error' | 'lost'

/**
 * The live connection to a radio.
 *
 * The port, transport and driver are `markRaw`: they hold streams, timers and
 * (for an image) hundreds of kilobytes of `Uint8Array`. Making a typed array
 * reactive creates a dependency entry per byte, which is enough to lock up the
 * tab on its own.
 */
export const useDeviceStore = defineStore('device', () => {
  const state = ref<ConnState>('idle')
  const error = ref<string | null>(null)
  const ident = ref<IdentifyResult | null>(null)
  const radioId = ref<RadioId | null>(null)
  const portLabel = ref<string>('')

  let port: SerialPortLike | null = null
  let transport: RecordingTransport | null = null
  let driver: RadioDriver | null = null
  let offDisconnect: (() => void) | null = null

  const connected = computed(() => state.value === 'connected')

  function currentDriver(): RadioDriver {
    if (!driver) throw new Error('No radio is connected')
    return driver
  }

  function currentTransport(): RecordingTransport {
    if (!transport) throw new Error('No radio is connected')
    return transport
  }

  async function connect(chosen: SerialPortLike, id: RadioId, info: { usbVendorId?: number; usbProductId?: number }) {
    error.value = null
    try {
      state.value = 'opening'
      port = chosen
      driver = createDriver(id)
      radioId.value = id
      portLabel.value =
        info.usbVendorId !== undefined
          ? `USB ${info.usbVendorId.toString(16).padStart(4, '0')}:${(info.usbProductId ?? 0).toString(16).padStart(4, '0')}`
          : 'Serial port'

      // Every session is recorded. A trace from a radio that would not connect
      // is the single most useful thing a bug report can carry, and it costs
      // nothing to keep.
      const inner = new SerialTransport(chosen)
      transport = new RecordingTransport(inner, `${id}-session`)
      await transport.open(driver.serial)

      offDisconnect = inner.onDisconnect(() => {
        state.value = 'lost'
        error.value = 'The radio was disconnected.'
      })

      state.value = 'identifying'
      ident.value = await driver.identify(transport)
      state.value = 'connected'
      return ident.value
    } catch (e) {
      state.value = 'error'
      error.value = e instanceof Error ? e.message : String(e)
      await disconnect()
      throw e
    }
  }

  async function disconnect() {
    offDisconnect?.()
    offDisconnect = null
    try {
      await transport?.close()
    } catch {
      /* already gone */
    }
    transport = null
    port = null
    driver = null
    if (state.value !== 'error' && state.value !== 'lost') state.value = 'idle'
    ident.value = null
  }

  /** The recorded protocol trace, for a bug report. */
  function traceJson(): string | null {
    return transport ? transport.toJSON() : null
  }

  return {
    state,
    error,
    ident,
    radioId,
    portLabel,
    connected,
    connect,
    disconnect,
    currentDriver,
    currentTransport,
    traceJson,
    hasPort: () => port !== null,
  }
})

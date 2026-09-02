// SPDX-License-Identifier: GPL-3.0-or-later
import type { PluginListenerHandle } from '@capacitor/core'

/**
 * The Android app's cable.
 *
 * A thin plugin over usb-serial-for-android, shaped to what
 * `lib/transport/native-serial-port.ts` wants and nothing more. Bytes cross
 * the bridge as base64 in both directions; `app/mobile/serial.ts` is the only
 * caller and decodes before anything under `lib/` sees them.
 *
 * Android only. On the web and on iOS `Capacitor.isPluginAvailable('UsbSerial')`
 * is false and the app never calls it.
 */

export interface UsbSerialDevice {
  /** Android's id for the attached device. Changes on re-plug. */
  deviceId: number
  vendorId: number
  productId: number
  productName?: string
  manufacturerName?: string
  /** Which of the library's drivers claimed it: Ch34x, Cp21xx, Ftdi, Prolific. */
  driver: string
  hasPermission: boolean
}

export interface UsbSerialOpenOptions {
  deviceId: number
  baudRate: number
  dataBits: 7 | 8
  stopBits: 1 | 2
  parity: 'none' | 'even' | 'odd'
  /**
   * The modem lines, set the instant the port opens and before the line
   * parameters. Every radio boofwang knows is reset by an asserted DTR or
   * RTS, so a driver that cannot control them fails the open rather than
   * opening with the lines wherever the chip left them.
   */
  dtr: boolean
  rts: boolean
}

export interface UsbSerialPlugin {
  listDevices(): Promise<{ devices: UsbSerialDevice[] }>
  requestPermission(options: { deviceId: number }): Promise<{ granted: boolean }>
  open(options: UsbSerialOpenOptions): Promise<{ handle: string }>
  /** `data` is base64. */
  write(options: { handle: string; data: string }): Promise<void>
  setSignals(options: { handle: string; dtr?: boolean; rts?: boolean }): Promise<void>
  close(options: { handle: string }): Promise<void>
  addListener(event: 'data', listener: (e: { handle: string; data: string }) => void): Promise<PluginListenerHandle>
  addListener(event: 'error', listener: (e: { handle: string; message: string }) => void): Promise<PluginListenerHandle>
  addListener(event: 'detached', listener: (e: { deviceId: number }) => void): Promise<PluginListenerHandle>
  addListener(event: 'attached', listener: (e: UsbSerialDevice) => void): Promise<PluginListenerHandle>
  removeAllListeners(): Promise<void>
}

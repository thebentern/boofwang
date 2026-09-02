// SPDX-License-Identifier: GPL-3.0-or-later
import type { BluetoothProbe } from './bluetooth-support.js'

/**
 * The shape both shells inject as `window.boofwang`.
 *
 * `detectHost` reads only the two flags, and reads them structurally, so this
 * type is documentation for the shells rather than a contract the page relies
 * on: every method is optional because a bridge that is missing one has to be
 * treated as a bridge that cannot do it, not as a crash. The Electron preload
 * (`electron/preload.cjs`) sets `desktop` and `fetchJson`, plus two serial
 * picker methods of its own that are not part of this shape. The mobile plugin
 * sets `mobile` and whichever of the rest it implements.
 *
 * Neither shell writes the other's flag, which is what lets `detectHost` order
 * them without ambiguity.
 */
export interface ShellBridge {
  /** Written by the Electron preload, and by nothing else. */
  readonly desktop?: true
  /** Written by the Capacitor plugin, and by nothing else. */
  readonly mobile?: 'android' | 'ios'
  /** Fetch a JSON document from anywhere, outside the renderer. https only. */
  fetchJson?(url: string): Promise<unknown>
  /**
   * Hand a file to the OS - a share sheet on a phone, a save dialog on a
   * desktop. Resolves false when the person dismissed it without saving.
   */
  saveFile?(data: Uint8Array | string, filename: string, mime: string): Promise<boolean>
  /**
   * Hold the screen on. A transfer to a radio takes long enough for a phone
   * to lock, and a locked WebView is a suspended one, mid-write.
   */
  keepAwake?(on: boolean): Promise<void>
  /**
   * What the OS says about Bluetooth, for the mobile shell only.
   *
   * There is no `navigator.bluetooth` in a WebView to ask, so the adapter and
   * permission state the support gate needs arrive through here instead. The
   * answer is fed straight into `evaluateBluetoothSupport`, which is why the
   * shape is a slice of its probe rather than a type of its own.
   */
  bluetoothProbe?(): Promise<Pick<BluetoothProbe, 'adapterAvailable' | 'permission'>>
}

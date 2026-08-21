// SPDX-License-Identifier: GPL-3.0-or-later
import { evaluateBluetoothSupport, type BluetoothSupport } from '#core/platform/bluetooth-support.js'

export type { BluetoothBlocker, BluetoothSupport } from '#core/platform/bluetooth-support.js'

const UNKNOWN: BluetoothSupport = {
  supported: false,
  blocker: 'unsupported-browser',
  secureContext: false,
  browser: 'your browser',
  anotherBrowserWouldHelp: false,
  advice: '',
}

/**
 * Reactive wrapper around the pure check in `#core/platform/bluetooth-support`.
 *
 * Evaluated in `onMounted` rather than at setup, for the same reason as
 * `useSerialSupport`: the build prerenders the shell and `navigator` does not
 * exist there.
 *
 * The adapter question is asked separately and settles later. `getAvailability`
 * is a promise and a slow one on some machines, so the first answer is the one
 * that ignores it - a browser that can never do this should be told so
 * immediately rather than after a Bluetooth stack has finished waking up.
 */
export function useBluetoothSupport() {
  const support = ref<BluetoothSupport>(UNKNOWN)

  onMounted(async () => {
    const probe = { maxTouchPoints: navigator.maxTouchPoints ?? 0 }
    support.value = evaluateBluetoothSupport(navigator, window.isSecureContext, probe)

    const bluetooth = navigator.bluetooth as { getAvailability?: () => Promise<boolean> } | undefined
    if (!bluetooth?.getAvailability) return
    try {
      const adapterAvailable = await bluetooth.getAvailability()
      support.value = evaluateBluetoothSupport(navigator, window.isSecureContext, { ...probe, adapterAvailable })
    } catch {
      // A browser that has the method and throws from it has told us nothing,
      // and refusing to connect on that basis would block a working machine.
    }
  })

  return support
}

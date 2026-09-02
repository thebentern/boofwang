// SPDX-License-Identifier: GPL-3.0-or-later
import { evaluateBluetoothSupport, type BluetoothSupport } from '#core/platform/bluetooth-support.js'
import { shellProvidesTransports } from '#core/platform/host.js'

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
 *
 * Inside the mobile shell there is no `navigator.bluetooth` to ask. The shell
 * supplies the adapter and permission state through its bridge instead, and
 * until it has, the answer is "supported": the plugin is there by
 * construction, and a switched-off adapter is reported the moment the bridge
 * says so.
 */
export function useBluetoothSupport() {
  const support = ref<BluetoothSupport>(UNKNOWN)

  onMounted(async () => {
    const { host, bridge } = useShell()
    const probe = { maxTouchPoints: navigator.maxTouchPoints ?? 0 }
    support.value = evaluateBluetoothSupport(navigator, window.isSecureContext, probe, host)

    if (shellProvidesTransports(host)) {
      if (!bridge?.bluetoothProbe) return
      try {
        const native = await bridge.bluetoothProbe()
        support.value = evaluateBluetoothSupport(navigator, true, { ...probe, ...native }, host)
      } catch {
        // The bridge could not say. Leaving the optimistic answer standing is
        // the same call the browser path makes below.
      }
      return
    }

    const bluetooth = navigator.bluetooth as { getAvailability?: () => Promise<boolean> } | undefined
    if (!bluetooth?.getAvailability) return
    try {
      const adapterAvailable = await bluetooth.getAvailability()
      support.value = evaluateBluetoothSupport(navigator, window.isSecureContext, { ...probe, adapterAvailable }, host)
    } catch {
      // A browser that has the method and throws from it has told us nothing,
      // and refusing to connect on that basis would block a working machine.
    }
  })

  return support
}

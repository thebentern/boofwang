// SPDX-License-Identifier: GPL-3.0-or-later
import { evaluateSerialSupport, type SerialSupport } from '#core/platform/serial-support.js'

export type { SerialBlocker, SerialSupport } from '#core/platform/serial-support.js'

const UNKNOWN: SerialSupport = {
  supported: false,
  blocker: 'unsupported-browser',
  secureContext: false,
  browser: 'your browser',
  advice: '',
}

/**
 * Reactive wrapper around the pure check in `#core/platform/serial-support`.
 *
 * Evaluated in `onMounted` rather than at setup: this is a client-only app, but
 * the build still prerenders the shell, and `navigator` does not exist there.
 */
export function useSerialSupport() {
  const support = ref<SerialSupport>(UNKNOWN)
  onMounted(() => {
    support.value = evaluateSerialSupport(navigator, window.isSecureContext)
  })
  return support
}

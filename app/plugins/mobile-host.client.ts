// SPDX-License-Identifier: GPL-3.0-or-later
import { readBuildInfo } from '#core/version/build.js'

/**
 * Announce the mobile shell to the page, when there is one.
 *
 * Runs before any page mounts and imports nothing unless the Capacitor
 * runtime has already injected itself - which it does, on the native
 * platforms only, before the first script runs. A browser tab and the desktop
 * build take the early return and never fetch `app/mobile/`.
 *
 * Sequential rather than parallel on purpose: `useShell` is read from the
 * layout's `onMounted`, and the bridge has to be on `window.boofwang` by then
 * or the page decides it is a browser and never changes its mind.
 */
export default defineNuxtPlugin(async () => {
  const cap = (window as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor
  if (cap?.isNativePlatform?.() !== true) return

  const mobile = await import('~/mobile/bridge')
  const bridge = mobile.installMobileBridge(readBuildInfo(useRuntimeConfig().public.build))
  if (!bridge) return

  const colorMode = useColorMode()
  watch(
    () => colorMode.value,
    (mode) => void mobile.applyStatusBar(mode === 'dark'),
    { immediate: true },
  )

  /*
   * Transfer guarding. The store stays host-agnostic; this is the one place
   * that knows an app can be backgrounded. While a transfer runs the screen
   * stays on and the back button is held. When the app goes to the background
   * anyway, the transfer is NOT cancelled - a cancel poisons the transport,
   * and a notification shade pulled down on Android may not have cost
   * anything - but it is marked interrupted, so a failure that follows is
   * blamed on the interruption rather than on the radio.
   */
  const transfer = useTransferStore()
  let releaseBack: (() => void) | null = null
  watch(
    () => transfer.active,
    (active) => {
      void bridge.keepAwake?.(active)
      if (active && !releaseBack) releaseBack = mobile.holdBackButton()
      if (!active && releaseBack) {
        releaseBack()
        releaseBack = null
      }
    },
    { immediate: true },
  )
  mobile.onAppStateChange((isActive) => {
    if (!isActive && transfer.active) transfer.markInterrupted()
  })
})

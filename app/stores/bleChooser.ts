// SPDX-License-Identifier: GPL-3.0-or-later
import { defineStore } from 'pinia'
import { matchesProfiles, type ScanAdvertisement } from '#core/transport/bluetooth-scan-filter.js'
import type { BluetoothProfile } from '#core/transport/bluetooth-uuids.js'

/**
 * The Bluetooth device list a native app has to draw for itself.
 *
 * In a browser `requestDevice` opens a chooser the page cannot see into. The
 * mobile shell has no such dialogue: scan results arrive as events and the
 * page shows them. This store is the list; `BluetoothScanList.vue` is its
 * rendering; `app/mobile/bluetooth.ts` drives the scan and waits on `begin`
 * for the row the person taps.
 *
 * Rows that match the candidate profiles are shown by default, sorted by
 * signal so the radio in hand is usually first. "Show every device" reveals
 * the rest, for a radio advertising neither its service nor a name - the same
 * hatch the browser's `everyDevice` opens.
 */

export interface ScanRow {
  readonly deviceId: string
  readonly name: string | undefined
  readonly rssi: number | undefined
  readonly matched: boolean
}

export interface Picked {
  readonly deviceId: string
  readonly name: string | undefined
}

export interface ScanDriver {
  start(onResult: (ad: ScanAdvertisement & { deviceId: string; rssi?: number }) => void): Promise<void>
  stop(): Promise<void>
}

export const useBleChooserStore = defineStore('bleChooser', () => {
  const open = ref(false)
  const scanning = ref(false)
  const everyDevice = ref(false)
  const results = ref<ScanRow[]>([])
  const candidates = ref<readonly BluetoothProfile[]>([])
  const error = ref<string | null>(null)

  let resolver: ((picked: Picked | null) => void) | null = null
  let driver: ScanDriver | null = null

  const visible = computed(() =>
    results.value
      .filter((r) => everyDevice.value || r.matched)
      .slice()
      .sort((a, b) => (b.rssi ?? -999) - (a.rssi ?? -999)),
  )
  const hidden = computed(() => results.value.length - results.value.filter((r) => r.matched).length)

  /**
   * Open the list and scan until a row is picked or the list is dismissed.
   *
   * One scan per opening. Android rate-limits scan starts to five per thirty
   * seconds and the person toggling "show every device" must not spend them.
   */
  function begin(profiles: readonly BluetoothProfile[], showAll: boolean, scan: ScanDriver): Promise<Picked | null> {
    if (resolver) resolver(null)
    candidates.value = profiles
    everyDevice.value = showAll
    results.value = []
    error.value = null
    open.value = true
    scanning.value = true
    driver = scan
    scan
      .start((ad) => report(ad))
      .catch((e: unknown) => {
        scanning.value = false
        error.value = e instanceof Error ? e.message : String(e)
      })
    return new Promise((resolve) => {
      resolver = resolve
    })
  }

  function report(ad: ScanAdvertisement & { deviceId: string; rssi?: number }) {
    const matched = matchesProfiles(ad, candidates.value)
    const name = ad.name ?? ad.localName ?? undefined
    const row: ScanRow = { deviceId: ad.deviceId, name, rssi: ad.rssi, matched }
    const at = results.value.findIndex((r) => r.deviceId === ad.deviceId)
    if (at === -1) results.value = [...results.value, row]
    else results.value = results.value.map((r, i) => (i === at ? { ...row, name: row.name ?? r.name } : r))
  }

  /** The advanced field changed the profile; re-match what has been seen. */
  function rematch(profiles: readonly BluetoothProfile[]) {
    candidates.value = profiles
    results.value = results.value.map((r) => r)
  }

  async function finish(picked: Picked | null) {
    const resolve = resolver
    resolver = null
    open.value = false
    scanning.value = false
    try {
      await driver?.stop()
    } catch {
      // A scan that has already stopped is not a fault.
    }
    driver = null
    resolve?.(picked)
  }

  function pick(deviceId: string) {
    const row = results.value.find((r) => r.deviceId === deviceId)
    if (!row) return
    void finish({ deviceId: row.deviceId, name: row.name })
  }

  function dismiss() {
    void finish(null)
  }

  return { open, scanning, everyDevice, results, visible, hidden, error, candidates, begin, report, rematch, pick, dismiss }
})

// SPDX-License-Identifier: GPL-3.0-or-later
import { BleClient, type ScanResult } from '@capacitor-community/bluetooth-le'
import type { BluetoothProbe } from '#core/platform/bluetooth-support.js'
import { BluetoothPort } from '#core/transport/bluetooth-port.js'
import { connectNativeGattLink, type NativeGattLink } from '#core/transport/native-gatt.js'
import type { BluetoothProfile } from '#core/transport/bluetooth-uuids.js'
import { describeBluetoothDevice, resolveBluetoothProfile } from '~/composables/useWebBluetooth'
import type { PortChoice } from '~/composables/useWebSerial'

/**
 * The only file in boofwang that touches the native Bluetooth plugin.
 *
 * The counterpart of `useWebBluetooth` for the mobile shell, and the same
 * division of labour: this file owns the scan, the pick and the GATT link,
 * and hands the rest of the app a `SerialPortLike`. `connectNativeGattLink`
 * turns the plugin into the `BluetoothLink` the existing `BluetoothPort`
 * consumes, so the port that read a UV-5R Mini in Chrome is the one the phone
 * uses. Nothing below the port knows which it is on.
 *
 * What a native app lacks is the browser's chooser. `requestDevice` is a
 * dialogue the page cannot see into; here the scan results come to the page
 * and the page shows them, which is `app/stores/bleChooser.ts` and
 * `BluetoothScanList.vue`. The scan runs with no native filter and the rows
 * are matched in JavaScript, for the reasons set out in
 * lib/transport/bluetooth-scan-filter.ts.
 *
 * Nothing in this file has yet been run against a radio from a phone. The
 * profiles and the port have; the plugin and this glue have not.
 */

/**
 * The plugin is initialised once. On Android this is also where the runtime
 * permission dialogue appears, and the flag has to agree with the manifest's
 * `neverForLocation` on BLUETOOTH_SCAN - test/app/mobile-config.spec.ts holds
 * the two together, because when they disagree the scan silently lists
 * nothing.
 */
let initialised: Promise<void> | null = null
function initialise(): Promise<void> {
  initialised ??= BleClient.initialize({ androidNeverForLocation: true }).catch((e: unknown) => {
    initialised = null
    throw e
  })
  return initialised
}

/** What the support card needs to know: is there an adapter, and may we use it. */
export async function nativeBluetoothProbe(): Promise<Pick<BluetoothProbe, 'adapterAvailable' | 'permission'>> {
  try {
    await initialise()
  } catch {
    // The plugin refuses to initialise when the permission was denied, and
    // that is the only way it says so.
    return { permission: 'denied', adapterAvailable: null }
  }
  try {
    return { permission: 'granted', adapterAvailable: await BleClient.isEnabled() }
  } catch {
    return { permission: 'granted', adapterAvailable: null }
  }
}

/**
 * The last radio the user picked, kept so a write does not ask again.
 *
 * The same reason as the browser's `granted`: reading closes the port and drops
 * the link, and by the time a channel has been edited there is nothing live to
 * write through. `deviceId` is a MAC on Android and a per-app UUID on iOS;
 * neither is persisted, matching `lastKind`. The link is kept for its `closed`
 * promise, which the reconnect must await.
 */
let granted: { deviceId: string; name: string | undefined; profile: BluetoothProfile; link: NativeGattLink } | null =
  null

export function forgetNativeBluetoothGrant(): void {
  granted = null
}

/** The candidate profiles, resolved the same way the browser path resolves them. */
function candidatesFor(opts: { profiles?: readonly BluetoothProfile[]; withDefault?: boolean }) {
  const resolved = resolveBluetoothProfile()
  const candidates = resolved.overridden
    ? [resolved.profile]
    : opts.profiles
      ? opts.withDefault
        ? [resolved.profile, ...opts.profiles]
        : opts.profiles
      : [resolved.profile]
  return { resolved, candidates }
}

async function linkTo(
  device: { deviceId: string; name?: string | undefined },
  candidates: readonly BluetoothProfile[],
): Promise<{ choice: PortChoice; link: NativeGattLink }> {
  // 247 is the MTU Android negotiates when asked; the adapter reads back what
  // it actually got and sizes writes from that. iOS ignores the request and
  // keeps the 20-byte default until a device has been measured.
  const { link, maxWriteBytes } = await connectNativeGattLink(BleClient, device, candidates, { requestMtu: 247 })
  const port = new BluetoothPort(link, {
    radioLink: link.profile.radioLink ?? 'bluetooth',
    ...(maxWriteBytes === undefined ? {} : { maxWriteBytes }),
  })
  return {
    choice: { port, info: {}, label: describeBluetoothDevice(device.name, link.profile) },
    link,
  }
}

/**
 * Scan, let the person pick, connect, and wrap it as a port.
 *
 * Null when the list was dismissed, exactly as the browser path returns null
 * for a dismissed chooser, so the connect page needs no second code path. The
 * scan starts once per opening: Android allows five starts per thirty
 * seconds, and "show every device" only changes which rows are displayed.
 */
export async function requestNativeBluetoothRadio(
  opts: { everyDevice?: boolean; profiles?: readonly BluetoothProfile[]; withDefault?: boolean } = {},
): Promise<PortChoice | null> {
  await initialise()
  const { resolved, candidates } = candidatesFor(opts)

  const chooser = useBleChooserStore()
  const picked = await chooser.begin(candidates, resolved.scan || opts.everyDevice === true, {
    start: (onResult) =>
      BleClient.requestLEScan({ allowDuplicates: true }, (r: ScanResult) => onResult(toAdvertisement(r))),
    stop: () => BleClient.stopLEScan(),
  })
  if (!picked) return null

  // Re-resolved after the pick: the list's advanced field may have set an
  // override while it was open, and an override always wins.
  const after = candidatesFor(opts)
  const { choice, link } = await linkTo(picked, after.candidates)
  // Granted only once the link has proved a service is there, for the same
  // reason as the browser path: a non-radio picked in the list must not be
  // the thing every later write reconnects to.
  granted = { deviceId: picked.deviceId, name: picked.name, profile: link.profile, link }
  return choice
}

function toAdvertisement(r: ScanResult) {
  return {
    deviceId: r.device.deviceId,
    ...(r.device.name === undefined ? {} : { name: r.device.name }),
    ...(r.localName === undefined ? {} : { localName: r.localName }),
    uuids: [...(r.uuids ?? []), ...(r.device.uuids ?? [])],
    ...(r.rssi === undefined ? {} : { rssi: r.rssi }),
  }
}

/**
 * Reconnect the radio already picked this session, if there is one.
 *
 * `connect` on a deviceId this process has already discovered needs no scan
 * on either platform. The previous disconnect is awaited first: a write that
 * follows a read would otherwise race it on iOS. On rejection the caller
 * falls through to the list, as the browser path falls through to the
 * chooser.
 */
export async function reconnectNativeBluetoothRadio(): Promise<PortChoice | null> {
  if (!granted) return null
  await initialise()
  const resolved = resolveBluetoothProfile()
  const candidates = resolved.overridden ? [resolved.profile] : [granted.profile]
  await granted.link.closed
  const { choice, link } = await linkTo({ deviceId: granted.deviceId, name: granted.name }, candidates)
  granted = { ...granted, link }
  return choice
}

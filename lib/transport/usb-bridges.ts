// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Well-known USB-serial bridges, by vendor id.
 *
 * Named so an error can say "Prolific PL2303" rather than "067b:2303". Worth
 * the table: counterfeit PL2303 chips in particular cause a disproportionate
 * share of programming-cable failures, and recognising one by name is the
 * difference between a user replacing a cable and a user filing a bug.
 *
 * These are the four chips a programming cable is realistically built around,
 * and every one of them is also in countless unrelated devices - so a match
 * only orders a port picker, and the handshake is what identifies a radio.
 *
 * Lifted into one place because it used to be four identical arrays in the
 * drivers and a fifth copy in the serial composable, and because the Android
 * app's USB device filter is generated from and tested against this table: a
 * vendor added here and nowhere else would still be offered by the phone.
 */
export const KNOWN_BRIDGE_VENDORS: Readonly<Record<number, string>> = {
  0x1a86: 'QinHeng CH340',
  0x067b: 'Prolific PL2303',
  0x10c4: 'Silicon Labs CP210x',
  0x0403: 'FTDI',
}

export function isKnownBridgeVendor(vid: number | undefined): boolean {
  return vid !== undefined && vid in KNOWN_BRIDGE_VENDORS
}

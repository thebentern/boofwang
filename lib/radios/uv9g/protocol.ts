// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The Baofeng UV-9G: the UV-9R's waterproof GMRS sibling, behind its own magic.
 *
 * Everything on the wire is the uv9r module's - CHIRP's `UV9G` is a subclass
 * of `WP970I` in `baofeng_wp970i.py` (GPL-3.0) that changes the magic, the name
 * length and the power table and nothing else - so this file holds the two
 * facts that are this radio's own and nothing more.
 */

/**
 * `MSTRING_UV9G`.
 *
 * One byte from the UV-5G's `50 BB FF 20 12 06 25` and one from the UV-5R's
 * `50 BB FF 20 12 07 25` - the sixth is 0x05 here, 0x06 and 0x07 there. A
 * radio answering one of those is not this one, and the connect screen's
 * choice is what picks which magic is sent: boofwang does not probe for the
 * others. No other class in CHIRP's vendored drivers sends this one.
 */
export const MAGIC_UV9G = Uint8Array.from([0x50, 0xbb, 0xff, 0x20, 0x12, 0x05, 0x25])

/**
 * `aa 44 46 04 00 04 70 dd`: the ident CHIRP's UV-9G test image carries.
 *
 * Byte for byte what the Radioddity UV-5G on boofwang's bench sends, which is
 * why it is evidence about hardware generation rather than about the model.
 */
export const IDENT_UV9G = Uint8Array.from([0xaa, 0x44, 0x46, 0x04, 0x00, 0x04, 0x70, 0xdd])

// SPDX-License-Identifier: GPL-3.0-or-later
import { registerPlugin } from '@capacitor/core'
import type { UsbSerialPlugin } from './definitions'

export * from './definitions'

/** No web implementation, deliberately: there is nothing a browser could do here. */
export const UsbSerial = registerPlugin<UsbSerialPlugin>('UsbSerial')

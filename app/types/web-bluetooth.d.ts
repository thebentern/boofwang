// SPDX-License-Identifier: GPL-3.0-or-later

// Web Bluetooth is not in lib.dom.d.ts either, so its types come from
// DefinitelyTyped alongside Web Serial's. Referenced here rather than added to
// the tsconfig `types` array so it applies to the app without disturbing Nuxt's
// generated config - and, more to the point, without reaching `lib/`, which
// compiles with no DOM types at all and declares its own structural subset of
// the GATT objects in `lib/transport/bluetooth-port.ts`.
/// <reference types="web-bluetooth" />

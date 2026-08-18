// SPDX-License-Identifier: GPL-3.0-or-later

// The Web Serial API is not in lib.dom.d.ts, so its types come from
// DefinitelyTyped. Referenced here rather than added to the tsconfig `types`
// array so it applies to the app without disturbing Nuxt's generated config.
/// <reference types="w3c-web-serial" />

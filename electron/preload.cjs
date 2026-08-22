// SPDX-License-Identifier: GPL-3.0-or-later
const { contextBridge, ipcRenderer } = require('electron')

/**
 * What the page is allowed to see of the shell.
 *
 * The shape is the one `lib/platform/host.ts` already reads: `detectHost` looks
 * for `desktop === true` on `window.boofwang` and answers `'browser'` for
 * anything else, so this file is the entire difference between the two builds
 * as far as the application is concerned. Nothing here is a general escape
 * hatch - there is no `require`, no filesystem, no child process. Two functions
 * and a flag, matching two capabilities that were declared before this shell
 * existed.
 *
 * CommonJS on purpose. Electron loads preload scripts as CJS unless the whole
 * package is configured otherwise, and this one file being `.cjs` is cheaper
 * than arranging that for a package whose other 200 files are ESM.
 */
contextBridge.exposeInMainWorld('boofwang', {
  /** Read by `detectHost`. The one fact that switches the capability set. */
  desktop: true,

  /**
   * Fetch a JSON document from anywhere, through the main process.
   *
   * This is `crossOriginFetch`. hearham and RadioID send no
   * `Access-Control-Allow-Origin`, so a browser tab cannot read them at any
   * price; here the request is made outside the renderer, where the
   * same-origin policy does not apply. https only, enforced in main.
   */
  fetchJson: (url) => ipcRenderer.invoke('boofwang:fetch-json', String(url)),

  /**
   * Choose a serial port, when Electron has asked and there is more than one.
   *
   * `navigator.serial.requestPort()` opens no picker in Electron - the shell is
   * asked instead. Rather than let the shell guess, the list comes back to the
   * page through `onSerialPorts` and the answer goes out through here, so the
   * choice stays with the person holding the cable.
   */
  choosePort: (portId) => ipcRenderer.send('boofwang:choose-port', portId ?? ''),

  /** Subscribe to that list. Returns an unsubscribe, as a listener should. */
  onSerialPorts: (handler) => {
    const listener = (_event, ports) => handler(ports)
    ipcRenderer.on('boofwang:serial-ports', listener)
    return () => ipcRenderer.off('boofwang:serial-ports', listener)
  },
})

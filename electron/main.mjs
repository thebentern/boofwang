// SPDX-License-Identifier: GPL-3.0-or-later
import { app, BrowserWindow, ipcMain, protocol, net, shell } from 'electron'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { readFile } from 'node:fs/promises'
import { assertFetchable, respondFor } from './site.mjs'

/**
 * The desktop shell.
 *
 * boofwang is a web app first and this changes nothing about that: the same
 * generated site runs here, unmodified, and the shell exists to supply the two
 * capabilities a browser tab cannot have. `lib/platform/host.ts` names them -
 * `crossOriginFetch` and `customUserAgent` - and two repeater directories are
 * gated on the first, because hearham and RadioID send no CORS header and a
 * browser therefore cannot read them at all.
 *
 * **The custom scheme is not cosmetic.** Web Serial and Web Bluetooth are only
 * exposed in a secure context, and `file://` is not one - a shell that loaded
 * the app off disk directly would have no `navigator.serial`, which is to say
 * it could not program a radio, which is the entire point of the program. `app:`
 * is registered below as standard and secure, so the page gets a real origin,
 * the absolute asset paths in the generated site keep working, and the
 * transport layer runs exactly as it does on boofwa.ng.
 *
 * This is also why the shell is Electron rather than Tauri. Tauri uses the
 * platform's own webview and WKWebView has no Web Serial at all; Electron
 * carries Chromium everywhere, so the serial and Bluetooth transports this
 * project already has are the ones that run. Nothing is reimplemented for the
 * desktop, which is the only version of this worth shipping: a second transport
 * stack would be a second thing to get wrong against somebody's radio.
 */

const HERE = dirname(fileURLToPath(import.meta.url))

/** The generated site: packaged into resources, or the dev build next door. */
const SITE = app.isPackaged ? join(process.resourcesPath, 'site') : join(HERE, '..', '.output', 'public')

const SCHEME = 'app'
const ORIGIN = `${SCHEME}://boofwang`

/*
 * Registered before `whenReady`, which Electron requires: after that the scheme
 * is fixed and these privileges are ignored without an error. `secure` is the
 * load-bearing one - without it the page is not a secure context and
 * `navigator.serial` is simply not there.
 */
protocol.registerSchemesAsPrivileged([
  {
    scheme: SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
  },
])

function serve(request) {
  return respondFor(new URL(request.url).pathname, SITE, readFile).then(
    (r) => new Response(r.body ?? 'Not found', { status: r.status, headers: r.headers }),
  )
}

/**
 * Fetch JSON on the page's behalf, from the main process, where the same-origin
 * policy is not a thing that exists.
 *
 * This is `crossOriginFetch`, and it is the shell's reason to be. Three rules:
 * https only, no credentials, and the answer has to parse as JSON. The renderer
 * picks the URL, so this stays as close to "read a public JSON document" as a
 * privileged fetch can be - it is not a general proxy, and a page that asked it
 * for `file:` or `http:` gets an error rather than a best effort.
 */
export async function fetchJson(url, deps = { fetch: net.fetch, version: () => app.getVersion() }) {
  const parsed = assertFetchable(url)
  const res = await deps.fetch(parsed.toString(), {
    method: 'GET',
    credentials: 'omit',
    redirect: 'follow',
    headers: {
      accept: 'application/json',
      // The capability `customUserAgent` names. Nothing in the registry needs a
      // particular one; saying what this is and where to complain is a courtesy
      // to the people whose directories boofwang reads.
      'user-agent': `boofwang/${deps.version()} (+https://boofwa.ng)`,
    },
  })
  if (!res.ok) throw new Error(`${parsed.host} answered ${res.status}`)
  return await res.json()
}

/** Serial choosers waiting on the page to name a port, by webContents id. */
const pending = new Map()

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 480,
    minHeight: 560,
    backgroundColor: '#141A22',
    title: 'boofwang',
    webPreferences: {
      preload: join(HERE, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })

  const wc = win.webContents

  // Web Serial and Web Bluetooth are the two the app asks for, and nothing else
  // is granted. The page still has to ask - this only stops Electron refusing
  // before the user is consulted.
  wc.session.setPermissionCheckHandler((_wc, permission) => permission === 'serial' || permission === 'bluetooth')
  wc.session.setDevicePermissionHandler(() => true)

  /*
   * The serial chooser.
   *
   * Electron draws no picker: `requestPort()` fires this and the shell decides.
   * Deciding *for* the user is the wrong answer - this project spent a session
   * removing a guess about which radio is on the cable - so with more than one
   * port the page is asked, and it already has a chooser for exactly this. With
   * one port there is nothing to choose between.
   */
  wc.on('select-serial-port', (event, ports, callback) => {
    event.preventDefault()
    if (ports.length === 0) return callback('')
    if (ports.length === 1) return callback(ports[0].portId)
    pending.set(wc.id, callback)
    wc.send('boofwang:serial-ports', ports.map((p) => ({
      portId: p.portId,
      portName: p.portName,
      displayName: p.displayName,
      vendorId: p.vendorId,
      productId: p.productId,
    })))
  })
  wc.on('destroyed', () => pending.delete(wc.id))

  // Anything that is not this app opens in the user's own browser, where there
  // is an address bar to see where it went.
  wc.setWindowOpenHandler(({ url }) => {
    if (!url.startsWith(ORIGIN)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  wc.on('will-navigate', (event, url) => {
    if (!url.startsWith(ORIGIN)) {
      event.preventDefault()
      void shell.openExternal(url)
    }
  })

  // The root, not /index.html: the router would see "/index.html" as a route
  // and answer it with the 404 page. `serve` maps a path with no extension to
  // the shell, so "/" is the index and every in-app route resolves the same way.
  void win.loadURL(`${ORIGIN}/`)
  return win
}

app.whenReady().then(() => {
  protocol.handle(SCHEME, serve)

  ipcMain.handle('boofwang:fetch-json', (_e, url) => fetchJson(String(url)))
  ipcMain.on('boofwang:choose-port', (e, portId) => {
    const callback = pending.get(e.sender.id)
    if (!callback) return
    pending.delete(e.sender.id)
    callback(typeof portId === 'string' ? portId : '')
  })

  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

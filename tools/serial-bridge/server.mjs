// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * A localhost WebSocket-to-serial bridge, for development only.
 *
 * Why this exists. Web Serial needs `requestPort()` to be answered by a human
 * clicking an entry in a native chooser that the browser renders outside the
 * page. That is exactly right for a tool that talks to hardware, and it also
 * means an automated session can never get a port on its own - so a change to
 * the driver could not be tried against a real radio without a person clicking
 * a dialog for every iteration. With three radios to bring up, that is the
 * difference between a working loop and no loop.
 *
 * The bridge hands the browser a `SerialPortLike` backed by a socket instead of
 * `navigator.serial`. Everything above that seam - transport framing, timeouts,
 * the protocol, the driver, the decode, the UI - is the real code path, running
 * against a real radio. What it does *not* exercise is the roughly thirty lines
 * of `navigator.serial` glue in `useWebSerial.ts`, and that gap is the reason
 * this is a development aid rather than a shipping feature.
 *
 * Safety properties, in order of importance:
 *   - Binds to 127.0.0.1 only. Never reachable from another machine.
 *   - Rejects any WebSocket whose Origin is not a localhost dev server.
 *   - One client at a time, because a serial port cannot be shared.
 *   - Never started by the app, the build, or a test. It has to be run by hand.
 *
 * Run it with:  pnpm bridge
 */
import { WebSocketServer } from 'ws'
import { SerialPort } from 'serialport'

const PORT = Number(process.env.BOOFWANG_BRIDGE_PORT ?? 8765)
const HOST = '127.0.0.1'

const ALLOWED_ORIGINS = [/^https?:\/\/localhost(:\d+)?$/, /^https?:\/\/127\.0\.0\.1(:\d+)?$/]

const stamp = () => new Date().toISOString().slice(11, 23)
const log = (...a) => console.log(`[${stamp()}]`, ...a)
const warn = (...a) => console.warn(`[${stamp()}]`, ...a)

/**
 * macOS exposes two nodes per adapter. The `cu.` (call-out) node does not block
 * waiting for carrier detect the way `tty.` does, which is what you want for a
 * programming cable, so it is offered in preference when both exist.
 */
function preferCallout(path) {
  return path.replace('/dev/tty.', '/dev/cu.')
}

async function listPorts() {
  const ports = await SerialPort.list()
  return ports
    .filter((p) => !/Bluetooth|debug-console/i.test(p.path))
    .map((p) => ({
      path: process.platform === 'darwin' ? preferCallout(p.path) : p.path,
      rawPath: p.path,
      manufacturer: p.manufacturer ?? null,
      serialNumber: p.serialNumber ?? null,
      vendorId: p.vendorId ? Number.parseInt(p.vendorId, 16) : null,
      productId: p.productId ? Number.parseInt(p.productId, 16) : null,
    }))
}

const wss = new WebSocketServer({
  host: HOST,
  port: PORT,
  verifyClient: ({ origin }) => {
    // No Origin at all means a non-browser client (a test harness); allow it,
    // since the socket is already unreachable from off-box.
    if (!origin) return true
    const ok = ALLOWED_ORIGINS.some((re) => re.test(origin))
    if (!ok) warn(`rejected a connection from origin ${origin}`)
    return ok
  },
})

/**
 * Guards the *port*, not the connection.
 *
 * Listing adapters is a separate short-lived socket from the one that carries
 * traffic, so refusing a second connection outright would have the client
 * locking itself out between choosing a port and opening it. What genuinely
 * cannot be shared is an open serial port, so that is what is tracked.
 */
let portHolder = null

wss.on('connection', (ws, req) => {
  log(`client connected from ${req.socket.remoteAddress}`)

  /** @type {SerialPort | null} */
  let port = null
  let rx = 0
  let tx = 0

  const send = (obj) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(obj))

  async function closePort(reason) {
    if (portHolder === ws) portHolder = null
    if (!port) return
    const p = port
    port = null
    if (p.isOpen) await new Promise((resolve) => p.close(() => resolve()))
    log(`port closed (${reason}); ${tx} bytes out, ${rx} bytes in`)
  }

  ws.on('message', async (data, isBinary) => {
    // Binary frames are serial payload; everything else is a control message.
    if (isBinary) {
      if (!port?.isOpen) return send({ op: 'error', message: 'Write attempted with no port open' })
      const buf = Buffer.from(data)
      tx += buf.length
      port.write(buf, (e) => {
        if (e) send({ op: 'error', message: `write failed: ${e.message}` })
      })
      return
    }

    let msg
    try {
      msg = JSON.parse(data.toString())
    } catch {
      return send({ op: 'error', message: 'Malformed control message' })
    }

    try {
      switch (msg.op) {
        case 'list':
          return send({ op: 'list', ports: await listPorts() })

        case 'open': {
          if (portHolder && portHolder !== ws) {
            return send({
              op: 'error',
              message: 'Another boofwang tab already has the serial port open. Close it and try again.',
            })
          }
          if (port) await closePort('reopening')
          const opts = {
            path: msg.path,
            baudRate: msg.baudRate ?? 38400,
            dataBits: msg.dataBits ?? 8,
            stopBits: msg.stopBits ?? 1,
            parity: msg.parity ?? 'none',
            rtscts: msg.flowControl === 'hardware',
            autoOpen: false,
          }
          log(`open ${opts.path} @ ${opts.baudRate} ${opts.dataBits}${opts.parity[0].toUpperCase()}${opts.stopBits}`)
          port = new SerialPort(opts)
          rx = tx = 0

          await new Promise((resolve, reject) => port.open((e) => (e ? reject(e) : resolve())))
          portHolder = ws

          // Deassert both by default. Several of these cables reset the radio
          // when DTR or RTS is asserted on open, which looks exactly like a
          // radio that will not answer.
          await new Promise((resolve) =>
            port.set({ dtr: msg.dtr ?? false, rts: msg.rts ?? false }, () => resolve()),
          )

          port.on('data', (chunk) => {
            rx += chunk.length
            if (ws.readyState === ws.OPEN) ws.send(chunk, { binary: true })
          })
          port.on('error', (e) => {
            warn(`port error: ${e.message}`)
            send({ op: 'closed', reason: e.message })
          })
          port.on('close', () => send({ op: 'closed', reason: 'the port closed' }))

          return send({ op: 'open', ok: true, path: opts.path })
        }

        case 'signals':
          if (!port?.isOpen) return send({ op: 'error', message: 'No port open' })
          await new Promise((resolve) =>
            port.set({ dtr: msg.dtr ?? false, rts: msg.rts ?? false }, () => resolve()),
          )
          return send({ op: 'signals', ok: true })

        case 'flush':
          if (!port?.isOpen) return send({ op: 'error', message: 'No port open' })
          await new Promise((resolve) => port.flush(() => resolve()))
          return send({ op: 'flush', ok: true })

        case 'close':
          await closePort('client asked')
          return send({ op: 'close', ok: true })

        default:
          return send({ op: 'error', message: `Unknown op ${JSON.stringify(msg.op)}` })
      }
    } catch (e) {
      warn(`${msg.op} failed: ${e.message}`)
      return send({ op: 'error', message: e.message })
    }
  })

  ws.on('close', async () => {
    await closePort('client went away')
    log('client disconnected')
  })
})

log(`boofwang serial bridge listening on ws://${HOST}:${PORT}`)
log('development only: this is not part of the built app, and nothing starts it automatically')
listPorts().then((ports) => {
  if (ports.length === 0) return log('no serial adapters found')
  log('serial adapters:')
  for (const p of ports) {
    const usb = p.vendorId ? ` ${p.vendorId.toString(16).padStart(4, '0')}:${(p.productId ?? 0).toString(16).padStart(4, '0')}` : ''
    log(`  ${p.path}  ${p.manufacturer ?? ''}${usb}`)
  }
})

// SPDX-License-Identifier: GPL-3.0-or-later
import type { SerialOpenOptions, SerialPortLike } from './transport.js'

/**
 * A `SerialPortLike` backed by the development bridge in `tools/serial-bridge`.
 *
 * This exists so a radio driver can be iterated on against real hardware
 * without a person answering the browser's native port chooser on every run.
 * It plugs in at the same seam as `FakeSerialPort`, which is the whole point of
 * `SerialPortLike`: the transport, the framing, the protocol, the driver and
 * the UI above it are the shipping code path, not a parallel one.
 *
 * The seam is also the limit. Anything specific to `navigator.serial` -
 * permission grants, the `disconnect` event, how a browser reports a port that
 * vanished mid-transfer - is not exercised here. That glue lives in
 * `app/composables/useWebSerial.ts` and still needs a human and a real port.
 */

export interface BridgePortInfo {
  path: string
  manufacturer: string | null
  serialNumber: string | null
  vendorId: number | null
  productId: number | null
}

export class BridgeError extends Error {
  override readonly name = 'BridgeError'
}

interface Pending {
  resolve: (v: Record<string, unknown>) => void
  reject: (e: Error) => void
  op: string
}

/** Ask the bridge what adapters it can see. Opens and closes its own socket. */
export async function listBridgePorts(url: string, timeoutMs = 2000): Promise<BridgePortInfo[]> {
  const ws = await openSocket(url, timeoutMs)
  try {
    return await new Promise<BridgePortInfo[]>((resolve, reject) => {
      const timer = setTimeout(() => reject(new BridgeError('The bridge did not answer a port list')), timeoutMs)
      ws.onmessage = (ev: MessageEvent) => {
        if (typeof ev.data !== 'string') return
        const msg = JSON.parse(ev.data) as { op: string; ports?: BridgePortInfo[]; message?: string }
        if (msg.op === 'list') {
          clearTimeout(timer)
          resolve(msg.ports ?? [])
        } else if (msg.op === 'error') {
          clearTimeout(timer)
          reject(new BridgeError(msg.message ?? 'The bridge reported an error'))
        }
      }
      ws.send(JSON.stringify({ op: 'list' }))
    })
  } finally {
    ws.close()
  }
}

function openSocket(url: string, timeoutMs: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    let ws: WebSocket
    try {
      ws = new WebSocket(url)
    } catch (e) {
      reject(new BridgeError(`Could not reach the bridge at ${url}: ${(e as Error).message}`))
      return
    }
    ws.binaryType = 'arraybuffer'
    const timer = setTimeout(() => {
      ws.close()
      reject(new BridgeError(`The bridge at ${url} did not accept a connection. Is \`pnpm bridge\` running?`))
    }, timeoutMs)
    ws.onopen = () => {
      clearTimeout(timer)
      resolve(ws)
    }
    ws.onerror = () => {
      clearTimeout(timer)
      reject(new BridgeError(`Could not reach the bridge at ${url}. Is \`pnpm bridge\` running?`))
    }
  })
}

export class BridgeSerialPort implements SerialPortLike {
  readable: ReadableStream<Uint8Array> | null = null
  writable: WritableStream<Uint8Array> | null = null

  #url: string
  #path: string
  #info: { usbVendorId?: number; usbProductId?: number }
  #ws: WebSocket | null = null
  #pending: Pending | null = null
  #rxController: ReadableStreamDefaultController<Uint8Array> | null = null

  constructor(url: string, port: BridgePortInfo) {
    this.#url = url
    this.#path = port.path
    this.#info = {
      ...(port.vendorId === null ? {} : { usbVendorId: port.vendorId }),
      ...(port.productId === null ? {} : { usbProductId: port.productId }),
    }
  }

  get path(): string {
    return this.#path
  }

  getInfo(): { usbVendorId?: number; usbProductId?: number } {
    return this.#info
  }

  #control(msg: Record<string, unknown>, timeoutMs = 4000): Promise<Record<string, unknown>> {
    const ws = this.#ws
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new BridgeError('The bridge connection is not open'))
    }
    if (this.#pending) return Promise.reject(new BridgeError('A bridge command is already in flight'))

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending = null
        reject(new BridgeError(`The bridge did not answer ${String(msg.op)}`))
      }, timeoutMs)
      this.#pending = {
        op: String(msg.op),
        resolve: (v) => {
          clearTimeout(timer)
          resolve(v)
        },
        reject: (e) => {
          clearTimeout(timer)
          reject(e)
        },
      }
      ws.send(JSON.stringify(msg))
    })
  }

  async open(options: SerialOpenOptions): Promise<void> {
    if (this.#ws) throw new BridgeError('This bridge port is already open')
    const ws = await openSocket(this.#url, 3000)
    this.#ws = ws

    this.readable = new ReadableStream<Uint8Array>({
      start: (c) => {
        this.#rxController = c
      },
      cancel: () => {
        this.#rxController = null
      },
    })

    this.writable = new WritableStream<Uint8Array>({
      write: (chunk) => {
        if (!this.#ws || this.#ws.readyState !== WebSocket.OPEN) throw new BridgeError('The bridge went away')
        // Copy: the socket may send asynchronously, and the caller is free to
        // reuse its buffer the moment write() resolves.
        this.#ws.send(chunk.slice().buffer)
      },
    })

    ws.onmessage = (ev: MessageEvent) => {
      if (typeof ev.data === 'string') {
        const msg = JSON.parse(ev.data) as { op: string; message?: string }
        if (msg.op === 'closed') {
          this.#rxController?.error(new BridgeError(msg.message ?? 'The bridge closed the port'))
          this.#rxController = null
          return
        }
        const p = this.#pending
        this.#pending = null
        if (!p) return
        if (msg.op === 'error') p.reject(new BridgeError(msg.message ?? 'The bridge reported an error'))
        else p.resolve(msg as unknown as Record<string, unknown>)
        return
      }
      this.#rxController?.enqueue(new Uint8Array(ev.data as ArrayBuffer))
    }

    ws.onclose = () => {
      this.#rxController?.error(new BridgeError('The bridge connection closed'))
      this.#rxController = null
      this.#pending?.reject(new BridgeError('The bridge connection closed'))
      this.#pending = null
    }

    await this.#control({
      op: 'open',
      path: this.#path,
      baudRate: options.baudRate,
      dataBits: options.dataBits ?? 8,
      stopBits: options.stopBits ?? 1,
      parity: options.parity ?? 'none',
      flowControl: options.flowControl ?? 'none',
      dtr: options.signals?.dataTerminalReady ?? false,
      rts: options.signals?.requestToSend ?? false,
    })
  }

  async setSignals(signals: { dataTerminalReady?: boolean; requestToSend?: boolean }): Promise<void> {
    await this.#control({
      op: 'signals',
      dtr: signals.dataTerminalReady ?? false,
      rts: signals.requestToSend ?? false,
    })
  }

  async close(): Promise<void> {
    const ws = this.#ws
    this.#ws = null
    if (!ws) return
    if (ws.readyState === WebSocket.OPEN) {
      // Best effort: the socket closing below tears the port down regardless.
      await this.#control({ op: 'close' }, 1500).catch(() => {})
    }
    ws.close()
    this.readable = null
    this.writable = null
    this.#rxController = null
  }
}

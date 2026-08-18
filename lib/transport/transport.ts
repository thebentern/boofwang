// SPDX-License-Identifier: GPL-3.0-or-later

export interface SerialOpenOptions {
  baudRate: number
  dataBits?: 7 | 8
  stopBits?: 1 | 2
  parity?: 'none' | 'even' | 'odd'
  flowControl?: 'none' | 'hardware'
  bufferSize?: number
  /**
   * Signals asserted immediately after open.
   *
   * DTR/RTS is the reset line on many USB-serial bridges, and several of these
   * cables assert DTR on open. If a radio reboots the moment you connect, set
   * both false here.
   */
  signals?: { dataTerminalReady?: boolean; requestToSend?: boolean }
  /** Split writes larger than this; some bridges choke on one big write. */
  writeChunk?: number
  /** Delay between write chunks, in ms. */
  writeGapMs?: number
  /** Settle time after opening before the first byte is sent. */
  openSettleMs?: number
}

export interface ReadOpts {
  timeoutMs?: number
  signal?: AbortSignal
}

export type TransportState = 'closed' | 'open' | 'desynced' | 'disconnected'

export interface Transport {
  readonly state: TransportState
  open(opts: SerialOpenOptions): Promise<void>
  close(): Promise<void>
  write(data: Uint8Array, opts?: ReadOpts): Promise<void>
  /** Resolve with exactly `n` bytes, or reject on timeout/abort/disconnect. */
  readExactly(n: number, opts?: ReadOpts): Promise<Uint8Array>
  /** Resolve with everything up to and including `delim`. */
  readUntil(delim: Uint8Array, opts?: ReadOpts & { max?: number }): Promise<Uint8Array>
  /** Discard input until the line has been quiet for `quietMs`; clears `desynced`. */
  resync(quietMs?: number, opts?: ReadOpts): Promise<Uint8Array>
  setSignals(signals: { dataTerminalReady?: boolean; requestToSend?: boolean; break?: boolean }): Promise<void>
  onDisconnect(cb: (e: Error) => void): () => void
  /** Hex of the unconsumed buffer. For error messages during protocol bring-up. */
  peekHex(n?: number): string
}

/**
 * The structural subset of `SerialPort` this code needs.
 *
 * Depending on this rather than on `navigator.serial` is what lets the entire
 * driver stack run under plain Node against a scripted fake - no browser, no
 * jsdom, no hardware.
 */
export interface SerialPortLike {
  readonly readable: ReadableStream<Uint8Array> | null
  readonly writable: WritableStream<Uint8Array> | null
  open(options: SerialOpenOptions): Promise<void>
  close(): Promise<void>
  setSignals?(signals: { dataTerminalReady?: boolean; requestToSend?: boolean; break?: boolean }): Promise<void>
  getInfo?(): { usbVendorId?: number; usbProductId?: number }
}

export const DEFAULT_READ_TIMEOUT_MS = 3000

export function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason as Error)
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(t)
      reject(signal!.reason as Error)
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

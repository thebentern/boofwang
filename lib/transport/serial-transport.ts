// SPDX-License-Identifier: GPL-3.0-or-later
import { hexDump } from '../codec/checksum.js'
import { ByteQueue } from './byte-queue.js'
import {
  DesyncedError,
  DeviceDisconnectedError,
  ReadLimitError,
  TransferAbortedError,
  TransportClosedError,
  TransportTimeoutError,
} from './errors.js'
import {
  DEFAULT_READ_TIMEOUT_MS,
  delay,
  type ReadOpts,
  type SerialOpenOptions,
  type SerialPortLike,
  type Transport,
  type TransportState,
} from './transport.js'

interface Waiter {
  /** Try to satisfy this waiter from the queue. Returns null to keep waiting. */
  need(q: ByteQueue): Uint8Array | null
  resolve(v: Uint8Array): void
  reject(e: Error): void
  cleanup(): void
  op: string
}

/**
 * Web Serial wrapped in something a protocol driver can use.
 *
 * Three design points worth knowing before changing anything here:
 *
 * 1. **One pump owns the reader for the port's whole lifetime.** Acquiring and
 *    releasing a reader per call loses every byte that arrives between calls,
 *    and `getReader()` on a locked stream throws outright.
 *
 * 2. **Waiters are strictly FIFO and only the head is serviced.** All three
 *    radio protocols are request/response, so ordering is a feature: an
 *    out-of-order reply is not expressible.
 *
 * 3. **A timeout poisons the transport.** See `DesyncedError` - silently
 *    resynchronising on a late reply is how a codeplug gets written from
 *    byte-shifted garbage.
 */
export class SerialTransport implements Transport {
  #port: SerialPortLike
  #state: TransportState = 'closed'
  #queue = new ByteQueue()
  #waiters: Waiter[] = []
  #reader: ReadableStreamDefaultReader<Uint8Array> | null = null
  #writer: WritableStreamDefaultWriter<Uint8Array> | null = null
  #pumpTask: Promise<void> | null = null
  #listeners = new Set<(e: Error) => void>()
  #opts: SerialOpenOptions | null = null

  constructor(port: SerialPortLike) {
    this.#port = port
  }

  get state(): TransportState {
    return this.#state
  }

  get port(): SerialPortLike {
    return this.#port
  }

  async open(opts: SerialOpenOptions): Promise<void> {
    if (this.#state !== 'closed') throw new Error(`open: transport is already ${this.#state}`)
    this.#opts = opts
    await this.#port.open(opts)

    if (opts.signals && this.#port.setSignals) {
      await this.#port.setSignals(opts.signals)
    }

    const readable = this.#port.readable
    const writable = this.#port.writable
    if (!readable || !writable) {
      await this.#port.close().catch(() => {})
      throw new Error('open: port has no readable/writable stream')
    }

    this.#queue = new ByteQueue()
    this.#waiters = []
    this.#state = 'open'
    this.#pumpTask = this.#pump(readable)
    this.#writer = writable.getWriter()

    if (opts.openSettleMs) await delay(opts.openSettleMs)
  }

  async #pump(readable: ReadableStream<Uint8Array>): Promise<void> {
    const reader = readable.getReader()
    this.#reader = reader
    try {
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        if (value && value.length) {
          this.#queue.push(value)
          this.#serviceWaiters()
        }
      }
    } catch (e) {
      // A stream error means the device went away or the driver faulted.
      if (this.#state === 'open' || this.#state === 'desynced') {
        this.#state = 'disconnected'
        const err = e instanceof Error ? e : new DeviceDisconnectedError(String(e))
        this.#failAll(err)
        this.#notify(err)
      }
    } finally {
      // Released here, not in close(): releasing from close() races the pump.
      try {
        reader.releaseLock()
      } catch {
        /* already released */
      }
      this.#reader = null
    }
  }

  #serviceWaiters(): void {
    // Belt and braces alongside #desync: bytes arriving on a line that is no
    // longer trusted must never satisfy a read.
    if (this.#state !== 'open') return
    while (this.#waiters.length > 0) {
      const w = this.#waiters[0]!
      let got: Uint8Array | null
      try {
        got = w.need(this.#queue)
      } catch (e) {
        this.#waiters.shift()
        w.cleanup()
        w.reject(e instanceof Error ? e : new Error(String(e)))
        continue
      }
      if (got === null) return // head-of-line: nothing behind it can proceed
      this.#waiters.shift()
      w.cleanup()
      w.resolve(got)
    }
  }

  #failAll(err: Error): void {
    const waiters = this.#waiters
    this.#waiters = []
    for (const w of waiters) {
      w.cleanup()
      w.reject(err)
    }
  }

  #drop(target: Waiter): void {
    const i = this.#waiters.indexOf(target)
    if (i >= 0) this.#waiters.splice(i, 1)
  }

  /**
   * Mark the line untrustworthy and fail everything already waiting on it.
   *
   * Failing the queue is the load-bearing half. Setting the state only refuses
   * *new* reads, so a waiter that was already queued when the timeout fired
   * would still be handed whatever bytes turned up next - which is precisely
   * the byte-shifted-frame failure this state exists to prevent. The caller
   * removes its own waiter first, so it still receives its specific error
   * (a timeout or an abort) rather than this generic one.
   */
  #desync(op: string): void {
    if (this.#state !== 'open' && this.#state !== 'desynced') return
    this.#state = 'desynced'
    this.#failAll(new DesyncedError(op))
  }

  #await(need: Waiter['need'], op: string, opts?: ReadOpts): Promise<Uint8Array> {
    if (this.#state === 'desynced') return Promise.reject(new DesyncedError(op))
    if (this.#state === 'disconnected') return Promise.reject(new DeviceDisconnectedError())
    if (this.#state !== 'open') return Promise.reject(new TransportClosedError(op))

    const signal = opts?.signal
    if (signal?.aborted) return Promise.reject(new TransferAbortedError(op))

    const timeoutMs = opts?.timeoutMs ?? DEFAULT_READ_TIMEOUT_MS

    return new Promise<Uint8Array>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined

      const w: Waiter = {
        need,
        op,
        resolve,
        reject,
        cleanup: () => {
          if (timer !== undefined) clearTimeout(timer)
          signal?.removeEventListener('abort', onAbort)
        },
      }

      const onAbort = () => {
        this.#drop(w)
        this.#desync(op)
        w.cleanup()
        reject(new TransferAbortedError(op))
      }

      if (timeoutMs > 0 && Number.isFinite(timeoutMs)) {
        timer = setTimeout(() => {
          this.#drop(w)
          this.#desync(op)
          w.cleanup()
          reject(new TransportTimeoutError(op, timeoutMs, this.peekHex(32), this.#queue.length))
        }, timeoutMs)
      }

      signal?.addEventListener('abort', onAbort, { once: true })
      this.#waiters.push(w)
      // Data may already be buffered from a previous chunk.
      this.#serviceWaiters()
    })
  }

  readExactly(n: number, opts?: ReadOpts): Promise<Uint8Array> {
    return this.#await((q) => q.take(n), `read ${n} byte(s)`, opts)
  }

  readUntil(delim: Uint8Array, opts?: ReadOpts & { max?: number }): Promise<Uint8Array> {
    const max = opts?.max ?? 64 * 1024
    const op = `read until ${hexDump(delim)}`
    return this.#await((q) => {
      const i = q.indexOf(delim)
      if (i < 0) {
        if (q.length > max) throw new ReadLimitError(op, max)
        return null
      }
      return q.take(i + delim.length)
    }, op, opts)
  }

  async write(data: Uint8Array, opts?: ReadOpts): Promise<void> {
    if (this.#state === 'desynced') throw new DesyncedError('write')
    if (this.#state === 'disconnected') throw new DeviceDisconnectedError()
    if (this.#state !== 'open' || !this.#writer) throw new TransportClosedError('write')
    if (opts?.signal?.aborted) throw new TransferAbortedError('write')

    const chunk = this.#opts?.writeChunk ?? 0
    const gap = this.#opts?.writeGapMs ?? 0

    if (chunk <= 0 || data.length <= chunk) {
      await this.#writer.write(data)
      return
    }
    for (let off = 0; off < data.length; off += chunk) {
      if (opts?.signal?.aborted) throw new TransferAbortedError('write')
      await this.#writer.write(data.subarray(off, Math.min(off + chunk, data.length)))
      if (gap > 0 && off + chunk < data.length) await delay(gap, opts?.signal)
    }
  }

  /**
   * Drain whatever is on the line until it has been quiet for `quietMs`, then
   * clear the desynced flag. This is the only way out of `desynced`, and it is
   * deliberately explicit: a driver has to decide that resynchronising is safe.
   */
  async resync(quietMs = 200, opts?: ReadOpts): Promise<Uint8Array> {
    if (this.#state === 'disconnected') throw new DeviceDisconnectedError()
    if (this.#state === 'closed') throw new TransportClosedError('resync')

    this.#failAll(new DesyncedError('resync'))

    const drained: number[] = []
    const deadline = Date.now() + (opts?.timeoutMs ?? 5000)
    for (;;) {
      const before = this.#queue.length
      await delay(quietMs, opts?.signal)
      const after = this.#queue.length
      if (after === before) break
      if (Date.now() > deadline) break
    }
    const rest = this.#queue.clear()
    drained.push(...rest)

    if (this.#state === 'desynced') this.#state = 'open'
    this.#serviceWaiters()
    return Uint8Array.from(drained)
  }

  async setSignals(signals: { dataTerminalReady?: boolean; requestToSend?: boolean; break?: boolean }): Promise<void> {
    if (!this.#port.setSignals) return
    await this.#port.setSignals(signals)
  }

  onDisconnect(cb: (e: Error) => void): () => void {
    this.#listeners.add(cb)
    return () => this.#listeners.delete(cb)
  }

  #notify(e: Error): void {
    for (const l of this.#listeners) {
      try {
        l(e)
      } catch {
        /* a listener must not break teardown */
      }
    }
  }

  /** Called by the browser adapter when navigator.serial reports a disconnect. */
  notifyDisconnected(): void {
    if (this.#state === 'closed' || this.#state === 'disconnected') return
    this.#state = 'disconnected'
    const err = new DeviceDisconnectedError()
    this.#failAll(err)
    this.#notify(err)
    // Deliberately not calling port.close(): the port is already invalid and
    // close() would reject.
  }

  peekHex(n = 32): string {
    return hexDump(this.#queue.peek(n))
  }

  /**
   * Teardown, in the only order that works.
   *
   * `port.close()` rejects while either stream is locked, so: fail pending
   * waiters, cancel the reader (which makes the pump's `read()` resolve done and
   * release its own lock), then close the writer - racing a 500 ms timer against
   * `abort()`, because `writer.close()` can hang indefinitely behind hardware
   * flow control - and only then close the port.
   */
  async close(): Promise<void> {
    if (this.#state === 'closed') return
    const wasDisconnected = this.#state === 'disconnected'
    this.#state = 'closed'
    this.#failAll(new TransportClosedError('close'))

    try {
      await this.#reader?.cancel()
    } catch {
      /* already gone */
    }
    try {
      await this.#pumpTask
    } catch {
      /* pump handles its own errors */
    }
    this.#pumpTask = null

    if (this.#writer) {
      const writer = this.#writer
      this.#writer = null
      await Promise.race([
        writer.close().catch(() => {}),
        delay(500).then(() => writer.abort().catch(() => {})),
      ])
      try {
        writer.releaseLock()
      } catch {
        /* close() already released it */
      }
    }

    if (!wasDisconnected) {
      try {
        await this.#port.close()
      } catch {
        /* throws if physically unplugged; nothing useful to do */
      }
    }

    this.#queue.clear()
    this.#listeners.clear()
  }
}

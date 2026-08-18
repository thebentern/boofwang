// SPDX-License-Identifier: GPL-3.0-or-later
import { toHex } from '../codec/checksum.js'
import type { ReadOpts, Transport, TransportState } from './transport.js'

export interface TraceEntry {
  dir: 'tx' | 'rx'
  /** Milliseconds since the trace started. */
  t: number
  hex: string
  op?: string
}

export interface Trace {
  version: 1
  label: string
  startedAt: string
  entries: TraceEntry[]
}

/**
 * Wraps a transport and records every byte in both directions.
 *
 * Built early on purpose. Without hardware in CI the only way to get protocol
 * regression coverage is to capture real sessions and replay them, so every
 * bring-up session with a radio should run through this and the resulting trace
 * should land in `test/fixtures/traces/`. It doubles as the "show protocol log"
 * disclosure in the UI when someone reports a radio that will not connect.
 */
export class RecordingTransport implements Transport {
  readonly entries: TraceEntry[] = []
  #inner: Transport
  #t0: number
  #label: string
  #startedAt: string

  constructor(inner: Transport, label = 'session', now: () => number = () => Date.now()) {
    this.#inner = inner
    this.#now = now
    this.#t0 = now()
    this.#label = label
    this.#startedAt = new Date(this.#t0).toISOString()
  }

  #now: () => number

  #record(dir: 'tx' | 'rx', data: Uint8Array, op?: string): void {
    this.entries.push({
      dir,
      t: this.#now() - this.#t0,
      hex: toHex(data),
      ...(op === undefined ? {} : { op }),
    })
  }

  get state(): TransportState {
    return this.#inner.state
  }

  open(opts: Parameters<Transport['open']>[0]): Promise<void> {
    return this.#inner.open(opts)
  }

  close(): Promise<void> {
    return this.#inner.close()
  }

  async write(data: Uint8Array, opts?: ReadOpts): Promise<void> {
    this.#record('tx', data)
    return this.#inner.write(data, opts)
  }

  async readExactly(n: number, opts?: ReadOpts): Promise<Uint8Array> {
    const v = await this.#inner.readExactly(n, opts)
    this.#record('rx', v)
    return v
  }

  async readUntil(delim: Uint8Array, opts?: ReadOpts & { max?: number }): Promise<Uint8Array> {
    const v = await this.#inner.readUntil(delim, opts)
    this.#record('rx', v)
    return v
  }

  async resync(quietMs?: number, opts?: ReadOpts): Promise<Uint8Array> {
    const v = await this.#inner.resync(quietMs, opts)
    if (v.length) this.#record('rx', v, 'resync-drained')
    return v
  }

  setSignals(signals: Parameters<Transport['setSignals']>[0]): Promise<void> {
    return this.#inner.setSignals(signals)
  }

  onDisconnect(cb: (e: Error) => void): () => void {
    return this.#inner.onDisconnect(cb)
  }

  peekHex(n?: number): string {
    return this.#inner.peekHex(n)
  }

  toTrace(): Trace {
    return { version: 1, label: this.#label, startedAt: this.#startedAt, entries: [...this.entries] }
  }

  toJSON(): string {
    return JSON.stringify(this.toTrace(), null, 2)
  }
}

// SPDX-License-Identifier: GPL-3.0-or-later
import { vi } from 'vitest'
import type { Transport } from '#core/transport/transport.js'
import { MEM_SIZE } from '#core/radios/uv9r/protocol.js'

/**
 * A scripted radio that speaks CHIRP's baofeng_common.py protocol.
 *
 * Nobody here has one of these radios, so this is not a recording of one. It
 * is CHIRP's description of the conversation, written as the other end of it,
 * and it is deliberately strict about the one thing CHIRP leaves open: where
 * the radio's 0x06 before a block header comes from.
 *
 * - 'answers-host-ack': the radio sends 0x06 only in reply to the host's own
 *   0x06 after a block. A reader that does not acknowledge blocks waits for
 *   an acknowledgment that never comes. This is the reading CHIRP's
 *   `first_command` special case fits most naturally.
 * - 'acks-each-read': the radio sends 0x06 before every header except the
 *   first after the handshake, and ignores the host's. This is how the UV-5R
 *   family behaves, since boofwang's reader for it never acknowledges and
 *   works on three radios.
 *
 * The driver has to work against both, because nothing yet says which a
 * UV-9R does.
 */
export type AckModel = 'answers-host-ack' | 'acks-each-read'

export interface FakeRadioOptions {
  readonly magic: Uint8Array
  readonly ident: Uint8Array
  readonly ackModel?: AckModel
  /** Answer the first matching magic with 0xfe, as the UV-5G did after idling. */
  readonly refuseFirstMagic?: boolean
  /** Return everything written, as a shorted or counterfeit adapter does. */
  readonly loopback?: boolean
  /**
   * Drop the byte at 0x1FCF from any 0x40 read that spans it, the way CHIRP
   * describes some later radios doing: the rest moves up one and 0x80 pads the
   * end. Sixteen-byte reads are unaffected.
   */
  readonly droppedByte?: boolean
  /** Acknowledge a write to this address and store nothing. */
  readonly ignoreWritesAt?: number
}

export interface FakeRadio {
  readonly transport: Transport
  /**
   * Every write frame the radio accepted, in order, with the clock when it
   * arrived - under fake timers, so the pacing between frames can be read.
   */
  readonly writes: { addr: number; data: Uint8Array; at: number }[]
  /** Every block read, in order. */
  readonly reads: { addr: number; size: number }[]
  /**
   * Every read and write together, in the order the radio saw them, as
   * `read 1f00/40` and `write 1000`. The two lists above cannot say whether a
   * read came before a write, and that is what an order test is about.
   */
  readonly wire: string[]
  /** How many lone 0x06 bytes the host sent once cloning had begun. */
  hostAcks: number
  /** The radio's memory, as writes leave it. */
  readonly memory: Uint8Array
}

export function fakeRadio(memory: Uint8Array, opts: FakeRadioOptions): FakeRadio {
  if (memory.length !== MEM_SIZE) throw new Error(`a fake radio holds ${MEM_SIZE} bytes, not ${memory.length}`)
  const mem = memory.slice()
  const ackModel = opts.ackModel ?? 'answers-host-ack'
  const out: number[] = []
  let state: 'idle' | 'magic-ok' | 'ident-sent' | 'clone' = 'idle'
  let magicBuf: number[] = []
  let magicMatches = 0
  let firstRead = true

  const radio: FakeRadio = {
    writes: [],
    reads: [],
    wire: [],
    hostAcks: 0,
    memory: mem,
    transport: {
      kind: 'serial',
      radioLink: 'serial',
      async write(data: Uint8Array) {
        if (opts.loopback) {
          out.push(...data)
          return
        }
        if (state === 'idle') {
          for (const b of data) {
            magicBuf.push(b)
            if (magicBuf.length > opts.magic.length) magicBuf.shift()
            if (magicBuf.length === opts.magic.length && magicBuf.every((x, i) => x === opts.magic[i])) {
              magicBuf = []
              magicMatches++
              if (opts.refuseFirstMagic && magicMatches === 1) {
                out.push(0xfe)
              } else {
                out.push(0x06)
                state = 'magic-ok'
              }
            }
          }
          return
        }
        if (state === 'magic-ok') {
          if (data.length === 1 && data[0] === 0x02) {
            out.push(...opts.ident)
            state = 'ident-sent'
          }
          return
        }
        if (state === 'ident-sent') {
          if (data.length === 1 && data[0] === 0x06) {
            out.push(0x06)
            state = 'clone'
            firstRead = true
          }
          return
        }
        // Cloning.
        if (data.length === 1 && data[0] === 0x06) {
          radio.hostAcks++
          if (ackModel === 'answers-host-ack') out.push(0x06)
          return
        }
        if (data[0] === 0x53 && data.length === 4) {
          const addr = (data[1]! << 8) | data[2]!
          const size = data[3]!
          radio.reads.push({ addr, size })
          radio.wire.push(`read ${addr.toString(16)}/${size.toString(16)}`)
          if (ackModel === 'acks-each-read' && !firstRead) out.push(0x06)
          firstRead = false
          out.push(0x58, data[1]!, data[2]!, size)
          const block = mem.slice(addr, addr + size)
          if (opts.droppedByte && size === 0x40 && addr <= 0x1fcf && addr + size > 0x1fcf) {
            const at = 0x1fcf - addr
            block.copyWithin(at, at + 1)
            block[size - 1] = 0x80
          }
          out.push(...block)
          return
        }
        if (data[0] === 0x58 && data.length === 4 + 0x10) {
          const addr = (data[1]! << 8) | data[2]!
          const payload = data.slice(4)
          radio.writes.push({ addr, data: payload, at: Date.now() })
          radio.wire.push(`write ${addr.toString(16)}`)
          if (addr !== opts.ignoreWritesAt) mem.set(payload, addr)
          out.push(0x06)
          return
        }
        throw new Error(`the fake radio does not understand ${[...data].map((b) => b.toString(16)).join(' ')}`)
      },
      async readExactly(n: number) {
        if (out.length < n) throw new Error(`the radio has only ${out.length} byte(s), ${n} wanted`)
        return Uint8Array.from(out.splice(0, n))
      },
      async readUntil() {
        throw new Error('not used by this protocol')
      },
      // identify() drains before every magic; a fake has nothing stale unless
      // a test put it there, and a drain is exactly what should remove it.
      async resync() {
        return Uint8Array.from(out.splice(0, out.length))
      },
      async open() {},
      async close() {},
      async setSignals() {},
      onDisconnect: () => () => {},
      peekHex: () => out.slice(0, 16).map((b) => b.toString(16).padStart(2, '0')).join(' '),
      state: 'open',
    } as unknown as Transport,
  }
  return radio
}

/**
 * Run a driver call to completion under fake timers.
 *
 * CHIRP's pacing - 50 ms after every block, a second between identify
 * attempts - is kept in the protocol and would cost a real six seconds a read,
 * so the specs advance the clock instead of waiting on it.
 */
export async function drive<T>(p: Promise<T>): Promise<T> {
  let settled = false
  let value: T | undefined
  let error: unknown
  p.then(
    (v) => {
      settled = true
      value = v
    },
    (e: unknown) => {
      settled = true
      error = e
    },
  )
  while (!settled) await vi.advanceTimersByTimeAsync(100)
  if (error !== undefined) throw error
  return value as T
}

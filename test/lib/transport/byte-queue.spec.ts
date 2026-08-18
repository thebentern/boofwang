// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { ByteQueue } from '#core/transport/byte-queue.js'

const b = (...xs: number[]) => Uint8Array.from(xs)

describe('ByteQueue', () => {
  it('reassembles a value split across chunks', () => {
    const q = new ByteQueue()
    q.push(b(1, 2))
    q.push(b(3))
    q.push(b(4, 5, 6))
    expect([...q.take(4)!]).toEqual([1, 2, 3, 4])
    expect(q.length).toBe(2)
    expect([...q.take(2)!]).toEqual([5, 6])
  })

  it('returns null rather than a short read', () => {
    const q = new ByteQueue()
    q.push(b(1, 2, 3))
    expect(q.take(4)).toBeNull()
    expect(q.length).toBe(3) // and consumes nothing
  })

  it('ignores empty chunks', () => {
    const q = new ByteQueue()
    q.push(new Uint8Array(0))
    expect(q.length).toBe(0)
  })

  it('finds a delimiter that straddles a chunk boundary', () => {
    const q = new ByteQueue()
    q.push(b(0x00, 0x11, 0xdc))
    q.push(b(0xba, 0x99))
    expect(q.indexOf(b(0xdc, 0xba))).toBe(2)
  })

  it('reports -1 for an absent delimiter', () => {
    const q = new ByteQueue()
    q.push(b(1, 2, 3))
    expect(q.indexOf(b(9, 9))).toBe(-1)
  })

  it('honours the search start offset', () => {
    const q = new ByteQueue()
    q.push(b(0xaa, 0xbb, 0xaa, 0xbb))
    expect(q.indexOf(b(0xaa, 0xbb))).toBe(0)
    expect(q.indexOf(b(0xaa, 0xbb), 1)).toBe(2)
  })

  it('peeks without consuming', () => {
    const q = new ByteQueue()
    q.push(b(1, 2, 3, 4))
    expect([...q.peek(2)]).toEqual([1, 2])
    expect([...q.peekTail(2)]).toEqual([3, 4])
    expect(q.length).toBe(4)
  })

  it('peeks past the end without throwing', () => {
    const q = new ByteQueue()
    q.push(b(1))
    expect([...q.peek(8)]).toEqual([1])
    expect([...q.peekTail(8)]).toEqual([1])
  })

  it('take(0) yields an empty array, not null', () => {
    expect([...new ByteQueue().take(0)!]).toEqual([])
  })

  it('rejects a negative count', () => {
    expect(() => new ByteQueue().take(-1)).toThrow(RangeError)
  })

  it('preserves byte order and content under arbitrary chunking', () => {
    fc.assert(
      fc.property(
        fc.array(fc.uint8Array({ minLength: 0, maxLength: 32 }), { maxLength: 20 }),
        fc.array(fc.integer({ min: 0, max: 16 }), { maxLength: 20 }),
        (chunks, takes) => {
          const q = new ByteQueue()
          const expected: number[] = []
          for (const c of chunks) {
            q.push(Uint8Array.from(c))
            expected.push(...c)
          }
          const got: number[] = []
          for (const n of takes) {
            const t = q.take(n)
            if (t === null) break
            got.push(...t)
          }
          expect(got).toEqual(expected.slice(0, got.length))
          expect(q.length).toBe(expected.length - got.length)
        },
      ),
    )
  })

  it('stays linear over a large transfer', () => {
    // A naive concat-per-chunk buffer is quadratic; an 800 KB DM-32UV download
    // arrives as thousands of chunks and would copy tens of gigabytes.
    const q = new ByteQueue()
    const chunk = new Uint8Array(64).fill(0xab)
    const t0 = performance.now()
    for (let i = 0; i < 12_500; i++) q.push(chunk) // 800 KB
    let total = 0
    for (;;) {
      const got = q.take(Math.min(4096, q.length))
      if (!got || got.length === 0) break
      total += got.length
    }
    const ms = performance.now() - t0
    expect(total).toBe(800_000)
    expect(q.length).toBe(0)
    expect(ms).toBeLessThan(1000)
  })
})

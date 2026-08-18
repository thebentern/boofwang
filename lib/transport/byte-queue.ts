// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * A FIFO byte buffer built from the chunks Web Serial hands back.
 *
 * `reader.read()` resolves with whatever bytes happened to arrive - one call may
 * yield 1 byte or 300, and it bears no relation to protocol frame boundaries.
 * So chunks accumulate here and are consumed by exact count or up to a
 * delimiter.
 *
 * The implementation keeps a list of chunks plus a head offset rather than
 * concatenating. The obvious `buffer = new Uint8Array([...buffer, ...chunk])`
 * is quadratic, which over an 800 KB DM-32UV download means copying tens of
 * gigabytes; this is linear.
 */
export class ByteQueue {
  #chunks: Uint8Array[] = []
  #head = 0
  #length = 0

  get length(): number {
    return this.#length
  }

  push(chunk: Uint8Array): void {
    if (chunk.length === 0) return
    this.#chunks.push(chunk)
    this.#length += chunk.length
  }

  /** Remove and return exactly `n` bytes, or `null` if fewer are available. */
  take(n: number): Uint8Array | null {
    if (n < 0) throw new RangeError(`ByteQueue.take: negative count ${n}`)
    if (n === 0) return new Uint8Array(0)
    if (this.#length < n) return null

    const out = new Uint8Array(n)
    let written = 0
    while (written < n) {
      const chunk = this.#chunks[0]!
      const available = chunk.length - this.#head
      const take = Math.min(available, n - written)
      out.set(chunk.subarray(this.#head, this.#head + take), written)
      written += take
      this.#head += take
      this.#length -= take
      if (this.#head === chunk.length) {
        this.#chunks.shift()
        this.#head = 0
      }
    }
    return out
  }

  /** Byte at logical index `i`, or `undefined` past the end. */
  at(i: number): number | undefined {
    if (i < 0 || i >= this.#length) return undefined
    let remaining = i + this.#head
    for (const chunk of this.#chunks) {
      if (remaining < chunk.length) return chunk[remaining]
      remaining -= chunk.length
    }
    return undefined
  }

  /**
   * Index of the first occurrence of `needle`, or -1.
   * Scans across chunk boundaries without materialising the buffer.
   */
  indexOf(needle: Uint8Array, from = 0): number {
    if (needle.length === 0) return from
    const limit = this.#length - needle.length
    outer: for (let i = Math.max(0, from); i <= limit; i++) {
      for (let j = 0; j < needle.length; j++) {
        if (this.at(i + j) !== needle[j]) continue outer
      }
      return i
    }
    return -1
  }

  /** Copy out the last `n` bytes without consuming them. For error messages. */
  peekTail(n: number): Uint8Array {
    const count = Math.min(n, this.#length)
    const out = new Uint8Array(count)
    for (let i = 0; i < count; i++) out[i] = this.at(this.#length - count + i)!
    return out
  }

  /** Copy out up to `n` bytes from the front without consuming them. */
  peek(n: number): Uint8Array {
    const count = Math.min(n, this.#length)
    const out = new Uint8Array(count)
    for (let i = 0; i < count; i++) out[i] = this.at(i)!
    return out
  }

  clear(): Uint8Array {
    const all = this.take(this.#length) ?? new Uint8Array(0)
    this.#chunks = []
    this.#head = 0
    this.#length = 0
    return all
  }
}

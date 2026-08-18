// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Primitive field codecs.
 *
 * Everything operates on a `Uint8Array` plus an absolute offset rather than a
 * `DataView`, so fields compose over subarrays without anyone having to reason
 * about `byteOffset` twice.
 *
 * Two rules hold throughout:
 *   - `get` never retains a reference into the caller's buffer (byte fields copy).
 *   - `set` writes only the bytes it owns. Bit-level fields mask; they never
 *     rewrite a whole byte to change three bits.
 */

/**
 * `TSet` is separate from `T` so a field can accept less than it returns.
 * Bit fields rely on this: reading yields every named slice, but writing takes a
 * partial patch, which is what makes "change one bit, leave the rest of the byte
 * alone" the natural thing to write.
 */
export interface Field<T, TSet = T> {
  readonly size: number
  get(buf: Uint8Array, off: number): T
  set(buf: Uint8Array, off: number, v: TSet): void
}

function bounds(buf: Uint8Array, off: number, size: number, what: string): void {
  if (off < 0 || off + size > buf.length) {
    throw new RangeError(`${what}: [${off}, ${off + size}) out of bounds for buffer of ${buf.length}`)
  }
}

/**
 * Reject values an unsigned field cannot hold, rather than wrapping them.
 *
 * Silent wrapping is dangerous here rather than merely sloppy: writing -1 to
 * the UV-K5's 32-bit frequency field wraps to 0xFFFFFFFF, which is exactly that
 * radio's "this channel is empty" sentinel. A sign error would erase a channel
 * and report success.
 */
function checkUnsigned(value: number, size: number, name: string): number {
  if (!Number.isFinite(value)) throw new RangeError(`${name}: ${value} is not a finite number`)
  const v = Math.trunc(value)
  const max = 2 ** (size * 8) - 1
  if (v < 0 || v > max) throw new RangeError(`${name}: ${value} does not fit in ${size} byte(s) (0..${max})`)
  return v
}

// ---------------------------------------------------------------- integers --

export const u8: Field<number> = {
  size: 1,
  get(buf, off) {
    bounds(buf, off, 1, 'u8')
    return buf[off]!
  },
  set(buf, off, v) {
    bounds(buf, off, 1, 'u8')
    buf[off] = checkUnsigned(v, 1, 'u8')
  },
}

export const i8: Field<number> = {
  size: 1,
  get(buf, off) {
    bounds(buf, off, 1, 'i8')
    return (buf[off]! << 24) >> 24
  },
  set(buf, off, v) {
    bounds(buf, off, 1, 'i8')
    if (!Number.isFinite(v)) throw new RangeError(`i8: ${v} is not a finite number`)
    const t = Math.trunc(v)
    if (t < -128 || t > 127) throw new RangeError(`i8: ${v} does not fit in one signed byte (-128..127)`)
    buf[off] = t & 0xff
  },
}

function uintLE(size: number, name: string): Field<number> {
  return {
    size,
    get(buf, off) {
      bounds(buf, off, size, name)
      let v = 0
      for (let i = size - 1; i >= 0; i--) v = v * 256 + buf[off + i]!
      return v
    },
    set(buf, off, value) {
      bounds(buf, off, size, name)
      let v = checkUnsigned(value, size, name)
      for (let i = 0; i < size; i++) {
        buf[off + i] = v & 0xff
        v = Math.floor(v / 256)
      }
    },
  }
}

function uintBE(size: number, name: string): Field<number> {
  return {
    size,
    get(buf, off) {
      bounds(buf, off, size, name)
      let v = 0
      for (let i = 0; i < size; i++) v = v * 256 + buf[off + i]!
      return v
    },
    set(buf, off, value) {
      bounds(buf, off, size, name)
      let v = checkUnsigned(value, size, name)
      for (let i = size - 1; i >= 0; i--) {
        buf[off + i] = v & 0xff
        v = Math.floor(v / 256)
      }
    },
  }
}

export const u16le = uintLE(2, 'u16le')
export const u24le = uintLE(3, 'u24le')
export const u32le = uintLE(4, 'u32le')
export const u16be = uintBE(2, 'u16be')
export const u24be = uintBE(3, 'u24be')
export const u32be = uintBE(4, 'u32be')

// ------------------------------------------------------------------- bytes --

/** Raw bytes. `get` returns a copy so callers cannot alias the image. */
export function bytes(n: number): Field<Uint8Array> {
  return {
    size: n,
    get(buf, off) {
      bounds(buf, off, n, `bytes(${n})`)
      return buf.slice(off, off + n)
    },
    set(buf, off, v) {
      bounds(buf, off, n, `bytes(${n})`)
      if (v.length !== n) throw new RangeError(`bytes(${n}): expected ${n} bytes, got ${v.length}`)
      buf.set(v, off)
    },
  }
}

// ------------------------------------------------------------------ string --

export interface AsciiOpts {
  /** Byte written after the string to fill the remainder of the field. */
  pad?: number
  /**
   * Bytes that terminate the string on read, in addition to `pad`.
   * Defaults to NUL and 0xFF, which between them cover every radio here.
   */
  terminators?: readonly number[]
  /** Strip trailing spaces on read. Radios pad with spaces as often as NULs. */
  trimEnd?: boolean
}

/**
 * Fixed-width single-byte string (latin-1: byte value === code point).
 *
 * Latin-1 rather than UTF-8 because these fields are fixed-width *byte* arrays
 * on the radio; a multi-byte encoding would silently truncate mid-character and
 * the round-trip would not be byte-exact.
 */
export function ascii(n: number, opts: AsciiOpts = {}): Field<string> {
  const pad = opts.pad ?? 0x00
  const terms = new Set<number>(opts.terminators ?? [0x00, 0xff])
  terms.add(pad)
  const trimEnd = opts.trimEnd ?? true

  return {
    size: n,
    get(buf, off) {
      bounds(buf, off, n, `ascii(${n})`)
      let end = n
      for (let i = 0; i < n; i++) {
        if (terms.has(buf[off + i]!)) {
          end = i
          break
        }
      }
      let s = ''
      for (let i = 0; i < end; i++) s += String.fromCharCode(buf[off + i]!)
      return trimEnd ? s.replace(/ +$/, '') : s
    },
    set(buf, off, v) {
      bounds(buf, off, n, `ascii(${n})`)
      for (let i = 0; i < Math.min(v.length, n); i++) {
        if (v.charCodeAt(i) > 0xff) {
          throw new RangeError(`ascii(${n}): code point U+${v.charCodeAt(i).toString(16)} is not single-byte`)
        }
      }
      // Idempotent write: if these bytes already decode to `v`, leave them
      // exactly as they are. Radios pad with NUL, 0xFF or spaces inconsistently
      // - and sometimes leave junk after the terminator - so normalising the
      // padding on every write would make `read` then `write` perturb bytes
      // nobody asked to change, filling every upload diff with phantom edits.
      if (this.get(buf, off) === v) return
      const len = Math.min(v.length, n)
      for (let i = 0; i < len; i++) buf[off + i] = v.charCodeAt(i)
      buf.fill(pad, off + len, off + n)
    },
  }
}

// -------------------------------------------------------------- bit fields --

export type BitMap = Record<string, readonly [lsb: number, width: number]>
export type BitValues<M extends BitMap> = { [K in keyof M]: number }

/**
 * Named bit slices packed into 1-4 little-endian bytes.
 *
 * Positions are given LSB-first as `[lsb, width]`, which is unambiguous. If you
 * are transcribing a CHIRP `bitwise` declaration, use `chirpBits` instead - it
 * takes MSB-first declaration order like CHIRP does and computes the positions,
 * so the transcription is mechanical rather than mental arithmetic.
 *
 * The setter is read-modify-write per slice, so bits outside the map keep their
 * value even if the map does not cover the whole byte. That is the property that
 * makes it safe to model a byte we only half understand.
 */
export function bits<M extends BitMap>(
  byteLen: 1 | 2 | 3 | 4,
  map: M,
): Field<BitValues<M>, Partial<BitValues<M>>> {
  const total = byteLen * 8
  const entries = Object.entries(map) as [keyof M & string, readonly [number, number]][]

  const seen = new Array<string | undefined>(total)
  for (const [name, [lsb, width]] of entries) {
    if (width < 1) throw new RangeError(`bits: ${name} has width ${width}`)
    if (lsb < 0 || lsb + width > total) {
      throw new RangeError(`bits: ${name} occupies bits [${lsb}, ${lsb + width}) which exceeds ${total}`)
    }
    for (let b = lsb; b < lsb + width; b++) {
      if (seen[b] !== undefined) throw new RangeError(`bits: ${name} overlaps ${seen[b]} at bit ${b}`)
      seen[b] = name
    }
  }

  const word = byteLen === 1 ? u8 : uintLE(byteLen, `bits(${byteLen})`)

  return {
    size: byteLen,
    get(buf, off) {
      const w = word.get(buf, off)
      const out = {} as BitValues<M>
      for (const [name, [lsb, width]] of entries) {
        out[name] = Math.floor(w / 2 ** lsb) % 2 ** width
      }
      return out
    },
    set(buf, off, v) {
      let w = word.get(buf, off)
      for (const [name, [lsb, width]] of entries) {
        const next = v[name]
        if (next === undefined) continue
        const span = 2 ** width
        // `NaN < 0` and `NaN >= span` are both false, so an explicit finiteness
        // check is required; without it NaN propagates into the word and the
        // whole thing is written as zero, wiping the very bits this field
        // promises to leave alone.
        if (!Number.isFinite(next) || next < 0 || next >= span) {
          throw new RangeError(`bits: ${String(name)} = ${next} does not fit in ${width} bit(s)`)
        }
        const scale = 2 ** lsb
        const current = Math.floor(w / scale) % span
        w += (Math.trunc(next) - current) * scale
      }
      word.set(buf, off, w)
    },
  }
}

/**
 * `bits` from a CHIRP `bitwise` declaration.
 *
 * CHIRP writes `u8 a:3, b:1, c:4` meaning `a` takes the *high* three bits. This
 * takes the same MSB-first order so a declaration can be copied across without
 * re-deriving offsets - the single most error-prone step in porting a driver.
 * Keep CHIRP's placeholder names (`unknown1`, `_rsvd`) rather than dropping
 * them: a named reserved slice is covered by `coverage()` and protected by the
 * masking setter.
 */
export function chirpBits<const D extends readonly (readonly [string, number])[]>(
  byteLen: 1 | 2 | 3 | 4,
  decls: D,
): Field<{ [K in D[number][0]]: number }, Partial<{ [K in D[number][0]]: number }>> {
  const total = byteLen * 8
  const declared = decls.reduce((n, [, w]) => n + w, 0)
  if (declared !== total) {
    throw new RangeError(`chirpBits: declarations cover ${declared} bit(s), expected exactly ${total}`)
  }
  const map: Record<string, readonly [number, number]> = {}
  let cursor = total
  for (const [name, width] of decls) {
    cursor -= width
    if (name in map) throw new RangeError(`chirpBits: duplicate field ${name}`)
    map[name] = [cursor, width]
  }
  return bits(byteLen, map) as Field<
    { [K in D[number][0]]: number },
    Partial<{ [K in D[number][0]]: number }>
  >
}

// ------------------------------------------------------------------ scaled --

/**
 * An integer field stored in units of `factor` (e.g. UV-K5 frequencies are
 * u32le in units of 10 Hz: `mem.freq = int(_mem.freq) * 10` in CHIRP's uvk5.py).
 *
 * `sentinels` are stored values passed through untouched in both directions -
 * an all-ones word means "empty channel", not "42949672950 Hz".
 */
export function scaled(base: Field<number>, factor: number, sentinels: readonly number[] = []): Field<number> {
  const sent = new Set(sentinels)
  return {
    size: base.size,
    get(buf, off) {
      const raw = base.get(buf, off)
      return sent.has(raw) || !Number.isFinite(raw) ? raw : raw * factor
    },
    set(buf, off, v) {
      if (!Number.isFinite(v)) return base.set(buf, off, v)
      base.set(buf, off, sent.has(v) ? v : Math.round(v / factor))
    },
  }
}

// --------------------------------------------------------------------- bcd --

/** Range-check a BCD value before any byte is written. */
function checkBcd(value: number, nBytes: number, name: string): number {
  const v = Math.round(value)
  if (v < 0) throw new RangeError(`${name}(${nBytes}): negative value ${value}`)
  const digits = nBytes * 2
  if (v >= 10 ** digits) throw new RangeError(`${name}(${nBytes}): ${value} needs more than ${digits} digits`)
  return v
}

/**
 * Packed BCD, least-significant *byte* first.
 *
 * Each byte holds two decimal digits with the high nibble the more significant
 * of the pair; the byte order is reversed. Verified against CHIRP's
 * `bitwise.py`: an `lbcd` array reverses `self.__items` and each element goes
 * through `dec_to_bbcd`, so 14652000 is stored `00 20 65 14`. The Baofeng
 * DM-32UV uses the same encoding.
 *
 * Returns `NaN` for nibbles that are not valid BCD rather than inventing a
 * plausible number - an unprogrammed slot is usually 0xFF filled, and that must
 * be distinguishable from a real value.
 */
export function bcdLE(nBytes: number): Field<number> {
  return {
    size: nBytes,
    get(buf, off) {
      bounds(buf, off, nBytes, `bcdLE(${nBytes})`)
      let v = 0
      for (let i = nBytes - 1; i >= 0; i--) {
        const b = buf[off + i]!
        const hi = b >> 4
        const lo = b & 0x0f
        if (hi > 9 || lo > 9) return Number.NaN
        v = v * 100 + hi * 10 + lo
      }
      return v
    },
    set(buf, off, value) {
      bounds(buf, off, nBytes, `bcdLE(${nBytes})`)
      // `get` returns NaN for nibbles that are not valid BCD - an unprogrammed
      // 0xFF-filled slot, typically. Writing that back must be a no-op, or the
      // round trip would replace "undecodable" with a fabricated zero.
      if (!Number.isFinite(value)) return
      // Validated before a single byte is written: a field left holding the low
      // digits of a rejected value is worse than one left untouched, because
      // the caller sees a thrown error and reasonably assumes nothing changed.
      let v = checkBcd(value, nBytes, 'bcdLE')
      for (let i = 0; i < nBytes; i++) {
        const pair = v % 100
        buf[off + i] = (Math.floor(pair / 10) << 4) | pair % 10
        v = Math.floor(v / 100)
      }
    },
  }
}

/** Packed BCD, most-significant byte first. CHIRP's `bbcd`. */
export function bcdBE(nBytes: number): Field<number> {
  return {
    size: nBytes,
    get(buf, off) {
      bounds(buf, off, nBytes, `bcdBE(${nBytes})`)
      let v = 0
      for (let i = 0; i < nBytes; i++) {
        const b = buf[off + i]!
        const hi = b >> 4
        const lo = b & 0x0f
        if (hi > 9 || lo > 9) return Number.NaN
        v = v * 100 + hi * 10 + lo
      }
      return v
    },
    set(buf, off, value) {
      bounds(buf, off, nBytes, `bcdBE(${nBytes})`)
      if (!Number.isFinite(value)) return
      let v = checkBcd(value, nBytes, 'bcdBE')
      for (let i = nBytes - 1; i >= 0; i--) {
        const pair = v % 100
        buf[off + i] = (Math.floor(pair / 10) << 4) | pair % 10
        v = Math.floor(v / 100)
      }
    },
  }
}

/**
 * Frequency in hertz stored as little-endian packed BCD in units of 10 Hz.
 *
 * 145.350 MHz -> 14535000 -> stored `00 50 53 14`.
 *
 * This is both CHIRP's `lbcd rxfreq[4]` (Baofeng UV-5R family) and the DM-32UV
 * spec's "round(MHz * 100000), packed two digits per byte, stored little
 * endian" - they are the same encoding described from two directions.
 */
export function bcdFreqLE(nBytes: number): Field<number> {
  return scaled(bcdLE(nBytes), 10)
}

/** Alias documenting the CHIRP spelling. Identical encoding to {@link bcdFreqLE}. */
export const lbcdFreq = bcdFreqLE

// -------------------------------------------------------------------- enum --

/**
 * Integer field surfaced as a string when the value is known, and left as the
 * raw number when it is not. Unknown values must survive: a radio firmware we
 * have not seen may use an encoding we have not catalogued, and turning that
 * into `undefined` would lose it on write-back.
 */
export function enumOf<T extends string>(base: Field<number>, table: Readonly<Record<number, T>>): Field<T | number> {
  const reverse = new Map<string, number>()
  for (const [k, v] of Object.entries(table)) reverse.set(v, Number(k))
  return {
    size: base.size,
    get(buf, off) {
      const raw = base.get(buf, off)
      return table[raw] ?? raw
    },
    set(buf, off, v) {
      if (typeof v === 'number') return base.set(buf, off, v)
      const raw = reverse.get(v)
      if (raw === undefined) throw new RangeError(`enumOf: unknown symbol ${JSON.stringify(v)}`)
      base.set(buf, off, raw)
    },
  }
}

/** Fixed-length array of a field, with an optional stride larger than the element. */
export function array<T, TSet = T>(
  n: number,
  field: Field<T, TSet>,
  stride: number = field.size,
): Field<T[], TSet[]> {
  if (stride < field.size) throw new RangeError(`array: stride ${stride} is smaller than element ${field.size}`)
  return {
    size: n === 0 ? 0 : (n - 1) * stride + field.size,
    get(buf, off) {
      const out: T[] = new Array<T>(n)
      for (let i = 0; i < n; i++) out[i] = field.get(buf, off + i * stride)
      return out
    },
    set(buf, off, v) {
      if (v.length !== n) throw new RangeError(`array: expected ${n} elements, got ${v.length}`)
      for (let i = 0; i < n; i++) field.set(buf, off + i * stride, v[i]!)
    },
  }
}

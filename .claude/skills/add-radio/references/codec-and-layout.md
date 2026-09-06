# The codec DSL and writing a layout

Everything here is in `lib/codec/`: `fields.ts`, `struct.ts`, `checksum.ts`,
re-exported from `index.ts`. Worked examples in
`lib/radios/uv82/layout.ts` (small and clean),
`lib/radios/uvk5/layout.ts` and `lib/radios/dm32uv/layout.ts` (large).

## Why offsets are explicit

Offsets are written out rather than inferred from declaration order. Protocol
specs are written that way, so transcription stays a one-to-one copy, and gaps
stay visible instead of being silently absorbed by implicit packing.
`coverage()` then reports exactly which bytes of a record the codebase claims to
understand.

## `defineStruct(size, layout)`

```ts
export const UV82_CHANNEL = defineStruct(16, {
  rxFreq: at(0x00, lbcdFreq(4)),
  txFreq: at(0x04, lbcdFreq(4)),
  rxTone: at(0x08, u16le),
  txTone: at(0x0a, u16le),
  // ...
})
```

Overlapping or out-of-bounds fields throw at module load, so a bad offset table
fails on the first test that imports it rather than halfway through writing to a
radio.

`StructDef` gives you:

| Member | Notes |
|---|---|
| `size` | The declared record size. |
| `read(buf, off?)` | Decode the whole record. |
| `write(buf, off, patch)` | Applies **only** the keys present in `patch`. Bytes outside those fields are untouched. This is the guarantee that lets undecoded bytes survive. |
| `view(buf, off?)` | A live accessor - property reads and writes hit the buffer directly. |
| `ranges()` | Merged, sorted `[start, end)` ranges this record owns, relative to its start. This is what feeds `ownedRanges`. |
| `coverage()` | `{ named, total, gaps, ratio }`. Report it; do not inflate it. |
| `blank(fill)` | A fresh record filled with `fill` - an erased slot - not an implicit zero buffer. Use `schema.memory.eraseFill`. |

`Plain<S>` is assignable to `Patch<S>`, so `write(buf, 0, read(buf))`
typechecks. That is exactly the round-trip the invariant test exercises.

## Fields available

From `lib/codec/fields.ts`:

- Integers: `u8`, `i8`, `u16le`, `u24le`, `u32le`, `u16be`, `u24be`, `u32be`
- Raw: `bytes(n)`
- Text: `ascii(n, opts)`, `utf16le(nBytes, { pad })`
- Bit fields: `bits(base, map)` where the map is
  `Record<string, [lsb, width]>`, and `chirpBits(sizeBytes, declarations)`,
  which takes bit orders in the same MSB-first order CHIRP writes them
- Scaling: `scaled(base, factor, sentinels)` - sentinels are raw values that
  must not be multiplied
- BCD: `bcdLE(n)`, `bcdBE(n)`, `bcdFreqLE(n)`, and `lbcdFreq` as an alias
- Enums: `enumOf(base, table)` - returns the string, or the raw number for a
  value not in the table, so an unknown value survives rather than being coerced
- Repetition: `array(...)`

Use `chirpBits` when transcribing from CHIRP so the declaration order matches
the source and the transcription stays checkable line by line. The UV-82's
`wide` bit was inverted relative to the obvious reading, and only the field-by-
field comparison against CHIRP's own parser caught it.

## Range helpers in `struct.ts`

- `applyRanges(...)` - merge only the claimed ranges of one buffer onto another
- `diffRanges(a, b)` - the `[start, end)` ranges where two buffers differ
- `rangesContain(ranges, probe)` - is a probe range fully inside the claim
- `equalBytes(a, b)`

`lib/codec/checksum.ts` has `crc16Xmodem`, `checksum8`, `toHex`, `fromHex`,
`hexDump` and `sha256Hex`. Use `sha256Hex` for the numbers you quote in the
protocol doc.

## Deriving `ownedRanges` from a layout

`ownedRanges(regionStart)` returns the byte ranges, relative to a region's
start, that the driver claims to understand and is therefore willing to
overwrite. Build it from the structs' own `ranges()` rather than by hand, offset
by each record's base address.

Three consumers depend on it:

1. The diff annotator treats a change outside these ranges as a **blocking**
   error, `unowned-bytes-changed`, whose message says the defect is in boofwang.
2. The DM-32UV writer merges only these ranges onto the live page.
3. The coverage report is derived from them.

**Never widen a range to silence a failure.** It is telling you the encoder is
writing somewhere it did not claim.

### Rounding up to the write unit

There is one legitimate reason to claim more than a struct covers: the block the
writer actually transmits. The UV-82's settings struct is `0x2E` bytes, and
`SETTINGS_CLAIM` is `0x30`:

> Blocks go to the radio as 16 bytes at an address, so a claim that ended
> mid-block would have the writer sending bytes it never said it understood.

The two bytes past the struct are carried through from the radio and never
written, so rounding up claims nothing the encoder then changes. That is the
test: rounding up is fine only when the encoder provably does not touch the
extra bytes.

## Address conventions

Pick the reference's convention and say so in a comment. The UV-82 layout keeps
CHIRP's, where every offset is relative to the start of the image, which begins
with 8 ident bytes - so the channel table sits at image `0x0008` while the radio
itself calls that address `0x0000`. Keeping CHIRP's numbers means they can be
compared with the source directly. Mixing conventions silently is how a whole
table lands 8 bytes off.

## Leaving bytes undecoded is correct

Never guess a field name for a byte nobody has explained. An undecoded byte is
carried through by `encode(doc, base)` and survives untouched. A wrongly named
one gets written. The DM-32UV has 22 of 59 allocated blocks with no documented
meaning and they round-trip perfectly, because nothing claims them.

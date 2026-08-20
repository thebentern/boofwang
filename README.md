# boofwang

A codeplug editor and programmer that runs in your browser, talking to radios
over the [Web Serial API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Serial_API).
No install, no account, no server — a CHIRP alternative you open as a URL.

**Target radios**

| Radio | Memory | Read | Write |
|---|---|---|---|
| Quansheng UV-K5 | 200 channels, analog, 8 KB EEPROM | Yes | Not yet |
| Baofeng UV-5R Mini | 999 channels, analog, 33 KB image | Not yet | Not yet |
| Baofeng DM-32UV | 4000 channels, DMR, zones/talkgroups/AES keys | Not yet | Not yet |

CHIRP has no DM-32UV driver at all, and Baofeng's own CPS is Windows-only.

> **Status.** boofwang can read a UV-K5, decode its channels, and export them as
> CHIRP-compatible CSV, as a `.bwp` codeplug, or as a raw `.bin`. **No radio can
> be written to yet** — `encode()` throws and every schema reports `write:
> false`, so the upload button has nothing to bind to. The safety machinery
> described below is built where it is stated as built and described as planned
> where it is not; see the write-path note in that section.

## Development

Requires [pnpm](https://pnpm.io/). Node is pinned to 24.11.1 via `.npmrc`
(`use-node-version`), so pnpm fetches the right runtime itself.

```bash
pnpm install
pnpm dev            # http://localhost:3000
pnpm test           # unit tests (no hardware needed)
pnpm typecheck
pnpm lint
pnpm build          # static output in .output/public
```

Radio protocol tests that need hardware plugged in are skipped unless
`BOOFWANG_HW=1` is set; everything else runs against recorded traces and a
scripted fake serial port, so the whole stack is testable with nothing
connected.

To pull down the upstream references the drivers are transcribed from (CHIRP
sources, the DM-32UV protocol specification) into the git-ignored `reference/`
directory:

```bash
./scripts/fetch-reference.sh
```

## Driving a real radio from an automated session

Web Serial deliberately requires a person to answer a native port chooser, which
means an automated session can never obtain a port on its own. That is the right
design for a tool that talks to hardware, and it also means iterating on a
driver against a real radio would otherwise need a human clicking a dialog on
every run.

`tools/serial-bridge` closes that loop. It is a localhost WebSocket-to-serial
process, run by hand, that hands the browser a `SerialPortLike` backed by a
socket instead of `navigator.serial`:

```bash
pnpm bridge                       # in one terminal
pnpm dev                          # in another
# then open http://localhost:3000/boofwang/?bridge
```

Everything below the `SerialPortLike` seam — transport framing, timeouts, the
protocol, the driver, decode, and the whole UI — is the shipping code path. What
it does **not** exercise is the roughly thirty lines of `navigator.serial` glue
in `app/composables/useWebSerial.ts`, which still needs a human and a real port.
That gap is why this is a development aid and not a feature: the bridge binds to
127.0.0.1 only, rejects non-localhost origins, is never started by the app or
the build, and the client side is gated behind both a dev build and an explicit
`?bridge` query parameter.

It earns its keep. Two bugs that every synthetic test had passed showed up
within minutes of the first real read: boofwang was verifying a reply checksum
the radio does not compute, and inventing a scan-skip flag the radio does not
have.

## How it is put together

```
lib/          framework-agnostic core — no Vue, no Nuxt, testable in plain Node
  codec/      binary struct DSL: explicit offsets, partial writes, coverage reporting
  transport/  Web Serial: byte-accumulating reads, timeouts, teardown, fakes, trace recorder
  platform/   pure browser-capability checks
app/          Nuxt 4 UI, driven by radio schemas rather than per-radio code
```

The `lib/` boundary is enforced by ESLint (`no-restricted-imports`) and by a
Vitest project running in a DOM-less Node environment, so it cannot drift.

### The property everything else rests on

`driver.encode(doc, base)` always takes the bytes read off the radio as its
base and overwrites only the byte ranges it declares it understands. There is
no `encode(doc)`. Unknown bytes survive a read/edit/write cycle because they
are never allocated fresh — which matters most on the DM-32UV, where roughly 31
of its 71 memory pages are still undocumented.

The invariant is tested directly: `encode(decode(image), image)` must be
byte-identical to `image`, for every fixture.

## Safety

Programming a radio wrongly can brick it, and programming the wrong frequency
can break the law.

**In place today:**

- **Every read is backed up automatically**, in the browser, before you touch
  anything. Calibration data is captured too — a backup that cannot restore it
  is not a backup — while living in a region flagged read-only so it can never
  be sent back.
- **Receive-only channels are recognised and preserved.** The UV-K5 has no
  transmit-inhibit bit; CHIRP fakes one by parking the transmit frequency at
  0 MHz, and boofwang decodes that rather than silently reading such a channel
  as transmit-capable. It exports as CHIRP's `Duplex=off`.
- **Transmitting where you may not is an error, not a note.** A channel whose
  transmit frequency lands in a receive-only allocation — the air band, for
  instance — is flagged before anything reaches a radio.
- **Unrecognised firmware is read-only but still readable.** Refusing to read it
  would be backwards: a backup is exactly what an unsupported firmware needs.
- **A `.bwp` carries its radio's identity and a checksum**, so a codeplug cannot
  be silently written to the wrong radio or after being corrupted.

**Planned, with the write path:**

- A verified backup will be *required* before any write, enforced in the driver
  rather than by a checkbox. (Nothing enforces this yet because nothing can
  write yet.)
- Every upload will show an annotated byte diff first, and a change outside the
  range a driver claims to own will block it — that means the encoder has a bug.
- DM-32UV writes will be staged: read-only, then a dry run that exercises the
  real write path without transmitting, then one memory block at a time behind
  an explicit unlock.

## Licence

GPL-3.0-or-later. See [`LICENSE`](LICENSE), and
[`docs/provenance.md`](docs/provenance.md) for what boofwang derives from and
what it deliberately does not use.

boofwang is an independent project, not affiliated with or endorsed by Baofeng,
Quansheng, or the CHIRP project.

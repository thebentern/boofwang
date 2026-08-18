# boofwang

A codeplug editor and programmer that runs in your browser, talking to radios
over the [Web Serial API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Serial_API).
No install, no account, no server — a CHIRP alternative you open as a URL.

**Target radios**

| Radio | Memory | Status |
|---|---|---|
| Quansheng UV-K5 | 200 channels, analog, 8 KB EEPROM | Not yet implemented |
| Baofeng UV-5R Mini | 999 channels, analog, 33 KB image | Not yet implemented |
| Baofeng DM-32UV | 4000 channels, DMR, zones/talkgroups/AES keys | Not yet implemented |

CHIRP has no DM-32UV driver at all, and Baofeng's own CPS is Windows-only.

> **Status: Phase 0.** The foundations — binary codec, serial transport, app
> shell and CI — are in place and tested. No radio driver has landed yet, so
> nothing can read or write a radio today. The landing page says so rather than
> advertising buttons that do nothing.

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
can break the law. So:

- **A verified backup is required before any write**, enforced in the driver
  rather than by a checkbox in the UI.
- **Every upload shows an annotated byte diff first.** A change outside the
  range a driver claims to own blocks the write — that means the encoder has a
  bug.
- **Receive-only presets cannot be switched to transmit.** Weather, marine,
  aviation and public-safety bundles are forced receive-only at the source. On
  radios with no per-channel transmit inhibit, boofwang says so loudly instead
  of quietly programming a channel you can key up.
- **DM-32UV writes are staged**: read-only, then a dry run that exercises the
  real write path without transmitting, then one memory block at a time behind
  an explicit unlock.

## Licence

GPL-3.0-or-later. See [`LICENSE`](LICENSE), and
[`docs/provenance.md`](docs/provenance.md) for what boofwang derives from and
what it deliberately does not use.

boofwang is an independent project, not affiliated with or endorsed by Baofeng,
Quansheng, or the CHIRP project.

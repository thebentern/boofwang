# The wire: protocol, transports and the fakes

Your `lib/radios/<id>/protocol.ts` is the only file that knows about bytes on
the wire. It talks to a `Transport`, never to a serial port directly.

## The `Transport` interface

From `lib/transport/transport.ts`:

```ts
open(opts: SerialOpenOptions): Promise<void>
close(): Promise<void>
write(data: Uint8Array, opts?: ReadOpts): Promise<void>
readExactly(n: number, opts?: ReadOpts): Promise<Uint8Array>
readUntil(delim: Uint8Array, opts?: ReadOpts & { max?: number }): Promise<Uint8Array>
resync(quietMs?: number, opts?: ReadOpts): Promise<Uint8Array>
setSignals(signals: { dataTerminalReady?, requestToSend?, break? }): Promise<void>
onDisconnect(cb: (e: Error) => void): () => void
peekHex(n?: number): string
```

`TransportState` is `'closed' | 'open' | 'desynced' | 'disconnected'`.
`TransportKind` is `'serial' | 'bluetooth'`. `DEFAULT_READ_TIMEOUT_MS` is 3000;
the driver's own default is `DEFAULT_DRIVER_TIMEOUT_MS`, 4000.

`peekHex` exists so an error can carry the actual bytes. Use it.

## Transport errors

From `lib/transport/errors.ts`, all extending `TransportError`:
`TransportClosedError`, `TransportTimeoutError`, `DesyncedError`,
`DeviceDisconnectedError`, `TransferAbortedError`, `ReadLimitError`,
`ProtocolError`.

Throw `ProtocolError` for a frame that arrived but was wrong. Let timeouts
surface as `TransportTimeoutError` and translate them into
`NoRadioResponseError` at the driver boundary, where you can say what was being
attempted.

## Writing `protocol.ts`

Keep it to: the ident magic, the handshake, frame construction and parsing, the
block read and block write commands, and any radio-specific quirk. Export
constants rather than burying literals - other modules and the tests import
them (`IDENT_SIZE`, `IMAGE_SIZE`, `PAGE_SIZE`, `MAGIC_*`, `BAUD_RATE`).

Things every existing protocol module got wrong once:

- **The handshake can be stateful.** A second `PSEARCH` on an already-
  handshaken DM-32UV gets no reply at all. Pass `ctx.ident` forward rather than
  re-identifying inside `writeImage`.
- **First contact can be refused.** After sitting idle the UV-5G answers the
  first magic of a session with `0xfe`, every time, then acknowledges the next
  attempt - the first exchange wakes it rather than reaching it. `identify`
  drains the line and retries up to three times, which is the structure CHIRP's
  `_ident_radio` has.
- **Partial blocks happen.** One UV-5G read in three stalled mid-block, 27 of 64
  payload bytes, and succeeded on retry with an identical image. Retry before
  suspecting the radio.
- **An echoed command is a perfect frame.** Correct header, correct footer,
  valid checksum, so every layer below accepts it. Detect it and throw
  `LoopbackDetectedError`. Observed cause: a counterfeit Prolific PL2303.

## Bluetooth

Only add `'bluetooth'` to `capabilities.transports` when the radio has a BLE
module of its own and you have read its service UUID off a real advertising
radio.

`lib/transport/bluetooth-uuids.ts` opens with a banner you should take
literally: every UUID in the file is a guess until its `verified` flag says
otherwise. Exactly one profile is proven, `UV5RM_BLE`, by a real radio answering
its own identify magic. `NORDIC_UART` is a reasonable default and nothing more,
and the reasoning is written out so nobody assumes it was verified.

`navigator.bluetooth.requestDevice()` filters the chooser on the service UUID,
so a wrong number means the radio never appears - indistinguishable from a radio
that is switched off. This project misdiagnosed that twice, once discovering the
chooser had been filtering on Nordic UART the whole time.

To get the real number: put a phone next to the radio with nRF Connect, or use
`bluetoothctl` or `chrome://bluetooth-internals`, pair, and read the service and
characteristic list. Then add a `BluetoothProfile` to `KNOWN_PROFILES` with
`verified` set honestly, and a scan filter entry in
`lib/transport/bluetooth-scan-filter.ts`.

A clip-on BLE-to-serial dongle is a different thing entirely - see
`capabilities.dongle` in `references/capabilities.md` and
`docs/protocols/ble-dongle.md`.

## Testing without hardware

This is not optional: no test in the default run may require a radio.

`lib/transport/fake-serial-port.ts` gives you `FakeSerialPort`, a `Responder`
function type, and `scriptedResponder(script)` taking `Exchange[]` - a list of
written bytes and the reply to give. Drive your whole protocol with it. The
existing write specs use it to prove the gate refuses without a backup, refuses
another radio's image, and writes nothing when the radio already holds the
image.

`lib/transport/fake-ble-client.ts` and `fake-gatt.ts` do the same for Bluetooth.

`lib/transport/recording-transport.ts` wraps a real transport and records a
`Trace` of every exchange. Use it during a hardware session, then replay the
trace as a scripted responder so the session becomes a regression test.

## Which existing protocol to read first

| Your radio | Read |
|---|---|
| Classic UV-5R family, 9600 baud, plain 16-byte blocks | `lib/radios/uv82/protocol.ts`, then `uv5g/protocol.ts` for how a sibling adds only its magic |
| UV-17 Pro family, 115200 baud, obfuscated 64-byte blocks | `lib/radios/uv5rmini/protocol.ts` |
| Quansheng, 38400 baud, XOR-obfuscated framed commands | `lib/radios/uvk5/protocol.ts` |
| DMR, page-oriented, stateful handshake | `lib/radios/dm32uv/protocol.ts` |

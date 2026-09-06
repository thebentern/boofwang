# The two contracts a radio must satisfy

Source of truth is `lib/radio/driver.ts` and `lib/radio/schema.ts`. Read them.
This file exists so you know what you are looking at and which members you can
omit.

## `RadioDriver`

Every member below is required unless marked optional. The comments in
`driver.ts` carry the reasons and the recorded failures - do not skip them.

### Identity

| Member | Notes |
|---|---|
| `id: RadioId` | Must already be in the `RadioId` union in `lib/model/codeplug.ts`. |
| `schema: RadioSchema` | The UI renders from this. It must match what the driver enforces. |
| `serial: SerialOpenOptions` | Baud and framing. 9600 for the classic UV-5R family, 115200 for UV-17 Pro family. |
| `abortPolicy` | `'reset-command'` if the radio can be told to leave programming mode, `'power-cycle'` if not. Only the UV-K5 has a reset command. Getting this wrong leaves a radio stuck in programming mode with the UI saying nothing. |
| `writeBlockBytes` | The unit a write is sent in. 128 bytes on the UV-K5, a 4 KiB page on the DM-32UV. The confirmation quotes it, so "1 block" must mean something honest. |

### Discovery and handshake

| Member | Notes |
|---|---|
| `match(info)` | `'likely' \| 'possible' \| 'no'` from USB VID/PID. A hint for ordering the port picker, never an identification - the CH340 is in countless unrelated devices. |
| `identify(t, ctx?)` | Returns `IdentifyResult`. Must set `caps.read` / `caps.write` and a `reason` when either is false. Throw `UnsupportedFirmwareError` for a layout you do not know, and still offer the read. |
| `unitFingerprint(image)` | `Promise<string \| null>`. Hash factory per-unit data, typically calibration. `null` means "cannot tell" and callers must never read it as "matches". `identHash` covers model, firmware and build date only, so two identical radios hash the same without this. |

### Transfer

| Member | Notes |
|---|---|
| `readImage(t, ident, ctx?)` | Report progress through `ctx.progress`, honor `ctx.signal`. |
| `writeImage(t, image, ctx?)` | Unbypassable enforcement. Throws `BackupRequiredError` with no backup or a backup from another radio. Every block written is read back and compared before the next is sent. |
| `decode(image)` | `RadioImage -> Codeplug`. |
| `encode(doc, base)` | Patches a clone of `base`. There is no `encode(doc)`. |
| `validate(doc)` | Returns `Diagnostic[]`. Severity `'error'` blocks the write through the gate. |
| `ownedRanges(regionStart, image?)` | The bytes this driver claims to understand, relative to a region start. `image` is optional and most drivers ignore it. |

### Optional members

| Member | When you need it |
|---|---|
| `rfFor(doc)` | Only when one radio has more than one firmware with different RF profiles. Omitted, callers fall back to `schema.rf`. The UV-K5 needs it: egzumer receives where stock does not and has twenty-four tuning steps against stock's six. |
| `storesSlot(image, slot)` | Only when channel memory is allocated in blocks as the user programs into it, so some slot numbers have no memory at all. The DM-32UV needs it. A flat channel bank has nothing to answer and omits it. |

### `DriverCtx` fields worth knowing

- `baseImage` - what the radio held before this edit, so a write can send only
  the blocks that differ.
- `ident` - the identification from the current session. Supply it rather than
  re-handshaking: the DM-32UV's handshake is stateful, and a second `PSEARCH` on
  an already-handshaken port gets no reply at all. Re-identifying inside
  `writeImage` broke every write while looking exactly like a radio that was not
  ready.
- `dryRun` - reads happen for real, writes are recorded and dropped.
- `unlocked` - feature keys the user has explicitly unlocked, for
  `capabilities.writeRequiresUnlock`.

### Error types, and when to throw which

All extend `DriverError`, all in `lib/radio/driver.ts`.

| Error | Throw when |
|---|---|
| `UnsupportedFirmwareError` | The firmware string is not one you have a layout for. Read still works. |
| `RadioInProgrammingModeError` | The radio is in bootloader mode. |
| `LoopbackDetectedError` | The line is returning boofwang's own bytes. An echoed command is a structurally perfect frame, so every layer below happily accepts it. Observed cause: a counterfeit Prolific PL2303. |
| `NoRadioResponseError` | Silence where a reply was due. |
| `ImageRadioMismatchError` | The image was read from a different model than the one on the cable. |
| `BackupRequiredError` | No verified backup of this radio exists for this session. |
| `WriteBlockedError` | A write this driver will not perform. Takes the whole sentence, not a subject. |
| `WriteVerifyError` | A block read back does not match what was sent. Always fatal. Pass `verifiedAfterSending` truthfully - two drivers write everything then verify in a second pass. |
| `RadioChangedError` | A fresh read disagrees with the base image the edit was built on. |
| `TxInhibitUnsupportedError` | A channel is marked receive-only and `rf.txInhibit` is `false`. |

Errors state what happened, as facts. Never "failed to", never an apology. A
developer-facing error carries the actual bytes.

## `RadioSchema`

The UI is a pure function of this. If rendering your radio needs a change under
`app/`, this type is missing something.

### Top level

`id`, `vendor`, `model`, `aliases`, and `status` - one of `'planned'`,
`'read-only'`, `'beta'`, `'stable'`. Ship `read-only` until a write has been
verified on hardware.

### `capabilities`

| Field | Notes |
|---|---|
| `read`, `write` | Required booleans. |
| `transports` | The carriers this radio can be reached over. `'bluetooth'` means the radio has a BLE module of its own, established by enumerating a real unit. Offering it without a real service UUID opens a chooser that lists nothing. |
| `writeTransports` | Optional subset of `transports` that the write path is verified over. Omitted means all of them. Exists because the gate and the driver disagreed about it for a day. |
| `dongle: 'k2'` | Optional. The physical jack a clip-on BLE-to-serial dongle fits. Deliberately not an entry in `transports` - the radio never knows the cable became a radio link. |
| `dongleProven: true` | Optional, and a separate claim: a codeplug has actually come off **this** radio through a dongle. A BT-A1D read a whole UV-5R Mini and drew nothing from a UV-82 on the same day. |
| `writeRequiresUnlock` | Optional string. Non-empty when writing needs an explicit per-feature unlock. |
| `writesWholeImage` | Optional. Set when the radio erases a flash page before programming, so a sparse write wipes everything sharing that page. |
| `writeScope` | Optional plain-English sentence for when a write cannot reach the whole codeplug. Used by the restore screen and the write gate. |

### `memory`

`channelCount`, `firstIndex`, `specialChannels`, `nameLength`, `nameCharset`,
and `eraseFill` - the byte an erased record is filled with, explicit because it
differs per radio.

### `rf`

`bands` (each with `txAllowed`, false for receive-only allocations),
`modulations`, `bandwidths`, `powerLevels`, `tuningSteps` in hertz as integers,
`duplexes`, `toneModes`, `ctcssDeciHz`, `dtcsCodes`, `canSkip`, `hasRxDtcs`,
`hasCtone`, and `txInhibit`.

Band order matters: every consumer takes the first band containing a frequency.
The UV-5G lists its GMRS transmit windows before the wide receive spans for
exactly that reason.

`txInhibit` is `false` or `{ mechanism: string }`. `false` means an RX-only
channel must be refused rather than programmed as transmit-capable. The UV-K5
has no dedicated bit and instead parks the transmit frequency at 0 MHz, which is
what `mechanism` records.

### `features`

Each is `false` or a shape: `dmr`, `zones`, `talkGroups`, `contacts`,
`rxGroups`, `scanLists`, `radioIds`, `messages`, `encryption`.

These are feature flags, not "does this codeplug happen to have any". A radio
with no message memory must not be offered the control at all - once it was, and
a typed message was accepted and then dropped by the encoder while the write
reported success.

### `extraFields` and `settings`

`extraFields` are per-radio channel fields with no cross-radio meaning, rendered
generically. `settings` is an array of `SettingGroup`.

A `FieldSpec` has `key`, `label`, `type` (`bool`, `int`, `enum`, `string`,
`freq`, `tone`, `hex`), and optionally `help`, `options`, `min`, `max`,
`maxLength`, `icon`, and `channelRef`.

`channelRef: true` declares that the field holds a channel number, so
renumbering must move it. Declared rather than guessed from the label: the
DM-32UV's eight APRS report channels are plain `int` fields between 0 and 4000,
and a sort that renumbered the bank left all eight reporting on whatever channel
had landed on their old number.

`SettingGroup.layouts` restricts a group to particular image layouts. Absent
means every layout, which is right for a radio that has only one. A group added
for stock UV-K5 firmware and rendered against egzumer is a form full of controls
that silently do not exist on the radio in front of the user.

Any `icon` you name must be in `SCHEMA_ICONS` in `nuxt.config.ts`.

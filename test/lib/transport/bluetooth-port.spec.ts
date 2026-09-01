// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest'
import { BluetoothPort, BluetoothLinkError, type BluetoothLink } from '#core/transport/bluetooth-port.js'
import { FakeGattLink } from '#core/transport/fake-gatt.js'
import { SerialTransport } from '#core/transport/serial-transport.js'
import { RecordingTransport } from '#core/transport/recording-transport.js'
import { DeviceDisconnectedError } from '#core/transport/errors.js'
import {
  BL1_DONGLE_PROFILES,
  BluetoothUuidError,
  DEFAULT_PROFILE,
  KNOWN_PROFILES,
  NORDIC_UART,
  TIDRADIO_BL1_FF00,
  TIDRADIO_BL1_FFE0,
  TIDRADIO_FF22_PER_BYTE,
  UV5RM_AE30_ECHO,
  UV5RM_BLE,
  bluetoothProfile,
  normaliseUuid,
  parseBluetoothProfile,
  resetBluetoothProfile,
  setBluetoothProfile,
} from '#core/transport/bluetooth-uuids.js'

const b = (...xs: number[]) => Uint8Array.from(xs)
const OPEN = { baudRate: 115_200 }

async function opened(opts?: ConstructorParameters<typeof FakeGattLink>[0], portOpts?: { maxWriteBytes?: number }) {
  const link = new FakeGattLink(opts)
  const port = new BluetoothPort(link, portOpts ?? {})
  const t = new SerialTransport(port)
  await t.open(OPEN)
  return { link, port, t }
}

describe('the port looks like a serial port to everything above it', () => {
  it('opens, starts notifications and exposes both streams', async () => {
    const { link, port, t } = await opened()
    expect(t.state).toBe('open')
    expect(link.notificationsStarted).toBe(1)
    expect(port.readable).not.toBeNull()
    expect(port.writable).not.toBeNull()
    await t.close()
  })

  it('declares itself as bluetooth, through the transport and the recorder', async () => {
    // This is the flag a driver reads to pick its block size, and it has to
    // survive both wrappers or the driver silently gets the cable behaviour.
    const { t } = await opened()
    expect(t.kind).toBe('bluetooth')
    expect(new RecordingTransport(t).kind).toBe('bluetooth')
    await t.close()
  })

  it('leaves a cable transport saying serial', async () => {
    const { FakeSerialPort } = await import('#core/transport/fake-serial-port.js')
    const t = new SerialTransport(new FakeSerialPort())
    await t.open(OPEN)
    expect(t.kind).toBe('serial')
    await t.close()
  })

  it('refuses a second open', async () => {
    const { t, port } = await opened()
    await expect(port.open(OPEN)).rejects.toThrow(BluetoothLinkError)
    await t.close()
  })
})

describe('framing: what the radio notifies becomes a byte stream', () => {
  it('reassembles a reply that arrived in MTU-sized fragments', async () => {
    // The whole reason `ByteQueue` exists. A 132-byte block reply crosses seven
    // notifications, and no layer above this may ever see that.
    const { link, t } = await opened({ notifyChunk: 20 })
    const reply = Uint8Array.from({ length: 132 }, (_, i) => i & 0xff)
    link.push(reply)
    expect(await t.readExactly(132)).toEqual(reply)
    await t.close()
  })

  it('serves a read that spans several notifications and leaves the remainder', async () => {
    const { link, t } = await opened({ notifyChunk: 4 })
    link.push(b(1, 2, 3, 4, 5, 6, 7, 8, 9, 10))
    expect(await t.readExactly(6)).toEqual(b(1, 2, 3, 4, 5, 6))
    expect(await t.readExactly(4)).toEqual(b(7, 8, 9, 10))
    await t.close()
  })

  it('finds a delimiter that straddles two notifications', async () => {
    const { link, t } = await opened({ notifyChunk: 3 })
    link.push(b(0x11, 0x22, 0x33, 0x44, 0xaa, 0xbb, 0xcc))
    expect(await t.readUntil(b(0xaa, 0xbb))).toEqual(b(0x11, 0x22, 0x33, 0x44, 0xaa, 0xbb))
    await t.close()
  })

  it('copies each notification, because the stack reuses the buffer', async () => {
    /*
     * A `DataView` handed to a notification handler points into memory the
     * Bluetooth stack owns and overwrites. Keeping the view rather than copying
     * would mean the second notification silently rewrote the first one's bytes
     * while they sat unread in the queue - corruption that reads as a faulty
     * radio and would never be reproduced on the bench.
     *
     * The fake reuses one backing buffer for exactly this reason.
     */
    const { link, t } = await opened({ notifyChunk: 2 })
    link.push(b(0xde, 0xad, 0xbe, 0xef))
    expect(await t.readExactly(4)).toEqual(b(0xde, 0xad, 0xbe, 0xef))
    await t.close()
  })

  it('ignores an empty notification rather than enqueuing nothing', async () => {
    const { link, t } = await opened()
    link.push(new Uint8Array(0))
    expect(t.peekHex()).toBe('')
    link.push(b(0x06))
    expect(await t.readExactly(1)).toEqual(b(0x06))
    await t.close()
  })
})

describe('framing: what a driver writes becomes GATT writes', () => {
  it('splits a frame at the MTU payload', async () => {
    // A 132-byte UV-5R Mini write frame does not fit in one GATT write, and a
    // peripheral with the default MTU rejects anything past 20 bytes. The fake
    // enforces that, so an unsplit write fails here rather than on a radio.
    const { link, t } = await opened({ maxWriteBytes: 20 })
    const frame = Uint8Array.from({ length: 132 }, (_, i) => i & 0xff)
    await t.write(frame)
    expect(link.writes.map((w) => w.length)).toEqual([20, 20, 20, 20, 20, 20, 12])
    expect(link.writtenBytes()).toEqual(frame)
    await t.close()
  })

  it('honours a larger MTU when one is configured', async () => {
    const { link, t } = await opened({ maxWriteBytes: 244 }, { maxWriteBytes: 244 })
    await t.write(Uint8Array.from({ length: 132 }, (_, i) => i & 0xff))
    expect(link.writes).toHaveLength(1)
    await t.close()
  })

  it('sends a short frame whole', async () => {
    const { link, t } = await opened()
    await t.write(b(0x46))
    expect(link.writes).toEqual([b(0x46)])
    await t.close()
  })

  it('copies what it was handed, so a caller may reuse its buffer', async () => {
    // Two reasons at once: the transport's contract lets a caller reuse the
    // array the moment write() resolves, and Chrome has detached the buffer
    // passed to a GATT write.
    const { link, t } = await opened()
    const frame = b(1, 2, 3, 4)
    await t.write(frame)
    frame.fill(0xff)
    expect(link.writes[0]).toEqual(b(1, 2, 3, 4))
    await t.close()
  })
})

describe('choosing how to write', () => {
  it('prefers the acknowledged write, because an unacknowledged one has no flow control', async () => {
    const calls: string[] = []
    const link: BluetoothLink = {
      write: {
        properties: { write: true, writeWithoutResponse: true, notify: true },
        writeValueWithResponse: async () => void calls.push('with'),
        writeValueWithoutResponse: async () => void calls.push('without'),
        startNotifications: async () => undefined,
        addEventListener: () => {},
        removeEventListener: () => {},
      },
      notify: {
        properties: { notify: true },
        startNotifications: async () => undefined,
        addEventListener: () => {},
        removeEventListener: () => {},
      },
    }
    const port = new BluetoothPort(link)
    await port.open(OPEN)
    const writer = port.writable!.getWriter()
    await writer.write(b(1))
    expect(calls).toEqual(['with'])
    writer.releaseLock()
    await port.close()
  })

  it('falls back to the unacknowledged write when that is all the characteristic offers', async () => {
    const calls: string[] = []
    const link: BluetoothLink = {
      write: {
        properties: { write: false, writeWithoutResponse: true },
        writeValueWithResponse: async () => void calls.push('with'),
        writeValueWithoutResponse: async () => void calls.push('without'),
        startNotifications: async () => undefined,
        addEventListener: () => {},
        removeEventListener: () => {},
      },
      notify: {
        properties: { notify: true },
        startNotifications: async () => undefined,
        addEventListener: () => {},
        removeEventListener: () => {},
      },
    }
    const port = new BluetoothPort(link)
    await port.open(OPEN)
    const writer = port.writable!.getWriter()
    await writer.write(b(1))
    expect(calls).toEqual(['without'])
    writer.releaseLock()
    await port.close()
  })
})

describe('when the UUIDs are wrong, say so at open', () => {
  const inert = {
    startNotifications: async () => undefined,
    addEventListener: () => {},
    removeEventListener: () => {},
  }

  it('refuses a characteristic that cannot notify', async () => {
    // Failing here rather than at the first read is the difference between
    // "the UUIDs are probably wrong" and "the radio did not respond", and only
    // one of those sends someone to the right place.
    const port = new BluetoothPort({
      write: { ...inert, properties: { write: true }, writeValueWithResponse: async () => {} },
      notify: { ...inert, uuid: 'abc', properties: { notify: false, indicate: false } },
    })
    await expect(port.open(OPEN)).rejects.toThrow(/does not notify/)
  })

  it('refuses a characteristic that cannot be written to', async () => {
    const port = new BluetoothPort({
      write: { ...inert, uuid: 'def', properties: { write: true } },
      notify: { ...inert, properties: { notify: true } },
    })
    await expect(port.open(OPEN)).rejects.toThrow(/cannot be written to/)
  })

  it('names the file to fix, since the numbers live in exactly one place', async () => {
    const port = new BluetoothPort({
      write: { ...inert, properties: { write: true } },
      notify: { ...inert, properties: { notify: true } },
    })
    await expect(port.open(OPEN)).rejects.toThrow(/bluetooth-uuids\.ts/)
  })

  it('leaves nothing half-open when notifications are refused', async () => {
    // The caller is entitled to try another profile on the same device, which a
    // port holding a stale listener would poison.
    let listeners = 0
    const port = new BluetoothPort({
      write: { ...inert, properties: { write: true }, writeValueWithResponse: async () => {} },
      notify: {
        properties: { notify: true },
        startNotifications: async () => {
          throw new Error('GATT operation not permitted')
        },
        addEventListener: () => {
          listeners++
        },
        removeEventListener: () => {
          listeners--
        },
      },
    })
    await expect(port.open(OPEN)).rejects.toThrow(/refused to send notifications/)
    expect(listeners).toBe(0)
    expect(port.readable).toBeNull()
  })
})

describe('losing the radio', () => {
  it('reports a GATT drop as a disconnect, not as a timeout', async () => {
    const { link, t } = await opened()
    const pending = t.readExactly(4, { timeoutMs: 5000 })
    link.drop()
    await expect(pending).rejects.toThrow(DeviceDisconnectedError)
    expect(t.state).toBe('disconnected')
    await t.close()
  })

  it('does not report a drop when the disconnect was ours', async () => {
    const { link, t } = await opened()
    await t.close()
    expect(link.connected).toBe(false)
  })
})

describe('closing', () => {
  it('stops notifications, drops the listener and disconnects', async () => {
    const { link, t } = await opened()
    await t.close()
    expect(link.notificationsStopped).toBe(1)
    expect(link.listenerCount).toBe(0)
    expect(link.connected).toBe(false)
  })

  it('leaves the link up when asked to', async () => {
    // For a caller that owns the GATT connection and means to reuse it.
    const link = new FakeGattLink()
    const port = new BluetoothPort(link, { disconnectOnClose: false })
    const t = new SerialTransport(port)
    await t.open(OPEN)
    await t.close()
    expect(link.connected).toBe(true)
  })

  it('is idempotent', async () => {
    const { t, port } = await opened()
    await t.close()
    await expect(port.close()).resolves.toBeUndefined()
  })
})

describe('the UUIDs themselves', () => {
  it('marks a profile verified only where a radio has answered', () => {
    // The connect screen reads this flag to decide whether it may describe
    // Bluetooth as working. FFE0 earned it by replying 06 to the identify
    // magic; Nordic UART is still an untested convention and stays false.
    expect(UV5RM_BLE.verified).toBe(true)
    expect(NORDIC_UART.verified).toBe(false)
  })

  it('defaults to the profile a radio actually answered on', () => {
    // Established by sending the radio its own identify magic on each writable
    // characteristic: FFE0 replied 06 and nothing else did.
    expect(bluetoothProfile()).toBe(UV5RM_BLE)
    expect(UV5RM_BLE.service).toBe('0000ffe0-0000-1000-8000-00805f9b34fb')
    expect(UV5RM_BLE.write).toBe('0000ffe1-0000-1000-8000-00805f9b34fb')
    expect(UV5RM_BLE.notify).toBe('0000ffe1-0000-1000-8000-00805f9b34fb')
    expect(UV5RM_BLE.verified).toBe(true)
  })

  it('resets to the profile it starts on, not to some other constant', () => {
    /*
     * The bug that made three separate diagnoses wrong.
     *
     * `resetBluetoothProfile` assigned `NORDIC_UART` literally - correct when
     * it was written and Nordic was the default, never revisited once the
     * initialiser became a captured profile. `resolveBluetoothProfile()` calls
     * it on every load carrying no `?ble=` override, which is every ordinary
     * one, so the shipped chooser filtered on a service nobody has ever seen
     * advertised and listed nothing at all, with a radio a foot away.
     *
     * Every "the filter does not match" conclusion drawn before this was
     * measuring Nordic. This is the assertion that would have said so.
     */
    setBluetoothProfile(parseBluetoothProfile('1234,5678'))
    resetBluetoothProfile()
    expect(bluetoothProfile()).toBe(DEFAULT_PROFILE)
    expect(bluetoothProfile()).toBe(UV5RM_BLE)
    expect(bluetoothProfile().id).toBe('uv5rm-ffe0')
  })

  it('carries a name to filter on as well as a service', () => {
    // A service filter matches only a service the device advertises, and FFE0
    // came from a GATT enumeration, which happens after connecting. Whether
    // either reaches this radio is still untested - see the profile.
    expect(UV5RM_BLE.namePrefixes).toContain('walkie')
    expect(UV5RM_BLE.advertisedName).toBe('walkie-talkie')
  })

  it('stops each prefix before any separator', () => {
    // Every character a prefix covers is a character that can be wrong, and a
    // name shown as `walkie-talkie` may hold a hyphen that is not U+002D.
    for (const prefix of UV5RM_BLE.namePrefixes) {
      expect(prefix, `${prefix} reaches past the first word`).toMatch(/^[A-Za-z]+$/)
    }
  })

  it('puts no name on a hand-entered profile', () => {
    // Somebody pasting UUIDs is chasing a radio this build does not know, and
    // a name prefix from a different one would filter theirs straight back out.
    expect(parseBluetoothProfile('ffe0,ffe1').namePrefixes).toEqual([])
  })

  it('never defaults to the AE30 characteristic, which is a loopback', () => {
    // Writing to ae01 returns the bytes just written. A driver pointed there
    // would see its own frames come back - the echo failure this project has
    // already misdiagnosed twice on physical cables. Recorded so nobody
    // promotes it by looking at the enumeration and picking the first service.
    expect(bluetoothProfile().id).not.toBe('uv5rm-ae30-echo')
    expect(UV5RM_AE30_ECHO.verified).toBe(false)
    expect(KNOWN_PROFILES[0]).toBe(UV5RM_BLE)
  })

  it('expands a 16-bit alias, which is how vendors quote them', () => {
    expect(normaliseUuid('FFE0')).toBe('0000ffe0-0000-1000-8000-00805f9b34fb')
    expect(normaliseUuid('0xffe1')).toBe('0000ffe1-0000-1000-8000-00805f9b34fb')
  })

  it('lower-cases a long one rather than rejecting it', () => {
    expect(normaliseUuid('6E400001-B5A3-F393-E0A9-E50E24DCCA9E')).toBe(NORDIC_UART.service)
  })

  it('rejects something that is not a UUID at all', () => {
    // Web Bluetooth throws a TypeError naming neither the value nor the field.
    expect(() => normaliseUuid('nordic')).toThrow(BluetoothUuidError)
  })

  it('parses the three-part override someone with a radio would type', () => {
    const p = parseBluetoothProfile('ffe0, ffe1, ffe2')
    expect(p.service).toBe('0000ffe0-0000-1000-8000-00805f9b34fb')
    expect(p.write).toBe('0000ffe1-0000-1000-8000-00805f9b34fb')
    expect(p.notify).toBe('0000ffe2-0000-1000-8000-00805f9b34fb')
    expect(p.verified).toBe(false)
  })

  it('treats a two-part override as one characteristic in both directions', () => {
    const p = parseBluetoothProfile('ffe0,ffe1')
    expect(p.write).toBe(p.notify)
  })

  it('refuses a spec it cannot make sense of', () => {
    expect(() => parseBluetoothProfile('ffe0')).toThrow(BluetoothUuidError)
    expect(() => parseBluetoothProfile('a,b,c,d')).toThrow(BluetoothUuidError)
  })

  it('can be overridden and put back', () => {
    /*
     * This asserted `NORDIC_UART` for as long as the bug existed, which is how
     * the bug survived two changes of default: the reset was measured against
     * a literal rather than against the profile the module actually starts on,
     * so moving the default moved only half of the pair and the suite stayed
     * green. `DEFAULT_PROFILE` is now the one name for both.
     */
    const custom = parseBluetoothProfile('ffe0,ffe1')
    setBluetoothProfile(custom)
    expect(bluetoothProfile()).toBe(custom)
    resetBluetoothProfile()
    expect(bluetoothProfile()).toBe(DEFAULT_PROFILE)
  })
})

/**
 * The BL-1 dongle candidates: unverified, and every flag has to say so.
 *
 * A real TD-PTT fob was enumerated on 2026-08-31 - service FF00, name
 * `TIDRADIO PTTf816cb-A` - so the primary candidate is no longer a pure
 * guess about the UUIDs. But no radio has answered a handshake through it:
 * FF22 replied to a raw UV-K5 frame with 16 bytes that are not a valid
 * frame, which reads as the dongle's own control channel, not a radio. So
 * the honest record here is unverified, serial-believing, never the default.
 */
describe('the dongle profiles', () => {
  it('mark the FF00 shape verified, because a radio answered through it', () => {
    // A Baofeng BT-A1D carried a whole UV-5R Mini codeplug over FF02/FF01 on
    // 2026-09-01. The FFE0 shape is still a guess: no device has carried
    // anything over it, and the flag has to keep saying so.
    expect(TIDRADIO_BL1_FF00.verified).toBe(true)
    expect(TIDRADIO_BL1_FFE0.verified).toBe(false)
  })

  it('say the radio behind them believes it is on a cable', () => {
    // This is the field that keeps the UV-5R Mini's upload at 0x40 blocks
    // through a dongle. A profile that lost it would rewrite the block size.
    expect(TIDRADIO_BL1_FF00.radioLink).toBe('serial')
    expect(TIDRADIO_BL1_FFE0.radioLink).toBe('serial')
    // And the radio-module profiles say nothing, which means bluetooth.
    expect(UV5RM_BLE.radioLink).toBeUndefined()
  })

  it('lead with the shape a real dongle enumerated as', () => {
    expect(BL1_DONGLE_PROFILES).toEqual([TIDRADIO_BL1_FF00, TIDRADIO_BL1_FFE0])
    // FF00 is the service the TD-PTT fob advertised. The HM-10 FFE0 shape is
    // kept behind it for a unit that carries that instead.
    expect(TIDRADIO_BL1_FF00.service).toBe(normaliseUuid('ff00'))
    // The FFE0 variant is service-identical to the UV-5R Mini's own module -
    // the ambiguity docs/protocols/ble-dongle.md records. It is only ever
    // offered from the dongle candidate list, never resolved by UUID alone.
    expect(TIDRADIO_BL1_FFE0.service).toBe(UV5RM_BLE.service)
  })

  it('aim at the silent pair, not the one that answers a byte per byte', () => {
    /*
     * FF22 replies to everything one byte per byte - 4 in, 4 out; 16 in, 16
     * out - which is a status channel, not a radio. A driver aimed there
     * would see a stream shaped like data and report a protocol error
     * against bytes no radio sent: the AE30 loopback mistake in a new
     * costume. FF02/FF01 is the transparent-looking pair, and its silence is
     * the honest failure.
     */
    expect(TIDRADIO_BL1_FF00.write).toBe(normaliseUuid('ff02'))
    expect(TIDRADIO_BL1_FF00.notify).toBe(normaliseUuid('ff01'))
    expect(TIDRADIO_BL1_FF00.write).not.toBe(TIDRADIO_FF22_PER_BYTE.write)
  })

  it('record the per-byte responder so it is recognised, never tried', () => {
    // Same treatment as UV5RM_AE30_ECHO: present so the next person probing a
    // TIDRADIO dongle, finding the only pair that talks back, has something
    // to read before concluding they found the data path.
    expect(TIDRADIO_FF22_PER_BYTE.verified).toBe(false)
    expect(TIDRADIO_FF22_PER_BYTE.namePrefixes).toEqual([])
    expect(BL1_DONGLE_PROFILES).not.toContain(TIDRADIO_FF22_PER_BYTE)
    expect(DEFAULT_PROFILE).not.toBe(TIDRADIO_FF22_PER_BYTE)
  })

  it('carry the prefix that matched a real device, plus pre-hyphen hedges', () => {
    // `TID` matched `TIDRADIO PTTf816cb-A`. The short forms stay because a
    // name rendered `BL-1` may hold a hyphen that is not U+002D, and a prefix
    // carrying the wrong one matches nothing. Over-matching lists extra
    // chooser rows; under-matching lists nothing.
    expect(TIDRADIO_BL1_FF00.namePrefixes).toContain('TID')
    expect(TIDRADIO_BL1_FF00.namePrefixes).toContain('BL')
    expect(TIDRADIO_BL1_FF00.namePrefixes).toEqual(TIDRADIO_BL1_FFE0.namePrefixes)
  })

  it('filter the chooser on what the dongle advertises, not what it enumerates', () => {
    /*
     * The bug this pins, which shipped and emptied a real chooser.
     *
     * FF00 is where the BF_Writer keeps its characteristics, learned by
     * connecting. BF98 is what it broadcasts. `requestDevice` matches only
     * the broadcast, so a filter built from FF00 listed nothing while the
     * dongle sat a foot away - the empty-chooser failure the header of
     * bluetooth-uuids.ts warns about, committed by trusting an enumeration
     * as an advertisement.
     */
    expect(TIDRADIO_BL1_FF00.service).toBe(normaliseUuid('ff00'))
    expect(TIDRADIO_BL1_FF00.advertisedServices).toContain(normaliseUuid('bf98'))
    // And the fob's own advertisement is still covered.
    expect(TIDRADIO_BL1_FF00.advertisedServices).toContain(normaliseUuid('ff00'))
  })

  it('carry the names both bench devices actually advertised', () => {
    // `BF_Writer_CD4` and `TIDRADIO PTTf816cb-A`. Neither was matched by the
    // original guesses, and the name filter is the hedge that saves a device
    // whose advertised service nobody has recorded.
    expect(TIDRADIO_BL1_FF00.namePrefixes).toContain('BF_Writer')
    expect(TIDRADIO_BL1_FF00.namePrefixes).toContain('TIDRADIO')
  })

  it('never become the default, which belongs to the one verified profile', () => {
    expect(DEFAULT_PROFILE).toBe(UV5RM_BLE)
    expect(KNOWN_PROFILES[0]).toBe(UV5RM_BLE)
    expect(KNOWN_PROFILES).toContain(TIDRADIO_BL1_FF00)
    expect(KNOWN_PROFILES).toContain(TIDRADIO_BL1_FFE0)
  })

  it('parses the uart: override the person chasing a real dongle needs', () => {
    // Without the prefix, a hand-entered dongle profile would leave the
    // driver on the wireless block size - the exact bug the axis split fixed.
    const p = parseBluetoothProfile('uart:ffe0,ffe1')
    expect(p.radioLink).toBe('serial')
    expect(p.write).toBe(p.notify)
    expect(p.verified).toBe(false)
    // And a plain override keeps meaning a radio's own module.
    expect(parseBluetoothProfile('ffe0,ffe1').radioLink).toBeUndefined()
  })
})

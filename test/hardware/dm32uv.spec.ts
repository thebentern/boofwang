// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest'
import { equalBytes } from '#core/codec/struct.js'
import { hz, mW } from '#core/model/units.js'
import type { RadioImage } from '#core/radio/image.js'
import type { IdentifyResult } from '#core/radio/driver.js'
import { createDm32uvDriver, decodeTalkGroupIndex } from '#core/radios/dm32uv/driver.js'
import { PAGE_SIZE, REOPEN_SETTLE_MS } from '#core/radios/dm32uv/protocol.js'
import { logicalAddress } from '#core/radios/dm32uv/image.js'
import {
  ANALOG_BLOCK,
  CALLLIST_BASE,
  CALLLIST_BLOCK,
  CALLLIST_END,
  CALLLIST_NAME_AT,
  CALLLIST_SIZE,
  CHANNEL_BLOCK_LAST,
  channelSlot,
  MESSAGE_BLOCK,
  MESSAGE_HEADER,
  ROAMCHANNEL_BLOCK,
  ROAMCHANNEL_COUNT_AT,
  ROAMZONE_BLOCK,
  RXGROUP_BLOCK,
  SCANLIST_BLOCK,
  SETTINGS_BLOCK,
  decodeTxContact,
  TXCONTACT_BLOCK_HIGH,
  TXCONTACT_HIGH_LIMIT,
  VFO_A_TXCONTACT,
  VFO_B_TXCONTACT,
  TXCONTACT_BLOCK_LOW,
  ZONE_BLOCK_FIRST,
  ZONE_HEADER,
  ZONE_SIZE,
} from '#core/radios/dm32uv/layout.js'
import { SerialTransport } from '#core/transport/serial-transport.js'
import { BridgeSerialPort, listBridgePorts } from '#core/transport/bridge-serial-port.js'

/**
 * The DM-32UV write path, against a real radio.
 *
 * Skipped unless `BOOFWANG_HW` is set, because it needs a DM-32UV on a cable
 * and the development serial bridge (`pnpm bridge`) running:
 *
 *   BOOFWANG_HW=1 BOOFWANG_HW_PORT=/dev/cu.usbserial-XXXX pnpm vitest run test/hardware
 *
 * It takes its own baseline before touching anything and restores it at the
 * end, then reads the radio once more and asserts the bytes came back - so a
 * failure leaves evidence rather than a radio in an unknown state.
 *
 * Everything here is checked against raw bytes at documented offsets rather
 * than against boofwang's own decoder. Decoder and encoder shared a wrong bit
 * for transmit-forbid for the whole of this driver's life, and every
 * self-consistent test passed the entire time.
 */
const HW = !!process.env.BOOFWANG_HW
const URL_ = process.env.BOOFWANG_BRIDGE ?? 'ws://127.0.0.1:8765'
const PORT = process.env.BOOFWANG_HW_PORT ?? ''

const driver = createDm32uvDriver({ enableWrite: true })
const CHANNEL_BLOCK = 0x12
const HEADER = 0x10
const SIZE = 48

/**
 * When the port was last closed, across every test in this file.
 *
 * The settle wait used to be skipped on each test's own first session, which is
 * right at suite start and wrong everywhere after it. The second test opened
 * 1.2 seconds after the first one's restore closed the port and the radio
 * answered 90 - not ready - so it failed every time it ran behind a sibling.
 * The radio has no idea where one test ends and the next begins, so neither can
 * this: the wait is measured from the close, not from the test boundary.
 */
let lastClosed = 0

describe.skipIf(!HW)('DM-32UV on the bench', () => {
  it('reads, edits every field it can write, verifies each byte, and restores', { timeout: 1_800_000 }, async () => {
    expect(PORT, 'set BOOFWANG_HW_PORT to the adapter path').not.toBe('')
    const ports = await listBridgePorts(URL_)
    const info = ports.find((p) => p.path === PORT)
    expect(info, `the bridge does not see ${PORT}. It offers: ${ports.map((p) => p.path).join(', ')}`).toBeTruthy()

    // One connection per operation, as the app does. This radio has no command
    // to leave programming mode; it resets when the port closes, and needs a
    // moment afterwards before it will answer a handshake.
    async function session<T>(fn: (t: SerialTransport, ident: IdentifyResult) => Promise<T>): Promise<T> {
      const wait = REOPEN_SETTLE_MS + 800 - (Date.now() - lastClosed)
      if (lastClosed !== 0 && wait > 0) await new Promise((r) => setTimeout(r, wait))
      const t = new SerialTransport(new BridgeSerialPort(URL_, info!))
      await t.open(driver.serial)
      try {
        return await fn(t, await driver.identify(t, {}))
      } finally {
        await t.close().catch(() => {})
        lastClosed = Date.now()
      }
    }

    const read = () => session(async (t, ident) => ({ image: await driver.readImage(t, ident, {}), ident }))
    const block = (img: RadioImage, id: number) => img.regions.find((r) => r.start === (id << 12))!.data
    const record = (img: RadioImage, n: number) => {
      const at = HEADER + n * SIZE
      return block(img, CHANNEL_BLOCK).subarray(at, at + SIZE)
    }
    const indexOfName = (img: RadioImage, want: string) => {
      for (let n = 0; ; n++) {
        const at = HEADER + n * SIZE
        if (at + SIZE > 0xfff) throw new Error(`no channel record named ${want}`)
        const raw = record(img, n)
        const end = raw.findIndex((b, i) => i < 16 && (b === 0 || b === 0xff))
        const name = new TextDecoder('latin1').decode(raw.subarray(0, end < 0 ? 16 : end))
        if (name === want) return n
      }
    }

    const { image: baseline, ident } = await read()

    // The DMR address book, which lives outside the configuration region and is
    // read only. Checked here because it is the one part of a read that cannot
    // be exercised from a fixture: the region's extent is per-radio, and the
    // page walk only matters once there are more than 44 contacts.
    const contacts = driver.decode(baseline).contacts
    const contactsStart = (ident.meta as { contactsStart?: number }).contactsStart
    if (typeof contactsStart === 'number') {
      for (const c of contacts) {
        expect(c.name, `contact ${c.id} name is not printable`).toMatch(/^[\x20-\x7e]*$/)
        expect(c.dmrId, `contact ${c.id} id out of 24-bit range`).toBeGreaterThan(0)
        expect(c.dmrId).toBeLessThanOrEqual(0xff_ffff)
      }
      if (contacts.length > 45) {
        // 44 entries per page and they do not straddle the boundary. The flat
        // index*92 formula in circulation reads garbage from entry 44 onward,
        // so a readable name either side of it is the check that matters.
        expect(contacts[43]!.name).toMatch(/^[\x20-\x7e]+$/)
        expect(contacts[44]!.name).toMatch(/^[\x20-\x7e]+$/)
        expect(contacts[45]!.name).toMatch(/^[\x20-\x7e]+$/)
      }
    }
    const backup = {
      id: 'hw',
      identHash: ident.identHash,
      unitHash: await driver.unitFingerprint!(baseline),
      createdAt: new Date().toISOString(),
    }

    try {
      const doc = driver.decode(baseline)
      // Two analog channels and one transmit-forbidden digital one. Named
      // rather than positional so a failure says which channel.
      const analog = [...doc.channels.values()].filter((c) => c.modulation === 'FM' && c.txAllowed)
      const forbidden = [...doc.channels.values()].find((c) => !c.txAllowed)
      expect(analog.length, 'need two transmit-capable analog channels').toBeGreaterThanOrEqual(2)
      expect(forbidden, 'need one transmit-forbidden channel').toBeTruthy()

      const a = analog[0]!
      const b = analog[1]!
      const nA = indexOfName(baseline, a.name)
      const nB = indexOfName(baseline, b.name)
      const nF = indexOfName(baseline, forbidden!.name)

      doc.channels.set(a.index, {
        ...a,
        name: 'HW CHECK A',
        power: { mW: mW(2500), label: 'Medium' },
        tone: { rx: { kind: 'ctcss', deciHz: 1273 }, tx: { kind: 'ctcss', deciHz: 1273 }, rxInverted: false },
        txAllowed: false,
        txInhibitReason: 'hardware check',
      })
      doc.channels.set(b.index, {
        ...b,
        rxFreq: hz(462_600_000),
        bandwidthHz: 25_000,
        tone: { rx: { kind: 'dtcs', code: 754, polarity: 'R' }, tx: { kind: 'dtcs', code: 23, polarity: 'N' }, rxInverted: false },
      })
      const { txInhibitReason: _dropped, ...allowed } = forbidden!
      doc.channels.set(forbidden!.index, { ...allowed, txAllowed: true })

      const zoneWas = doc.zones[0]!.name
      doc.zones[0] = { ...doc.zones[0]!, name: 'HW ZONE' }
      const tgWas = doc.talkGroups[0]!
      doc.talkGroups[0] = { ...tgWas, name: 'HW TG' }
      const keyWas = doc.encryptionKeys[0]!
      doc.encryptionKeys[0] = { ...keyWas, keyHex: '5A'.repeat(keyWas.keyHex.length / 2) }

      // The structures that were never read at all until now.
      const zoneMembersWere = doc.zones[0]!.channels
      const liveChannels = [...doc.channels.keys()].slice(0, 3)
      doc.zones[0] = { ...doc.zones[0]!, channels: liveChannels }

      const scanWas = doc.scanLists[0]
      // The experiment that settles where a scan list's members start.
      //
      // MURS-1, MURS-2, MURS-3 are channels 23-25, which is a run the radio's
      // own display makes obvious. Written from +0x18, they read back as those
      // three; read from +0x1A they would come back as MURS-2, MURS-3 and
      // whatever follows - so the read-back below tells the two apart.
      if (scanWas) doc.scanLists[0] = { ...scanWas, name: 'HW SCAN', channels: [23, 24, 25] }

      const rxWas = doc.rxGroups[0]
      if (rxWas) doc.rxGroups[0] = { ...rxWas, name: 'HW RXG', dmrIds: [3105, 91] }

      const ridWas = doc.radioIds[0]
      if (ridWas) doc.radioIds[0] = { ...ridWas, name: 'HW ID', dmrId: 3_105_999 }

      // The DMR address book. Editing the LAST contact is deliberate: it is on
      // the final page, so a page-walk that straddles the 4 KiB boundary writes
      // it somewhere else entirely and the read-back catches it.
      const contactWas = contacts.at(-1)
      if (contactWas) {
        doc.contacts[doc.contacts.length - 1] = { ...contactWas, name: 'HW BOOF', callsign: 'W0AAA' }
      }

      // Which talk group a channel transmits to, which lives in a block of its
      // own rather than in the channel record.
      const dmrChannel = [...doc.channels.values()].find((c) => c.modulation === 'DMR' && c.extras.vendor?.txContact)
      const txWas = dmrChannel ? Number(dmrChannel.extras.vendor!.txContact) : 0
      const txWant = doc.talkGroups.length > 1 ? (txWas === 1 ? 3 : 1) : txWas
      if (dmrChannel && txWant !== txWas) {
        doc.channels.set(dmrChannel.index, {
          ...dmrChannel,
          extras: { ...dmrChannel.extras, vendor: { ...dmrChannel.extras.vendor, txContact: String(txWant) } },
        })
      }

      // Text messages and roaming channels, both newly writable.
      const messagesWere = [...doc.messages]
      if (doc.messages.length > 0) doc.messages[0] = 'HW BOOF MSG'
      const roamWas = doc.roamChannels[0]
      if (roamWas) {
        doc.roamChannels[0] = { ...roamWas, name: 'HW ROAM', colorCode: 7, timeSlot: roamWas.timeSlot === 1 ? 2 : 1 }
      }

      // Block 0x43 - the TX contact for channels above 2047 - is deliberately
      // NOT exercised here.
      //
      // It could be: 601 such channels are creatable on this radio, because
      // channel blocks 0x30, 0x31, 0x32, 0x34, 0x37, 0x3b, 0x3d and 0x41 are
      // allocated. But channel slots are positional, so creating channel 2550
      // means writing a channel count of 2550 to a radio that has 45 - telling
      // it that 2504 slots it has never used are now in play, most of them in
      // blocks it has not allocated. That is a large, unverified change to
      // somebody's radio to prove a two-byte write whose geometry is identical
      // to block 0x42's, which this suite already verifies.
      //
      // So 0x43 is covered by the unit tests against this radio's own image,
      // and the limitation is written down rather than quietly skipped.

      // The three that were read-only until now: names and codes only.
      const zoneNameWas = doc.roamZones[0]?.name
      if (doc.roamZones[0]) doc.roamZones[0] = { ...doc.roamZones[0], name: 'HW RZ' }
      const emergWas = doc.emergency[0]
      if (emergWas) doc.emergency[0] = { ...emergWas, name: 'HW EM' }
      const dtmfWas = doc.analog?.dtmfCodes[0]
      const bdcWas = doc.analog?.bdcContacts[0]
      if (doc.analog) {
        doc.analog = {
          ...doc.analog,
          dtmfCodes: doc.analog.dtmfCodes.map((c, i) => (i === 0 ? '99#12' : c)),
          contacts: doc.analog.contacts.map((c, i) => (i === 0 ? 'HW AC' : c)),
          bdcContacts: doc.analog.bdcContacts.map((c, i) => (i === 0 ? { name: 'HW MDC', number: 42 } : c)),
        }
      }

      // The two VFOs, which live at fixed offsets in the last channel block.
      const vfoWas = doc.vfo.a
      if (vfoWas) doc.vfo = { ...doc.vfo, a: { ...vfoWas, rxFreq: hz(446_006_25 * 10), tx: { kind: 'simplex' } } }

      // Adding and removing a zone and a talk group, which move the zone count
      // and the talk group index the radio keeps for itself.
      const zonesWere = doc.zones.length
      doc.zones.push({ id: 'zone-new', name: 'HW ZN NEW', channels: liveChannels })
      const tgsWere = doc.talkGroups.length
      doc.talkGroups.push({ id: 'tg-new', name: 'HW TG NEW', number: 424242, callType: 'group' })
      const tgIndexWas = decodeTalkGroupIndex(baseline)!

      // The block 0x03 call list: UTF-16LE names, and two reference fields
      // beside them that point at something nobody has identified.
      const callWas = doc.callList[1]?.name
      if (doc.callList[1]) doc.callList[1] = { ...doc.callList[1], name: 'HW CALL' }

      /*
       * The VFO talk group, which the reference implementation reads and
       * refuses to write - "disabled until properly debugged", with the noted
       * consequence that VFO talk group changes do not persist. Both its
       * captures pin the offsets; nobody had put a byte there.
       */
      const vfoTxWas = doc.vfo.a?.extras.vendor?.txContact
      if (doc.vfo.a) {
        doc.vfo.a = {
          ...doc.vfo.a,
          extras: { ...doc.vfo.a.extras, vendor: { ...doc.vfo.a.extras.vendor, txContact: '1' } },
        }
      }

      const settingsWere = { ...doc.settings }
      doc.settings.powerOnLine1 = 'HW BOOF'
      doc.settings['callsignColour.colour'] = 5
      doc.settings['gpsFlags.gpsSwitch'] = settingsWere['gpsFlags.gpsSwitch'] === 1 ? 0 : 1

      /*
       * One field from every settings region added since the last bench run,
       * so a region that decodes but never reaches the radio fails here rather
       * than on someone's radio. `NEW_SETTINGS` is checked again after the
       * read-back and again after the restore.
       */
      const NEW_SETTINGS: Record<string, number> = {
        'alertTonesCont.batteryLow': settingsWere['alertTonesCont.batteryLow'] === 1 ? 0 : 1,
        standbyCharColour1: 7,
        activeWaitTime: 9,
        preCarrierTime: 11,
        smsFormat: 5,
        txDwellTime: 200,
        'digitalFlags.missedCallAlert': settingsWere['digitalFlags.missedCallAlert'] === 1 ? 0 : 1,
        'nameDisplayFlags.sendTxName': settingsWere['nameDisplayFlags.sendTxName'] === 1 ? 0 : 1,
        oneTouch1Type: 1,
        oneTouch5Sms: 3,
        funPlus1Mode: 1,
        funPlus10Sms: 4,
        aprsScheduledSendTime: 6,
        aprsReportChannel8: 300,
        aprsUploadId: 0x123456,
        aprsRepeaterActiveDelay: 7,
        'menuZone.newZone': settingsWere['menuZone.newZone'] === 1 ? 0 : 1,
        'menuChannelB.channelName': settingsWere['menuChannelB.channelName'] === 1 ? 0 : 1,
      }
      for (const [key, value] of Object.entries(NEW_SETTINGS)) doc.settings[key] = value

      // Add a channel past the end and delete one in the middle. Both were
      // silently dropped before: the encode loop was bounded by the stored
      // count, and the count itself was not writable.
      const baseline0ScanCount = block(baseline, SCANLIST_BLOCK)[0]!
      const countWas = block(baseline, CHANNEL_BLOCK)[0]! | (block(baseline, CHANNEL_BLOCK)[1]! << 8)
      const added = countWas + 1
      doc.channels.set(added, { ...a, index: added, name: 'HW ADDED', txAllowed: true, tone: { rx: null, tx: null, rxInverted: false } })
      const deleted = [...doc.channels.keys()].filter((k) => k !== a.index && k !== b.index && k !== forbidden!.index && k !== added)[2]!
      const deletedName = doc.channels.get(deleted)!.name
      doc.channels.delete(deleted)

      const report = await session((t) =>
        driver.writeImage(t, driver.encode(doc, baseline), { ident, backup, baseImage: baseline }),
      )
      expect(report.verified).toBe(true)
      expect(report.blocksWritten).toBeGreaterThan(0)

      // Read it back independently and check raw bytes at documented offsets.
      const { image: after } = await read()
      const was = (n: number) => record(baseline, n)
      const now = (n: number) => record(after, n)

      // Byte 0x18: Forbid TX is bit 3, power is bits 2-1 (reference :300-308).
      expect((now(nA)[0x18]! >> 3) & 1, 'transmit-forbid did not set bit 3').toBe(1)
      expect((now(nA)[0x18]! >> 1) & 3, 'power did not land on bits 2-1').toBe(1)
      expect(now(nA)[0x18]! >> 4, 'the mode nibble moved').toBe(was(nA)[0x18]! >> 4)
      expect((now(nF)[0x18]! >> 3) & 1, 'clearing transmit-forbid did not clear bit 3').toBe(0)
      expect((now(nF)[0x18]! >> 1) & 3, 'clearing transmit-forbid disturbed the power level').toBe(
        (was(nF)[0x18]! >> 1) & 3,
      )

      // Byte 0x19: bandwidth is bit 7; scan add and scan list must survive.
      expect(now(nB)[0x19]! >> 7, 'wide bandwidth did not set bit 7').toBe(1)
      expect(now(nB)[0x19]! & 0x7f, 'the scan bits were disturbed').toBe(was(nB)[0x19]! & 0x7f)

      // Tones are packed BCD; DCS carries its polarity in the high byte.
      expect([...now(nA).subarray(0x21, 0x25)], 'CTCSS 127.3 both ways').toEqual([0x73, 0x12, 0x73, 0x12])
      expect([...now(nB).subarray(0x21, 0x25)], 'DCS 754 inverted / 023 normal').toEqual([0x54, 0xc7, 0x23, 0x80])

      // A receive-only channel keeps the transmit pair the radio stored.
      expect(equalBytes(now(nA).subarray(0x14, 0x18), was(nA).subarray(0x14, 0x18)),
        'a receive-only channel had its transmit frequency rewritten').toBe(true)

      // The count word moved, and the header fill around it did not.
      expect(block(after, CHANNEL_BLOCK)[0]! | (block(after, CHANNEL_BLOCK)[1]! << 8),
        'the channel count did not reach the radio').toBe(added)
      expect(equalBytes(block(after, CHANNEL_BLOCK).subarray(2, HEADER), block(baseline, CHANNEL_BLOCK).subarray(2, HEADER)),
        'the header fill either side of the count was rewritten').toBe(true)

      const back = driver.decode(after)
      expect(back.channels.get(added)?.name, 'the added channel is not on the radio').toBe('HW ADDED')
      expect(back.channels.has(deleted), `${deletedName} survived deletion`).toBe(false)
      expect(back.channels.get(deleted + 1)?.name, 'deleting renumbered the channels after it')
        .toBe(driver.decode(baseline).channels.get(deleted + 1)?.name)

      expect([...back.channels.values()].find((c) => c.name === 'HW CHECK A')).toBeTruthy()
      expect(back.zones[0]!.name).toBe('HW ZONE')
      expect(back.zones[0]!.channels, 'a zone rename moved its channel list').toEqual(doc.zones[0]!.channels)
      expect(back.talkGroups[0]!.name).toBe('HW TG')
      expect(back.talkGroups[0]!.number, 'a talk group rename changed its number').toBe(tgWas.number)
      expect(back.talkGroups[0]!.callType, 'a talk group rename changed its call type').toBe(tgWas.callType)
      expect(back.encryptionKeys[0]!.keyHex.toUpperCase()).toBe('5A'.repeat(keyWas.keyHex.length / 2))

      // Zone membership: the entries and the count both reached the radio, and
      // the stale pointers past the old count were left exactly as they were.
      expect(back.zones[0]!.channels, 'zone membership did not reach the radio').toEqual(liveChannels)
      expect(zoneMembersWere.length).toBeGreaterThan(liveChannels.length)
      const zoneRec = block(after, ZONE_BLOCK_FIRST).subarray(ZONE_HEADER, ZONE_HEADER + ZONE_SIZE)
      const zoneRecWas = block(baseline, ZONE_BLOCK_FIRST).subarray(ZONE_HEADER, ZONE_HEADER + ZONE_SIZE)
      expect(zoneRec[0x10], 'the zone count byte').toBe(liveChannels.length)
      expect(
        equalBytes(zoneRec.subarray(0x11 + 2 * zoneMembersWere.length), zoneRecWas.subarray(0x11 + 2 * zoneMembersWere.length)),
        'the entries past the old count were rewritten',
      ).toBe(true)

      if (scanWas) {
        expect(back.scanLists[0]!.name).toBe('HW SCAN')
        expect(back.scanLists[0]!.channels, 'scan list membership did not reach the radio').toEqual([23, 24, 25])
        // And the count that bounds them, in the byte the radio reads it from.
        const rec = block(after, SCANLIST_BLOCK).subarray(1, 1 + 57)
        expect(rec[0x0b], 'the member count').toBe(3)
        expect(rec[0x18]! | (rec[0x19]! << 8), 'the first member sits at +0x18').toBe(23)
        expect(block(after, SCANLIST_BLOCK)[0], 'the scan list count moved').toBe(baseline0ScanCount)
      }
      if (rxWas) {
        expect(back.rxGroups[0]!.name).toBe('HW RXG')
        expect(back.rxGroups[0]!.dmrIds).toEqual([3105, 91])
        // The occupancy bitmask is the record of truth and must still agree.
        expect(block(after, RXGROUP_BLOCK)[0]).toBe(block(baseline, RXGROUP_BLOCK)[0])
      }
      if (ridWas) {
        expect(back.radioIds[0]!.name).toBe('HW ID')
        expect(back.radioIds[0]!.dmrId, 'the 24-bit DMR ID').toBe(3_105_999)
      }

      if (dmrChannel && txWant !== txWas) {
        const now = back.channels.get(dmrChannel.index)!
        expect(Number(now.extras.vendor!.txContact), 'the talk group did not reach the radio').toBe(txWant)
        // Two bytes per channel, and only the pairs this test actually touched
        // may have moved: the edited channel's, and the one added above, which
        // lands in this same page. The first bench run allowed only the first
        // of those and failed on `bytes moved: 55,91` - byte 55 the edit, byte
        // 91 the added channel's own pair, both correct. The encoder was right
        // and the assertion had forgotten what else this test does.
        const at = (dmrChannel.index - 1) * 2
        const addedAt = (added - 1) * 2
        const allowed = new Set([at, at + 1, addedAt, addedAt + 1])
        const nowPage = block(after, TXCONTACT_BLOCK_LOW)
        const wasPage = block(baseline, TXCONTACT_BLOCK_LOW)
        const moved = [...nowPage.keys()].filter((i) => nowPage[i] !== wasPage[i])
        expect(moved.every((i) => allowed.has(i)), `bytes moved: ${moved}`).toBe(true)
      }

      if (messagesWere.length > 0) {
        expect(back.messages[0], 'the message did not reach the radio').toBe('HW BOOF MSG')
        expect(back.messages.slice(1)).toEqual(messagesWere.slice(1))
        // The length byte and the text must agree, or the radio shows garbage.
        const rec = block(after, MESSAGE_BLOCK)
        expect(rec[MESSAGE_HEADER], 'the length byte').toBe('HW BOOF MSG'.length)
      }

      if (roamWas) {
        const now = back.roamChannels[0]!
        expect(now.name, 'the roaming channel did not reach the radio').toBe('HW ROAM')
        expect(now.colorCode).toBe(7)
        expect(now.timeSlot).toBe(roamWas.timeSlot === 1 ? 2 : 1)
        expect(now.rxFreq, 'the frequency moved').toBe(roamWas.rxFreq)
        // The count trailer, and the bytes after it.
        expect(block(after, ROAMCHANNEL_BLOCK)[ROAMCHANNEL_COUNT_AT]).toBe(back.roamChannels.length)
        expect(
          equalBytes(
            block(after, ROAMCHANNEL_BLOCK).subarray(ROAMCHANNEL_COUNT_AT + 1),
            block(baseline, ROAMCHANNEL_BLOCK).subarray(ROAMCHANNEL_COUNT_AT + 1),
          ),
          'the bytes after the count trailer were rewritten',
        ).toBe(true)
      }

      /*
       * Block 0x43 holds no channel this radio has, so the only thing this run
       * writes in it is VFO A's talk-group slot. Everything else - the record
       * area, the stale zone records in the residue, VFO B, the unused byte at
       * 0x0FFE and the block id - has to be exactly as it was.
       *
       * Checked as "every byte outside the four the VFO slots occupy", rather
       * than by listing the parts, so a write that strays anywhere in the page
       * fails here.
       */
      {
        const now = block(after, TXCONTACT_BLOCK_HIGH)
        const was = block(baseline, TXCONTACT_BLOCK_HIGH)
        const moved: number[] = []
        for (let i = 0; i < PAGE_SIZE; i++) {
          if (now[i] !== was[i] && (i < VFO_A_TXCONTACT || i >= VFO_B_TXCONTACT + 2)) moved.push(i)
        }
        expect(moved.map((i) => `0x${i.toString(16)}`), 'block 0x43 moved outside the VFO slots').toEqual([])
      }

      // Anything in these three that was NOT edited above must be unchanged -
      // only names and codes are written, never the derived fields beside them.
      const wasAnalog = driver.decode(baseline).analog
      const nowAnalog = driver.decode(after).analog
      if (wasAnalog && nowAnalog) {
        expect(nowAnalog.dtmfCodes.slice(1)).toEqual(wasAnalog.dtmfCodes.slice(1))
        expect(nowAnalog.dtmfSpecialCodes).toEqual(wasAnalog.dtmfSpecialCodes)
        expect(nowAnalog.contacts.slice(1)).toEqual(wasAnalog.contacts.slice(1))
        expect(nowAnalog.bdcContacts.slice(1)).toEqual(wasAnalog.bdcContacts.slice(1))
      }
      expect(driver.decode(after).emergency.slice(1)).toEqual(driver.decode(baseline).emergency.slice(1))
      expect(driver.decode(after).roamZones.slice(1)).toEqual(driver.decode(baseline).roamZones.slice(1))

      if (zoneNameWas !== undefined) {
        expect(back.roamZones[0]!.name, 'the roaming zone name did not reach the radio').toBe('HW RZ')
        // The count byte and the fifteen beside it are the radio's.
        expect(
          equalBytes(block(after, ROAMZONE_BLOCK).subarray(0, 0x10), block(baseline, ROAMZONE_BLOCK).subarray(0, 0x10)),
          'the roaming zone page header was written',
        ).toBe(true)
      }

      if (emergWas) {
        const now = driver.decode(after).emergency[0]!
        expect(now.name, 'the emergency name did not reach the radio').toBe('HW EM')
        // Every field past the name is derived and must not have moved.
        expect(now.alarmType).toBe(emergWas.alarmType)
        expect(now.alarmMode).toBe(emergWas.alarmMode)
        expect(now.revertChannel).toBe(emergWas.revertChannel)
      }

      if (dtmfWas !== undefined) {
        const nowAnalog = driver.decode(after).analog!
        expect(nowAnalog.dtmfCodes[0], 'the DTMF code did not reach the radio').toBe('99#12')
        expect(nowAnalog.contacts[0]).toBe('HW AC')
        expect(nowAnalog.bdcContacts[0], 'the MDC number is BCD').toEqual({ name: 'HW MDC', number: 42 })
        expect(bdcWas).toBeTruthy()
        // The DTMF settings record between the two code lists is not ours.
        expect(
          equalBytes(block(after, ANALOG_BLOCK).subarray(0x100, 0x110), block(baseline, ANALOG_BLOCK).subarray(0x100, 0x110)),
          'the DTMF settings record was written',
        ).toBe(true)
      }

      if (vfoWas) {
        expect(back.vfo.a!.rxFreq, 'the VFO did not reach the radio').toBe(446_006_25 * 10)
        expect(back.vfo.b, 'the other VFO moved').toEqual(driver.decode(baseline).vfo.b)
        // VFO B ends against the block id byte, which is never ours.
        expect(block(after, CHANNEL_BLOCK_LAST)[PAGE_SIZE - 1]).toBe(block(baseline, CHANNEL_BLOCK_LAST)[PAGE_SIZE - 1])
      }

      // The zone count moved, and the fifteen bytes beside it did not.
      expect(back.zones, 'the added zone did not reach the radio').toHaveLength(zonesWere + 1)
      expect(back.zones.at(-1)!.name).toBe('HW ZN NEW')
      expect(block(after, ZONE_BLOCK_FIRST)[0]).toBe(zonesWere + 1)
      expect(
        equalBytes(block(after, ZONE_BLOCK_FIRST).subarray(1, ZONE_HEADER), block(baseline, ZONE_BLOCK_FIRST).subarray(1, ZONE_HEADER)),
        'the zone page header state was rewritten',
      ).toBe(true)

      // The talk group landed in a free slot, and the radio's own index agrees.
      expect(back.talkGroups, 'the added talk group did not reach the radio').toHaveLength(tgsWere + 1)
      const tgIndexNow = decodeTalkGroupIndex(after)!
      expect(tgIndexNow.live).toHaveLength(tgsWere + 1)
      expect(tgIndexNow.live.length).toBeGreaterThan(tgIndexWas.live.length)
      expect(tgIndexNow.byName, 'the name table disagrees with the bitmask').toHaveLength(tgIndexNow.live.length)
      expect([...tgIndexNow.byName].sort((a, b) => a - b)).toEqual(tgIndexNow.live)

      expect(back.settings.powerOnLine1).toBe('HW BOOF')
      expect(back.settings['callsignColour.colour']).toBe(5)
      // One nibble of a shared byte moved; the other must not have.
      expect(back.settings['standbyTextColour.colour']).toBe(settingsWere['standbyTextColour.colour'])
      // And the settings this build models but does not offer are unchanged.
      expect(back.settings.gpsReportInterval).toBe(settingsWere.gpsReportInterval)

      for (const [key, value] of Object.entries(NEW_SETTINGS)) {
        expect(back.settings[key], `${key} did not reach the radio`).toBe(value)
      }

      if (doc.vfo.a) {
        expect(back.vfo.a?.extras.vendor?.txContact, 'the VFO talk group did not reach the radio').toBe('1')
        const raw = block(after, TXCONTACT_BLOCK_HIGH)
        expect(decodeTxContact(raw[VFO_A_TXCONTACT]!, raw[VFO_A_TXCONTACT + 1]!)).toEqual({
          slot: 1,
          digital: doc.vfo.a.modulation === 'DMR',
        })
        // VFO B untouched, and the residue between the records and the slots
        // left exactly as the flash layer left it.
        expect([raw[VFO_B_TXCONTACT], raw[VFO_B_TXCONTACT + 1]]).toEqual([
          block(baseline, TXCONTACT_BLOCK_HIGH)[VFO_B_TXCONTACT],
          block(baseline, TXCONTACT_BLOCK_HIGH)[VFO_B_TXCONTACT + 1],
        ])
        expect(
          equalBytes(
            raw.subarray(TXCONTACT_HIGH_LIMIT, VFO_A_TXCONTACT),
            block(baseline, TXCONTACT_BLOCK_HIGH).subarray(TXCONTACT_HIGH_LIMIT, VFO_A_TXCONTACT),
          ),
          'the block 0x43 residue was written',
        ).toBe(true)
        expect(raw[0x0fff], 'the block id was overwritten').toBe(TXCONTACT_BLOCK_HIGH)
      }
      void vfoTxWas

      if (callWas !== undefined) {
        expect(back.callList[1]!.name, 'the call list name did not reach the radio').toBe('HW CALL')
        // Raw bytes, because the point of this block is that it is the only one
        // storing names two bytes to the character.
        const at = CALLLIST_BASE + CALLLIST_SIZE + CALLLIST_NAME_AT
        const raw = block(after, CALLLIST_BLOCK)
        expect(raw[at]).toBe('H'.charCodeAt(0))
        expect(raw[at + 1]).toBe(0)
        expect(raw[at + 2]).toBe('W'.charCodeAt(0))
        // The in-use marker and the two references beside it are not ours.
        const rec = CALLLIST_BASE + CALLLIST_SIZE
        expect([...raw.subarray(rec, rec + 8)]).toEqual([
          ...block(baseline, CALLLIST_BLOCK).subarray(rec, rec + 8),
        ])
        // And nothing reached the unrelated structure after the records.
        expect(
          equalBytes(raw.subarray(CALLLIST_END, PAGE_SIZE - 1), block(baseline, CALLLIST_BLOCK).subarray(CALLLIST_END, PAGE_SIZE - 1)),
          'a byte past the call records was written',
        ).toBe(true)
      }
      /*
       * The unlabelled bits beside the two menu bits above. The OEM capture has
       * data in them, so a menu byte rebuilt from defaults rather than merged
       * would zero them - and nothing else in this suite would notice.
       */
      expect(block(after, SETTINGS_BLOCK)[0x500]! & 0xfc).toBe(block(baseline, SETTINGS_BLOCK)[0x500]! & 0xfc)
      expect(block(after, SETTINGS_BLOCK)[0x507]! & 0xe0).toBe(block(baseline, SETTINGS_BLOCK)[0x507]! & 0xe0)
      // The three sites in block 0x04 this build deliberately declines to model.
      for (const off of [0x032, 0x045, 0x080, 0x0a0, 0x0a7, 0x120, 0x127]) {
        expect(block(after, SETTINGS_BLOCK)[off], `0x${off.toString(16)} was written`).toBe(
          block(baseline, SETTINGS_BLOCK)[off],
        )
      }

      // The address book, written for real.
      if (contactWas) {
        const now = driver.decode(after).contacts
        expect(now, 'the address book changed length').toHaveLength(contacts.length)
        expect(now.at(-1)!.name, 'the edited contact did not reach the radio').toBe('HW BOOF')
        expect(now.at(-1)!.callsign).toBe('W0AAA')
        expect(now.at(-1)!.dmrId, 'the DMR ID moved').toBe(contactWas.dmrId)
        // Every other contact untouched, including the ones either side of a
        // page boundary.
        expect(now.slice(0, -1)).toEqual(contacts.slice(0, -1))

        // And the bytes nobody has explained are still there.
        const first = after.regions.find((r) => r.start === contactsStart)!.data
        const wasFirst = baseline.regions.find((r) => r.start === contactsStart)!.data
        expect(
          equalBytes(first.subarray(4, 0x10), wasFirst.subarray(4, 0x10)),
          'the twelve bytes between the count and entry 0 were rewritten',
        ).toBe(true)
        expect(first[0xfff], 'the last byte of the page, which here is data').toBe(wasFirst[0xfff])
      }

      // Nothing outside the blocks the driver claims may have moved.
      for (const region of after.regions) {
        const id = region.start >>> 12
        const before = baseline.regions.find((r) => r.start === region.start)!.data
        if (equalBytes(region.data, before)) continue
        expect(driver.ownedRanges(region.start, after).length, `block 0x${id.toString(16)} changed but is not claimed`).toBeGreaterThan(0)
        for (let i = 0; i < region.data.length; i++) {
          if (region.data[i] === before[i]) continue
          const inside = driver.ownedRanges(region.start, after).some(([from, to]) => i >= from && i < to)
          expect(inside, `block 0x${id.toString(16)} byte 0x${i.toString(16)} is outside ownedRanges`).toBe(true)
        }
      }
      expect(zoneWas).not.toBe('HW ZONE')
    } finally {
      // Always put the radio back, even if an assertion above failed.
      await session((t, id) =>
        driver.writeImage(t, baseline, { ident: id, backup: { ...backup, identHash: id.identHash } }),
      )
    }

    // And prove the restore worked, from a fresh read.
    const { image: restored } = await read()
    for (const region of restored.regions) {
      const before = baseline.regions.find((r) => r.start === region.start)
      expect(before, `region 0x${region.start.toString(16)} vanished`).toBeTruthy()
      // The zone page header carries live radio state - a cursor the radio
      // moves on its own between sessions - and is deliberately outside
      // ownedRanges, so it is not ours to have put back.
      const from = region.start === logicalAddress(ZONE_BLOCK_FIRST) ? ZONE_HEADER : 0
      expect(
        equalBytes(region.data.subarray(from), before!.data.subarray(from)),
        `region 0x${region.start.toString(16)} did not come back`,
      ).toBe(true)
    }
    // Including the address book, which is the whole reason contacts could not
    // be written until now.
    expect(driver.decode(restored).contacts).toEqual(contacts)

  })

  /**
   * The one question about zone membership this radio has not answered.
   *
   * Settled already, from this radio's own bytes: the count byte bounds the
   * list, and entries past it are ignored - `Tactical` has carried pointers to
   * channels 43-48 past a count of 14 for as long as it has been a 14-channel
   * zone, and three of those channels do not exist. Still open: an entry
   * *inside* the count pointing at a blank channel record.
   *
   * boofwang cannot produce that state. `encodeZones` drops a member the
   * document has no channel for, deleting a channel takes it out of every list
   * that named it, and a renumber drops it rather than repointing it - which is
   * deliberate, and is why the answer is not needed for anything shipped. It is
   * worth knowing anyway, because "we avoid it" is a weaker claim than "we know
   * what it does".
   *
   * So this sets the state up at the byte level rather than through `encode`,
   * which is the only way to create something the encoder exists to prevent. It
   * erases one channel record that a zone names and changes nothing else: the
   * zone record, its count and its member list are all left exactly as they
   * are, so the dangling entry is the radio's own list pointing at a slot that
   * has gone blank underneath it.
   *
   * The test cannot see the radio's screen. It puts the radio into the state,
   * proves from a read-back that the state is really there, prints what to look
   * at, and restores. The answer comes from a person, and belongs in
   * `docs/protocols/dm32uv.md` next to the rest.
   *
   * Its own connection helpers rather than the ones above: those are local to
   * that test, and reaching into it to share them would mean editing a
   * verified hardware procedure to add an unverified one.
   */
  it('leaves a zone member pointing at a blank slot, for a person to read off the radio', { timeout: 1_800_000 }, async () => {
    expect(PORT, 'set BOOFWANG_HW_PORT to the adapter path').not.toBe('')
    const ports = await listBridgePorts(URL_)
    const info = ports.find((p) => p.path === PORT)
    expect(info, `the bridge does not see ${PORT}`).toBeTruthy()

    async function session<T>(fn: (t: SerialTransport, ident: IdentifyResult) => Promise<T>): Promise<T> {
      const wait = REOPEN_SETTLE_MS + 800 - (Date.now() - lastClosed)
      if (lastClosed !== 0 && wait > 0) await new Promise((r) => setTimeout(r, wait))
      const t = new SerialTransport(new BridgeSerialPort(URL_, info!))
      await t.open(driver.serial)
      try {
        return await fn(t, await driver.identify(t, {}))
      } finally {
        await t.close().catch(() => {})
        lastClosed = Date.now()
      }
    }
    const read = () => session(async (t, ident) => ({ image: await driver.readImage(t, ident, {}), ident }))
    const block = (img: RadioImage, id: number) => img.regions.find((r) => r.start === (id << 12))?.data

    const { image: baseline, ident } = await read()
    const backup = {
      id: 'hw-dangling',
      identHash: ident.identHash,
      unitHash: await driver.unitFingerprint!(baseline),
      createdAt: new Date().toISOString(),
    }

    const doc = driver.decode(baseline)
    const zone = doc.zones.find((z) => z.channels.length > 1)
    expect(zone, 'this radio has no zone with more than one member to work with').toBeTruthy()

    // The last member, so what is left is a zone whose final entry dangles -
    // the case a person can see by stepping to the end of the zone.
    const victim = zone!.channels.at(-1)!
    const at = channelSlot(victim)
    expect(at, `channel ${victim} is past the bank`).toBeTruthy()

    const target = { ...baseline, regions: baseline.regions.map((r) => ({ ...r, data: r.data.slice() })) }
    const page = block(target, at!.blockId)
    expect(page, `this radio has no block 0x${at!.blockId.toString(16)}`).toBeTruthy()
    page!.fill(0xff, at!.offset, at!.offset + SIZE)

    try {
      await session((t, id) =>
        driver.writeImage(t, target, { ident: id, backup: { ...backup, identHash: id.identHash } }),
      )

      const { image: after } = await read()

      // The record really is blank.
      const now = block(after, at!.blockId)!.subarray(at!.offset, at!.offset + SIZE)
      expect(now.every((b) => b === 0xff), 'the channel record did not come back erased').toBe(true)

      // And the zone record is untouched, so its count still reaches the entry
      // that now points at nothing. Compared whole rather than field by field:
      // the point is that nothing about the zone moved.
      const rec = (img: RadioImage) =>
        block(img, ZONE_BLOCK_FIRST)!.subarray(ZONE_HEADER, ZONE_HEADER + ZONE_SIZE * doc.zones.length)
      expect(equalBytes(rec(after), rec(baseline)), 'the zone records moved; this proves nothing').toBe(true)

      const dangling = driver.decode(after).zones.find((z) => z.id === zone!.id)
      expect(dangling?.channels, 'the decoded zone no longer names the blank slot').toContain(victim)
      expect(driver.decode(after).channels.has(victim), 'the channel is still there').toBe(false)

      console.log(
        [
          '',
          '  The radio is now in the state to look at. Switch it on and:',
          `    1. Select zone ${JSON.stringify(zone!.name)}.`,
          `    2. Step to the end of it. Its last entry is channel ${victim}, whose record is erased.`,
          '    3. Record what the display does: skips it, shows a blank, repeats the previous',
          '       channel, or refuses. Note whether the zone still reports its old channel count.',
          '    4. Write the answer into docs/protocols/dm32uv.md.',
          '',
          '  The radio is restored to its baseline as soon as this test finishes, so read it now.',
          '',
        ].join('\n'),
      )
    } finally {
      await session((t, id) =>
        driver.writeImage(t, baseline, { ident: id, backup: { ...backup, identHash: id.identHash } }),
      )
    }

    const { image: restored } = await read()
    const back = block(restored, at!.blockId)!.subarray(at!.offset, at!.offset + SIZE)
    const was = block(baseline, at!.blockId)!.subarray(at!.offset, at!.offset + SIZE)
    expect(equalBytes(back, was), `channel ${victim} did not come back`).toBe(true)
  })
})

describe.skipIf(HW)('DM-32UV hardware suite', () => {
  it('is skipped without BOOFWANG_HW', () => {
    expect(HW).toBe(false)
  })
})

// SPDX-License-Identifier: GPL-3.0-or-later
import type { Channel } from '../model/channel.js'
import type { Codeplug } from '../model/codeplug.js'
import type { Diagnostic } from '../radio/driver.js'
import type { RadioSchema } from '../radio/schema.js'

/**
 * The codeplug checked against itself, and against what the radio can hold.
 *
 * `rules.ts` asks one question of one channel: can this radio do that? Nobody
 * was asking the other one - do the parts of this document still agree with
 * each other - and the encoders were answering it silently, at write time, by
 * throwing the disagreement away. A DM-32UV zone is written as
 * `zone.channels.filter((c) => live.has(c)).slice(0, ZONE_MAX_CHANNELS)`, and
 * scan lists and RX groups are written the same way: a member pointing at a
 * slot that no longer holds a channel simply vanishes, and a list one entry too
 * long loses its tail. Neither says anything. The write diff shows the bytes
 * that resulted, never the intent that went missing on the way.
 *
 * That is the test for whether a rule belongs in this file. Every rule below
 * names something an encoder already discards or truncates without telling
 * anybody. A check that no encoder acts on is a check with nothing to report.
 *
 * **Nothing here is an error.** `rules.ts` reserves that for facts about the
 * hardware - a frequency the radio cannot tune - because an error blocks the
 * write. None of these is that. Every document below is one the radio accepts;
 * it simply will not keep all of it. Refusing to program somebody's radio over
 * a scan list entry would be a worse outcome than the entry being dropped, and
 * they would have no way to get past it.
 *
 * Two absences are deliberate. RX groups hold raw DMR IDs rather than positions
 * in the contact list (`RxGroup.dmrIds`), so there is no reference there that
 * can dangle and nothing to check. And the channel-to-talk-group reference is
 * checked, but by the DM-32UV driver rather than here: it is stored in
 * `extras.vendor.txContact` as a *physical slot* in the talk group bank, and
 * that bank has gaps, so resolving it needs the `tg-<block>-<n>` id format that
 * only that radio uses.
 */

/** A list's name as it can be shown in a sentence. */
const named = (s: string) => {
  const t = s.trim()
  return t === '' ? 'unnamed' : `"${t}"`
}

/** At most eight, because a sentence with forty numbers in it is not a sentence. */
function slotList(list: readonly number[]): string {
  const shown = list.slice(0, 8).join(', ')
  return list.length > 8 ? `${shown} and ${list.length - 8} more` : shown
}

const plural = (n: number, one: string, many = `${one}s`) => (n === 1 ? one : many)

/**
 * Everything about a channel except its name and its slot.
 *
 * The name is left out on purpose: two slots that do the identical thing under
 * different labels are the case worth reporting, because somebody meant them to
 * differ and they do not.
 *
 * `extras.vendor` is in the key, and that is not padding. The DM-32UV fixture
 * holds four channels on 443.125 MHz - "LR DMR", "AR DMR", "USA DMR" and one
 * more - identical in every field this model names, and different only in which
 * talk group they transmit to. Several channels on one repeater frequency
 * differing by talk group alone is how a DMR radio is *used*, and a key without
 * the vendor fields called all four of them duplicates of each other. Its
 * entries are sorted because two equal channels built by different code paths
 * (the decoder and the channel editor) can insert those keys in different
 * orders, and JSON would then report equal objects as different.
 */
function shape(c: Channel): string {
  const vendor = Object.entries(c.extras.vendor ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return JSON.stringify([
    c.rxFreq,
    c.tx,
    c.txAllowed,
    c.tone,
    c.modulation,
    c.bandwidthHz,
    c.power.mW,
    c.tuningStep,
    c.skip,
    vendor,
    c.extras.uvk5 ?? null,
  ])
}

/** Slots the radio owns rather than the user - the UV-K5's VFO band presets. */
function isSpecial(schema: RadioSchema, index: number): boolean {
  return schema.memory.specialChannels.some((s) => s.index === index)
}

export function validateReferences(doc: Codeplug, schema: RadioSchema): Diagnostic[] {
  const out: Diagnostic[] = []
  const live = new Set(doc.channels.keys())
  const f = schema.features

  // ------------------------------------------- membership pointing at nothing

  for (const zone of doc.zones) {
    const dead = zone.channels.filter((c) => !live.has(c))
    if (dead.length > 0) {
      out.push({
        severity: 'warning',
        ruleId: 'codeplug.zone.missing-channel',
        message:
          `Zone ${named(zone.name)} lists ${dead.length} ${plural(dead.length, 'channel')} that no slot ` +
          `holds (${slotList(dead)}). ${plural(dead.length, 'It', 'They')} will be dropped when the ` +
          'codeplug is written.',
      })
    }
    if (f.zones && zone.channels.length > f.zones.channelsPer) {
      const lost = zone.channels.length - f.zones.channelsPer
      out.push({
        severity: 'warning',
        ruleId: 'codeplug.zone.over-capacity',
        message:
          `Zone ${named(zone.name)} has ${zone.channels.length} channels and this radio keeps ` +
          `${f.zones.channelsPer} per zone. The last ${lost} will be dropped when the codeplug is written.`,
      })
    }
  }

  for (const list of doc.scanLists) {
    const dead = list.channels.filter((c) => !live.has(c))
    if (dead.length > 0) {
      out.push({
        severity: 'warning',
        ruleId: 'codeplug.scan-list.missing-channel',
        message:
          `Scan list ${named(list.name)} lists ${dead.length} ${plural(dead.length, 'channel')} that no ` +
          `slot holds (${slotList(dead)}). ${plural(dead.length, 'It', 'They')} will be dropped when the ` +
          'codeplug is written.',
      })
    }
    if (f.scanLists && list.channels.length > f.scanLists.channelsPer) {
      const lost = list.channels.length - f.scanLists.channelsPer
      out.push({
        severity: 'warning',
        ruleId: 'codeplug.scan-list.over-capacity',
        message:
          `Scan list ${named(list.name)} has ${list.channels.length} channels and this radio keeps ` +
          `${f.scanLists.channelsPer} per list. The last ${lost} will be dropped when the codeplug is written.`,
      })
    }

    /*
     * A priority channel is a single slot rather than a member of the list, so
     * it survives the membership filter and reaches the radio as a number
     * pointing at erased memory. What the radio does when a scan reaches it has
     * not been established on hardware, which is the reason to say so here.
     */
    const priorities = [list.priority1, list.priority2].filter(
      (p): p is number => p !== null && p !== undefined && p !== 0 && !live.has(p),
    )
    if (priorities.length > 0) {
      out.push({
        severity: 'warning',
        ruleId: 'codeplug.scan-list.missing-priority',
        message:
          `Scan list ${named(list.name)} has a priority channel on ${plural(priorities.length, 'slot')} ` +
          `${slotList(priorities)}, which ${plural(priorities.length, 'holds', 'hold')} nothing.`,
      })
    }
  }

  // -------------------------------------------------- more than the radio holds

  /*
   * Counted against the schema rather than against the bytes.
   *
   * A list longer than the radio's bank does not fail to encode - the encoders
   * stop at the last slot they have - so the entries past the end are lost in
   * the same silent way a zone member is. `contacts` is included even though
   * the DM-32UV holds fifty thousand of them, because the address book is the
   * one list people fill from an external directory and a cap is reachable
   * there in a way it is not by hand.
   */
  const banks: { label: string; have: number; max: number }[] = [
    ...(f.zones ? [{ label: 'zones', have: doc.zones.length, max: f.zones.max }] : []),
    ...(f.talkGroups ? [{ label: 'talk groups', have: doc.talkGroups.length, max: f.talkGroups.max }] : []),
    ...(f.scanLists ? [{ label: 'scan lists', have: doc.scanLists.length, max: f.scanLists.max }] : []),
    ...(f.rxGroups ? [{ label: 'RX groups', have: doc.rxGroups.length, max: f.rxGroups.max }] : []),
    ...(f.radioIds ? [{ label: 'DMR radio IDs', have: doc.radioIds.length, max: f.radioIds.max }] : []),
    ...(f.contacts ? [{ label: 'contacts', have: doc.contacts.length, max: f.contacts.max }] : []),
    ...(f.messages ? [{ label: 'text messages', have: doc.messages.length, max: f.messages.max }] : []),
  ]
  for (const b of banks) {
    if (b.have <= b.max) continue
    out.push({
      severity: 'warning',
      ruleId: 'codeplug.list.over-capacity',
      message:
        `This codeplug has ${b.have} ${b.label} and the radio holds ${b.max}. ` +
        `The last ${b.have - b.max} will be dropped when the codeplug is written.`,
    })
  }

  // ------------------------------------------------------ truncated on the way

  if (f.messages) {
    const max = f.messages.maxChars
    const over = doc.messages.filter((m) => m.length > max).length
    if (over > 0) {
      out.push({
        severity: 'warning',
        ruleId: 'codeplug.message.too-long',
        message:
          `${over} text ${plural(over, 'message')} ${plural(over, 'is', 'are')} longer than the ` +
          `${max} characters this radio stores, and will be cut short when the codeplug is written.`,
      })
    }
  }

  /*
   * Names, which the encoders cut to length without asking.
   *
   * Encryption key names are deliberately not checked. They are the one string
   * in a codeplug that sits beside key material, and the value of catching a
   * truncated key label does not justify putting it in a diagnostic that other
   * surfaces may go on to render or export.
   */
  const nameBanks: { label: string; names: readonly string[]; max: number }[] = [
    ...(f.zones ? [{ label: 'zone', names: doc.zones.map((z) => z.name), max: f.zones.nameLength }] : []),
    ...(f.talkGroups
      ? [{ label: 'talk group', names: doc.talkGroups.map((g) => g.name), max: f.talkGroups.nameLength }]
      : []),
  ]
  for (const b of nameBanks) {
    const over = b.names.filter((n) => n.length > b.max).length
    if (over === 0) continue
    out.push({
      severity: 'warning',
      ruleId: 'codeplug.name.too-long',
      message:
        `${over} ${b.label} ${plural(over, 'name')} ${plural(over, 'is', 'are')} longer than the ` +
        `${b.max} characters this radio shows, and will be cut short when the codeplug is written.`,
    })
  }

  // ----------------------------------------------------------- says it twice

  /*
   * Duplicates are `info`, not warnings. Nothing is lost and the radio works
   * exactly as programmed; it is a codeplug that has more slots filled than the
   * person meant, which is worth seeing and not worth an alarm. Both of these
   * are silent on all four hardware fixtures, which is the bar a rule at this
   * severity has to clear - one that fires on a factory codeplug is furniture.
   */
  const byNumber = new Map<number, string[]>()
  for (const g of doc.talkGroups) {
    const seen = byNumber.get(g.number)
    if (seen) seen.push(g.name)
    else byNumber.set(g.number, [g.name])
  }
  for (const [number, names] of byNumber) {
    if (names.length < 2) continue
    out.push({
      severity: 'info',
      ruleId: 'codeplug.talk-group.duplicate-number',
      message: `${names.length} talk groups share the number ${number}: ${names.map(named).join(', ')}.`,
    })
  }

  const byShape = new Map<string, number[]>()
  for (const ch of doc.channels.values()) {
    if (isSpecial(schema, ch.index)) continue
    const key = shape(ch)
    const seen = byShape.get(key)
    if (seen) seen.push(ch.index)
    else byShape.set(key, [ch.index])
  }
  for (const group of byShape.values()) {
    if (group.length < 2) continue
    const sorted = [...group].sort((a, b) => a - b)
    for (const index of sorted) {
      const others = sorted.filter((s) => s !== index)
      out.push({
        severity: 'info',
        ruleId: 'codeplug.channel.duplicate',
        channel: index,
        field: 'rxFreq',
        message:
          `Slot ${index} is programmed identically to ${plural(others.length, 'slot')} ` +
          `${slotList(others)}, apart from the name.`,
      })
    }
  }

  return out
}

// SPDX-License-Identifier: GPL-3.0-or-later
import { equalBytes } from '../codec/struct.js'
import type { Codeplug } from '../model/codeplug.js'
import { andList } from '../text/list.js'
import type { RadioDriver } from './driver.js'
import type { RadioImage } from './image.js'
import type { RadioSchema } from './schema.js'

/**
 * Move one radio's codeplug onto another radio of the same model.
 *
 * One person builds a codeplug and sends the file to a club; everyone else
 * wants its contents on their own handset. The image cannot travel - it carries
 * factory calibration that belongs to the unit it was read from, and the
 * drivers refuse to write an image whose calibration disagrees with the radio on
 * the cable, which is the only per-unit identity these radios expose. So the
 * *document* travels instead: the donor's lists are lifted onto the recipient's
 * document, and `encode(doc, base)` renders them back onto the recipient's own
 * image, where calibration and every byte nothing has decoded survive untouched.
 *
 * Two things deliberately stay behind unless they are asked for by name. Both
 * are cases where doing the obvious thing is wrong in a way that is invisible
 * to the person who did it and obvious to everybody else.
 *
 * Settings stay too, unless they are asked for and the schema has said which
 * of them belong to the handset. A fleet run asks, because a club's plan is
 * its keys, tones and menus as much as its channels. A file opened to get
 * somebody's channels does not.
 *
 * Only what the RadioSchema declares moves. A radio-specific list the schema
 * has no feature flag for - the DM-32UV's roaming channels, say - is left as
 * the recipient's, because a radio-agnostic merge has nothing to key on and
 * guessing would mean clearing lists on radios that have them for reasons this
 * module cannot see.
 */

export type TransplantFeature =
  | 'channels'
  | 'zones'
  | 'scanLists'
  | 'talkGroups'
  | 'rxGroups'
  | 'contacts'
  | 'messages'
  | 'radioIds'
  | 'encryptionKeys'
  | 'settings'
  | 'unitSettings'

/** Something that came across, and how much of it. */
export interface CopiedFeature {
  readonly feature: TransplantFeature
  /** The plural noun a person would use, for a sentence rather than a table. */
  readonly label: string
  readonly count: number
}

/** Something the donor carried that was left behind, and why. */
export interface SkippedFeature extends CopiedFeature {
  readonly reason: string
}

export interface TransplantResult {
  readonly codeplug: Codeplug
  readonly copied: readonly CopiedFeature[]
  readonly skipped: readonly SkippedFeature[]
}

export interface TransplantInput {
  /** The codeplug decoded from the file someone else sent. */
  readonly donor: Codeplug
  /** The codeplug read from the radio in front of the user. */
  readonly recipient: Codeplug
  /** The schema for the model both of them are, which decides what can move. */
  readonly schema: RadioSchema
  /** ISO timestamp for the merged document's `modifiedAt`; passed in so this stays pure. */
  readonly now: string
  /**
   * Copy the donor's DMR radio IDs as well.
   *
   * Off unless asked for. Two radios keying up with the same DMR ID share one
   * identity on every repeater they touch, and neither of them can tell.
   */
  readonly copyRadioIds?: boolean | undefined
  /**
   * Copy the donor's encryption key slots as well.
   *
   * Off unless asked for. A business fleet copying its keys is the entire point
   * of the operation; for anyone else, receiving someone else's keys in a file
   * they opened to get channels is a surprise.
   */
  readonly copyEncryptionKeys?: boolean | undefined
  /**
   * Copy the donor's settings as well, all but the ones that belong to the
   * handset.
   *
   * Honored only on a schema that sets `features.settingsTransplant`, which is
   * the claim that its per-unit settings are marked; on any other, every
   * setting stays, asked for or not. And only the fields the schema declares
   * move. A value the driver decodes and the settings page never shows is one
   * nobody here can vouch for the meaning of, so it stays with the radio it
   * came from.
   */
  readonly copySettings?: boolean | undefined
}

export class TransplantError extends Error {
  override readonly name = 'TransplantError'
}

const RADIO_IDS_REASON =
  'Your radio keeps its own DMR ID. Two radios transmitting the same ID share one identity on every ' +
  'repeater they touch, and neither of them can tell - the people listening find out first.'

const KEYS_REASON =
  'Your radio keeps the key slots it already had. Keys are secrets, not settings, and stay with the radio ' +
  'that holds them. Any channel that names a key slot will use whatever your radio holds in that slot.'

const SETTINGS_REASON =
  'Your radio keeps its own settings. Some radios file the DMR ID and the radio’s own name among them, ' +
  'so copying settings wholesale would be a way around keeping the ID.'

/**
 * Lift the donor's contents onto the recipient's document.
 *
 * Every collection that moves is replaced outright rather than merged entry by
 * entry, and the reason is zone and scan list membership: both are lists of
 * absolute channel slots. Keeping the recipient's zones while replacing the
 * channel bank underneath them would leave "Local repeaters" pointing at
 * whichever donor channels happen to occupy slots 1 to 8 - a codeplug that
 * looks right in every list and is wrong on the air.
 *
 * Neither argument is mutated. The result is a fresh document that shares only
 * channel records, which are treated as immutable everywhere else.
 */
export function transplantCodeplug(input: TransplantInput): TransplantResult {
  const { donor, recipient, schema, now } = input

  if (donor.radio !== recipient.radio) {
    throw new TransplantError(
      `This codeplug came from a ${donor.radio ?? 'radio boofwang cannot name'} and the one open is a ` +
        `${recipient.radio ?? 'radio boofwang cannot name'}. Cloning between models would need every ` +
        'channel translated, which boofwang cannot do yet.',
    )
  }
  if (recipient.radio !== null && schema.id !== recipient.radio) {
    throw new TransplantError(
      `The ${schema.id} schema cannot describe a ${recipient.radio} codeplug.`,
    )
  }

  const copied: CopiedFeature[] = []
  const skipped: SkippedFeature[] = []

  // Starts as the recipient's, so anything this function has no opinion about -
  // the VFOs, roaming, the read-only blocks - stays theirs by default rather
  // than by omission.
  const merged: Codeplug = {
    ...recipient,
    // The recipient's own `meta` is kept, `variant` included: it names the
    // firmware of the radio in front of the user, and the write gate compares
    // it against the radio on the cable before anything is sent.
    meta: { ...recipient.meta, modifiedAt: now },
    channels: new Map(donor.channels),
    zones: recipient.zones.map((z) => ({ ...z, channels: [...z.channels] })),
    scanLists: recipient.scanLists.map((l) => ({ ...l, channels: [...l.channels] })),
    talkGroups: recipient.talkGroups.map((g) => ({ ...g })),
    rxGroups: recipient.rxGroups.map((g) => ({ ...g, dmrIds: [...g.dmrIds] })),
    radioIds: recipient.radioIds.map((r) => ({ ...r })),
    contacts: recipient.contacts.map((c) => ({ ...c })),
    messages: [...recipient.messages],
    // Nothing here moves a roaming channel - no schema feature declares them,
    // so a radio-agnostic merge has nothing to key on - but the list is copied
    // all the same, because the result becomes the live document and the editor
    // writes into it.
    roamChannels: recipient.roamChannels.map((c) => ({ ...c })),
    encryptionKeys: recipient.encryptionKeys.map((k) => ({ ...k })),
    settings: { ...recipient.settings },
  }

  copied.push({ feature: 'channels', label: 'channels', count: merged.channels.size })

  if (schema.features.zones !== false) {
    merged.zones = donor.zones.map((z) => ({ ...z, channels: [...z.channels] }))
    copied.push({ feature: 'zones', label: 'zones', count: merged.zones.length })
  }

  if (schema.features.scanLists !== false) {
    merged.scanLists = donor.scanLists.map((l) => ({ ...l, channels: [...l.channels] }))
    copied.push({ feature: 'scanLists', label: 'scan lists', count: merged.scanLists.length })
  }

  if (schema.features.talkGroups !== false) {
    merged.talkGroups = donor.talkGroups.map((g) => ({ ...g }))
    copied.push({ feature: 'talkGroups', label: 'talk groups', count: merged.talkGroups.length })
  }

  if (schema.features.rxGroups !== false) {
    merged.rxGroups = donor.rxGroups.map((g) => ({ ...g, dmrIds: [...g.dmrIds] }))
    copied.push({ feature: 'rxGroups', label: 'RX groups', count: merged.rxGroups.length })
  }

  if (schema.features.contacts !== false) {
    merged.contacts = donor.contacts.map((c) => ({ ...c }))
    copied.push({ feature: 'contacts', label: 'contacts', count: merged.contacts.length })
  }

  if (schema.features.messages !== false) {
    merged.messages = [...donor.messages]
    copied.push({ feature: 'messages', label: 'text messages', count: merged.messages.length })
  }

  // Reported only when the donor actually carries some. A radio with no radio
  // IDs at all has nothing to decline, and listing a skip for it would spend
  // the user's attention on a non-event - which is how the two skips that do
  // matter stop being read.
  if (schema.features.radioIds !== false && donor.radioIds.length > 0) {
    if (input.copyRadioIds === true) {
      merged.radioIds = donor.radioIds.map((r) => ({ ...r }))
      copied.push({ feature: 'radioIds', label: 'DMR radio IDs', count: merged.radioIds.length })
    } else {
      skipped.push({
        feature: 'radioIds',
        label: 'DMR radio IDs',
        count: donor.radioIds.length,
        reason: RADIO_IDS_REASON,
      })
    }
  }

  // An unused key slot decodes to an empty `keyHex`, so the count people care
  // about is the slots that hold something, not the length of the array.
  const donorKeys = donor.encryptionKeys.filter((k) => k.keyHex !== '').length
  if (schema.features.encryption !== false && donorKeys > 0) {
    if (input.copyEncryptionKeys === true) {
      merged.encryptionKeys = donor.encryptionKeys.map((k) => ({ ...k }))
      copied.push({ feature: 'encryptionKeys', label: 'encryption keys', count: donorKeys })
    } else {
      skipped.push({
        feature: 'encryptionKeys',
        label: 'encryption keys',
        count: donorKeys,
        reason: KEYS_REASON,
      })
    }
  }

  const donorSettings = Object.keys(donor.settings).length
  if (donorSettings > 0 && input.copySettings === true && schema.features.settingsTransplant === true) {
    let moved = 0
    let kept = 0
    const keptAs: string[] = []
    const seen = new Set<string>()
    for (const group of schema.settings) {
      for (const field of group.fields) {
        if (seen.has(field.key) || !(field.key in donor.settings)) continue
        seen.add(field.key)
        if (field.perUnit !== undefined) {
          kept++
          if (!keptAs.includes(field.perUnit)) keptAs.push(field.perUnit)
          continue
        }
        const value = donor.settings[field.key]
        // Scalars only. A structured value would be shared by reference
        // between the donor's document and this one, so it stays with the
        // radio; no schema that opts in decodes one, the DM-32UV's bitfields
        // arriving flattened into dotted keys.
        if (typeof value === 'object' && value !== null) continue
        merged.settings[field.key] = value
        moved++
      }
    }
    if (moved > 0) copied.push({ feature: 'settings', label: 'radio settings', count: moved })
    if (kept > 0) {
      skipped.push({
        feature: 'unitSettings',
        label: 'settings that belong to the radio',
        count: kept,
        reason:
          `Your radio keeps its own ${andList(keptAs)}. ` +
          'Those belong to the handset rather than to the channel plan.',
      })
    }
  } else if (donorSettings > 0) {
    skipped.push({
      feature: 'settings',
      label: 'radio settings',
      count: donorSettings,
      reason: SETTINGS_REASON,
    })
  }

  return { codeplug: merged, copied, skipped }
}

/**
 * Whether a file of the open codeplug's model has nothing to transplant onto
 * it, so opening it need not ask whether to apply it instead.
 *
 * Only when the file holds the open codeplug's own bytes and comes from the
 * same physical radio. The question used to be skipped for any file from the
 * same radio, on the reasoning that applying it and opening it come to the
 * same thing, and when the bytes differ they do not. Opening makes the file's
 * image the base a write is worked out against. A file older than what the
 * radio holds, opened, edited and written, used to leave the UV-82 and UV-5G
 * their own blocks wherever the two disagreed and nothing was edited, while
 * the screen showed the file's; the driver now reads the radio first and
 * refuses instead. Applying keeps the open codeplug's image as the base, so
 * the edit can be written rather than refused. The adversarial review of the
 * UV-5R family's fingerprint found this, when that fingerprint started
 * skipping the question on those two radios.
 *
 * A driver with nothing per-unit to hash returns null, and that means "cannot
 * tell", never "matches", so the question is asked.
 */
export async function nothingToTransplant(
  file: RadioImage,
  open: RadioImage,
  driver: Pick<RadioDriver, 'unitFingerprint'>,
): Promise<boolean> {
  if (file.radioId !== open.radioId) return false
  const [theirs, ours] = await Promise.all([driver.unitFingerprint(file), driver.unitFingerprint(open)])
  if (theirs === null || ours === null || theirs !== ours) return false
  return (
    file.regions.length === open.regions.length &&
    file.regions.every((r) => {
      const o = open.regions.find((x) => x.start === r.start)
      return o !== undefined && equalBytes(r.data, o.data)
    })
  )
}

/**
 * What a settings transplant leaves on each radio, as the phrases the schema
 * gives its per-unit fields, in schema order and without repeats.
 *
 * Null when the schema lets no setting move at all, which is a different
 * sentence from "they all move".
 */
export function settingsKeptByEachRadio(schema: RadioSchema): readonly string[] | null {
  if (schema.features.settingsTransplant !== true) return null
  const out: string[] = []
  for (const group of schema.settings) {
    for (const field of group.fields) {
      if (field.perUnit !== undefined && !out.includes(field.perUnit)) out.push(field.perUnit)
    }
  }
  return out
}

/** The document field each copied feature comes from. */
const FIELD: Readonly<Record<TransplantFeature, keyof Codeplug>> = {
  channels: 'channels',
  zones: 'zones',
  scanLists: 'scanLists',
  talkGroups: 'talkGroups',
  rxGroups: 'rxGroups',
  contacts: 'contacts',
  messages: 'messages',
  radioIds: 'radioIds',
  encryptionKeys: 'encryptionKeys',
  settings: 'settings',
  unitSettings: 'settings',
}

/**
 * The copied features in which applying a merge replaces an unwritten edit.
 *
 * Every collection a transplant copies comes wholly from the donor, so an edit
 * made to one of them on the open codeplug is gone once the merge is applied,
 * and undo cannot bring it back: the history goes with the document it
 * described. An edit anywhere else survives the merge, and asking about it
 * would put a slide in front of a merge that loses nothing.
 *
 * `baseline` is the recipient as its own image holds it, which is what an edit
 * is measured from. Compared by value rather than through the history, so an
 * edit taken back by undo or typed back by hand is not counted, and neither is
 * one the donor happens to make the same way.
 */
export function editsReplaced(
  baseline: Codeplug,
  recipient: Codeplug,
  merge: TransplantResult,
): CopiedFeature[] {
  return merge.copied.filter((c) => {
    const field = FIELD[c.feature]
    return !sameValue(baseline[field], recipient[field]) && !sameValue(merge.codeplug[field], recipient[field])
  })
}

/**
 * Equal by value, for the plain data a decoded document is made of.
 *
 * Key order is not compared. An edit is a spread over the decoded record, and
 * a field the decoder left out and the editor added lands last, which a
 * comparison by serialization would count as a change nobody made.
 */
function sameValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  if (a instanceof Map || b instanceof Map) {
    if (!(a instanceof Map) || !(b instanceof Map) || a.size !== b.size) return false
    for (const [key, value] of a) if (!b.has(key) || !sameValue(value, b.get(key))) return false
    return true
  }
  if (ArrayBuffer.isView(a) || ArrayBuffer.isView(b)) {
    if (!(a instanceof Uint8Array) || !(b instanceof Uint8Array) || a.length !== b.length) return false
    return a.every((byte, i) => byte === b[i])
  }
  if (Array.isArray(a) !== Array.isArray(b)) return false
  const left = a as Record<string, unknown>
  const right = b as Record<string, unknown>
  const keys = Object.keys(left)
  if (keys.length !== Object.keys(right).length) return false
  return keys.every((key) => Object.hasOwn(right, key) && sameValue(left[key], right[key]))
}

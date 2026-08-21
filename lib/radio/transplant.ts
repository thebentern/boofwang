// SPDX-License-Identifier: GPL-3.0-or-later
import type { Codeplug } from '../model/codeplug.js'
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
}

export class TransplantError extends Error {
  override readonly name = 'TransplantError'
}

const RADIO_IDS_REASON =
  'Your radio keeps its own DMR ID. Two radios transmitting the same ID share one identity on every ' +
  'repeater they touch, and neither of them can tell - the people listening find out first.'

const KEYS_REASON =
  'Your radio keeps the key slots it already had. Keys are the one thing in a codeplug that is a secret ' +
  'rather than a setting. Any channel that names a key slot will use whatever your radio holds in that slot.'

const SETTINGS_REASON =
  'Your radio keeps its own settings. Some radios file the DMR ID and the unit’s own name among them, ' +
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
  if (donorSettings > 0) {
    skipped.push({
      feature: 'settings',
      label: 'radio settings',
      count: donorSettings,
      reason: SETTINGS_REASON,
    })
  }

  return { codeplug: merged, copied, skipped }
}

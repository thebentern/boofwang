// SPDX-License-Identifier: GPL-3.0-or-later
import type { Codeplug, DmrRadioId } from '../model/codeplug.js'
import type { RadioSchema } from './schema.js'
import type { CopiedFeature, SkippedFeature } from './transplant.js'
import { transplantCodeplug } from './transplant.js'

/**
 * One codeplug onto a room full of radios, varying only what belongs to each
 * handset.
 *
 * A club buys twenty DM-32UVs, one person builds the channel plan, and every
 * radio needs it. What must not travel with it is the identity: a DMR ID is
 * personal, and twenty radios keying up with the same one share a single
 * identity on every repeater they touch, with no way for any of them to tell.
 * That is the whole reason this module exists rather than "clone the file
 * twenty times" - the roster is the record of which ID goes in which radio, and
 * applying it is a step nobody can skip by forgetting.
 *
 * Nothing here talks to a radio. It builds the document for one unit and says
 * what it did; the per-unit read, the backup, the diff and the write are the
 * ordinary ones, run once per handset. There is deliberately no fleet write
 * path - see `useFleetSession`.
 */

/** One radio in the run, and the two things about it that are its own. */
export interface FleetUnit {
  /** Stable across edits to the roster, so run state can be keyed on it. */
  readonly id: string
  /** What the person running the session calls this radio: "Dave's HT", "Unit 4". */
  readonly label: string
  /**
   * The DMR ID this radio will transmit as, or null to leave whatever it holds.
   *
   * Null is a real case rather than an empty field: a club pushing a new
   * channel plan to radios that already carry their owners' IDs wants exactly
   * that, and inventing a zero here would program a radio with no identity.
   */
  readonly dmrId: number | null
  /**
   * The name filed with that ID - a callsign, on every club roster seen so far.
   *
   * Empty means leave the radio's own. There is no way to clear a name from
   * here on purpose: this tool assigns identities, and "the field is blank so
   * wipe it" is not a thing anybody means when filling in a spreadsheet.
   */
  readonly name: string
}

/**
 * What became of one row, once a radio has been put in front of it.
 *
 * Lives here rather than with the run state because it is the record a club
 * keeps: which radio took which identity, and when. The CSV writer in
 * `lib/io/fleet-roster.ts` renders it, and neither needs a browser.
 */
export type FleetUnitState = 'written' | 'failed' | 'skipped'

export interface FleetOutcome {
  readonly state: FleetUnitState
  /** ISO timestamp of the attempt. */
  readonly at: string
  /**
   * The physical radio this row was written to.
   *
   * Null on radios whose driver has nothing unit-specific to hash, which must
   * be read as "cannot tell" rather than "no match" - see `unitFingerprint`.
   */
  readonly unitHash: string | null
  readonly blocks: number
  readonly note: string
}

export interface FleetProblem {
  readonly severity: 'error' | 'warning'
  readonly ruleId: string
  readonly message: string
  /** The `FleetUnit.id` this is about, when it is about one row. */
  readonly unit?: string
}

/** A per-unit value this plan replaces, and what it replaces. */
export interface FleetOverride {
  readonly field: 'dmrId' | 'name'
  /** What the radio in front of the user holds now, rendered for a person. */
  readonly from: string
  readonly to: string
}

export interface FleetPlan {
  /** The document to encode onto this unit's own image. */
  readonly codeplug: Codeplug
  readonly copied: readonly CopiedFeature[]
  readonly skipped: readonly SkippedFeature[]
  /** Empty when the radio already holds what the roster asks for. */
  readonly overrides: readonly FleetOverride[]
  /**
   * DMR IDs this radio holds beyond the first, left exactly as they are.
   *
   * Surfaced rather than silently kept. A second-hand handset can arrive
   * carrying the previous owner's IDs, and a channel that asks for radio ID 2
   * would transmit as them - so the person running the session is told the
   * slots are there instead of finding out from somebody on the repeater.
   */
  readonly carriedRadioIds: readonly DmrRadioId[]
}

export interface FleetPlanInput {
  /** The club codeplug: the thing every radio in the run is getting. */
  readonly master: Codeplug
  /** The roster row for the radio currently on the cable. */
  readonly unit: FleetUnit
  /** What was just read off that radio, decoded. */
  readonly recipient: Codeplug
  readonly schema: RadioSchema
  /** ISO timestamp for `modifiedAt`; passed in so this stays pure. */
  readonly now: string
  /**
   * Send the master's key slots as well.
   *
   * Off unless asked for, exactly as in a one-radio clone. A business fleet
   * sharing its keys is the case this whole screen exists for, and a ham club
   * receiving somebody's keys because they wanted the channel list is not.
   */
  readonly copyEncryptionKeys?: boolean | undefined
}

/**
 * Build the document for one unit: the master's lists, this radio's identity.
 *
 * The transplant is the same one a single-radio clone uses, with `copyRadioIds`
 * nailed to false rather than offered. It is not a preference here - the roster
 * is where the IDs come from, and an option to take the master's instead would
 * be an option to give twenty radios one identity.
 *
 * The override lands in the first radio ID slot because that is the one a
 * channel falls back to when it names a slot the radio does not have, which is
 * exactly what happens to every channel arriving from a master built on a
 * different handset. Slots past the first are left alone and reported.
 */
export function planFleetUnit(input: FleetPlanInput): FleetPlan {
  const { master, unit, recipient, schema, now } = input

  const merged = transplantCodeplug({
    donor: master,
    recipient,
    schema,
    now,
    copyRadioIds: false,
    ...(input.copyEncryptionKeys === undefined ? {} : { copyEncryptionKeys: input.copyEncryptionKeys }),
  })

  const doc = merged.codeplug
  const overrides: FleetOverride[] = []

  // A radio with no DMR identity to set has nothing to vary, and the roster's
  // columns are hidden for it. Returning the transplant unchanged is the whole
  // of "fleet programming" on such a radio, and it is still worth having: the
  // per-unit backup, diff and write are what the run is really made of.
  const feature = schema.features.radioIds
  if (feature === false) {
    return { ...merged, overrides, carriedRadioIds: [] }
  }

  const ids = doc.radioIds
  const current = ids[0] ?? null
  const wantName = unit.name.trim()
  const wantId = unit.dmrId

  if (wantId === null && wantName === '') {
    return { ...merged, overrides, carriedRadioIds: ids.slice(1).map((r) => ({ ...r })) }
  }

  const nextId = wantId ?? current?.dmrId ?? 0
  const nextName = wantName !== '' ? wantName.slice(0, feature.nameLength) : (current?.name ?? '')

  if ((current?.dmrId ?? 0) !== nextId) {
    overrides.push({ field: 'dmrId', from: current ? String(current.dmrId) : 'none', to: String(nextId) })
  }
  if ((current?.name ?? '') !== nextName) {
    overrides.push({ field: 'name', from: current?.name || 'none', to: nextName })
  }

  // `rid-1` is not decoration: the encoder reads the slot number out of the id
  // to decide where a record goes, and an entry it cannot parse is treated as
  // new and placed in the lowest free slot - which, on a radio that already has
  // one, is the second.
  const first: DmrRadioId = { id: current?.id ?? 'rid-1', name: nextName, dmrId: nextId }
  const carried = ids.slice(1).map((r) => ({ ...r }))
  doc.radioIds = [first, ...carried]

  return { ...merged, overrides, carriedRadioIds: carried.map((r) => ({ ...r })) }
}

/**
 * Everything wrong with a roster, before a single radio is plugged in.
 *
 * The check that matters is the duplicate ID. Every other problem here shows
 * itself the moment somebody keys up - a truncated name is visible on the
 * screen, an out-of-range ID is refused by the encoder - but two radios sharing
 * an identity looks perfect from both handsets and is only ever diagnosed by
 * the people listening.
 */
export function validateFleetRoster(
  roster: readonly FleetUnit[],
  schema: RadioSchema,
): FleetProblem[] {
  const out: FleetProblem[] = []
  const feature = schema.features.radioIds

  if (roster.length === 0) {
    out.push({
      severity: 'error',
      ruleId: 'fleet.roster.empty',
      message: 'The roster has no radios in it, so there is nothing to programme.',
    })
    return out
  }

  const byId = new Map<number, FleetUnit[]>()
  const byLabel = new Map<string, FleetUnit[]>()

  for (const unit of roster) {
    const key = unit.label.trim().toLowerCase()
    if (key !== '') byLabel.set(key, [...(byLabel.get(key) ?? []), unit])

    if (unit.dmrId !== null) {
      if (feature === false) {
        out.push({
          severity: 'error',
          ruleId: 'fleet.id.unsupported',
          unit: unit.id,
          message:
            `${describe(unit)} carries a DMR ID, and the ${schema.model} has no DMR identity to put it in.`,
        })
      } else {
        byId.set(unit.dmrId, [...(byId.get(unit.dmrId) ?? []), unit])
        if (!Number.isInteger(unit.dmrId) || unit.dmrId <= 0 || unit.dmrId > feature.maxId) {
          out.push({
            severity: 'error',
            ruleId: 'fleet.id.range',
            unit: unit.id,
            message:
              `${describe(unit)} has DMR ID ${unit.dmrId}. The ${schema.model} stores a whole number ` +
              `from 1 to ${feature.maxId.toLocaleString()}.`,
          })
        }
      }
    }

    const name = unit.name.trim()
    if (name !== '' && feature !== false && name.length > feature.nameLength) {
      out.push({
        severity: 'warning',
        ruleId: 'fleet.name.too-long',
        unit: unit.id,
        message:
          `${describe(unit)} has a ${name.length}-character name and the ${schema.model} stores ` +
          `${feature.nameLength}. It will be programmed as ${JSON.stringify(name.slice(0, feature.nameLength))}.`,
      })
    }
  }

  for (const [dmrId, units] of byId) {
    if (units.length < 2) continue
    out.push({
      severity: 'error',
      ruleId: 'fleet.id.duplicate',
      unit: units[1]!.id,
      message:
        `${units.length} radios in this roster are set to DMR ID ${dmrId} ` +
        `(${units.map((u) => describe(u)).join(', ')}). Radios sharing an ID share one identity on every ` +
        'repeater they touch, and none of them can tell - the people listening find out first.',
    })
  }

  for (const [, units] of byLabel) {
    if (units.length < 2) continue
    out.push({
      severity: 'warning',
      ruleId: 'fleet.label.duplicate',
      unit: units[1]!.id,
      message:
        `${units.length} rows are called ${JSON.stringify(units[0]!.label)}. The run asks you to plug in ` +
        'a named radio, and two rows with one name is how the wrong one gets written.',
    })
  }

  return out
}

/**
 * The row this physical radio already took in this run, or null.
 *
 * The failure it prevents: twenty identical handsets go through one cable over
 * an afternoon, nothing on the outside of any of them says which have been
 * done, and one gets picked up twice. Writing the second row to it would give
 * it that row's identity and leave the first row describing a radio that no
 * longer holds it - so two people would be issued one DMR ID, which is the
 * exact thing this whole feature exists to prevent, arrived at from the other
 * direction.
 *
 * A null fingerprint means the driver has nothing per-unit to hash. That is
 * "cannot tell", never "no match", so nothing is claimed on that path.
 */
export function unitAlreadyProgrammed(
  unitHash: string | null,
  forUnitId: string,
  outcomes: Readonly<Record<string, FleetOutcome>>,
): string | null {
  if (unitHash === null) return null
  for (const [id, outcome] of Object.entries(outcomes)) {
    if (id === forUnitId) continue
    if (outcome.state === 'written' && outcome.unitHash === unitHash) return id
  }
  return null
}

/** How a roster row is referred to in a sentence. */
function describe(unit: FleetUnit): string {
  return unit.label.trim() === '' ? 'An unnamed row' : JSON.stringify(unit.label.trim())
}

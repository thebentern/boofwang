// SPDX-License-Identifier: GPL-3.0-or-later
import type { Modulation, TxSpec } from '../model/channel.js'
import type { TonePair } from '../model/tones.js'
import type { HostCapability } from '../platform/host.js'
import type { Hz } from '../model/units.js'

/**
 * External sources of repeater and talk group data.
 *
 * Everything here is somebody else's data, fetched at runtime and never
 * committed. Each source carries its own attribution and licence because that
 * is the consideration boofwang offers in return for using it, and because
 * `docs/provenance.md` has to be able to say where every byte came from. A
 * source with no attribution is a bug, and there is a test that says so.
 *
 * Metadata lives here; the code that actually talks to a source lives in its
 * own module and is reached by dynamic import. That separation is what lets the
 * web build list a source it cannot reach - so the interface can say honestly
 * that it exists and needs the desktop app - without shipping the request code
 * or the endpoint for it.
 */

/**
 * One repeater, normalised.
 *
 * Deliberately not a `PresetChannel`: this carries what the search interface
 * needs to show (who runs it, where it is, whether it is up) alongside what a
 * channel needs. `repeaterToPreset` narrows it, and `clampChannel` after that
 * is what decides whether any given radio can hold it.
 */
export interface RepeaterRecord {
  /** Which `DataSource` produced this. */
  readonly sourceId: string
  /**
   * The upstream record's own identifier, so a bad record can be reported in
   * terms its publisher recognises rather than as "row 4,812 of what we fetched".
   */
  readonly ref: string
  readonly callsign: string
  /** Trimmed to nothing when upstream has no usable name; never invented. */
  readonly name: string
  readonly city: string
  /**
   * The frequency *this radio* receives on, which is the frequency the repeater
   * transmits on.
   *
   * Sources publish this from the repeater's point of view and do not agree on
   * how to say so: Brandmeister's `tx` is the repeater transmitting, therefore
   * this field; hearham's `frequency` is the output, therefore also this field.
   * Getting the two the wrong way round produces a channel that hears nothing
   * and transmits on the output, which is both useless and rude. Every adapter
   * states its mapping where it makes it.
   */
  readonly rxFreq: Hz
  /** Where this radio would transmit, derived from the repeater's input. */
  readonly tx: TxSpec
  readonly tone: TonePair
  readonly modulation: Modulation
  readonly bandwidthHz: number
  /** Absent when upstream published no coordinates, which is common. */
  readonly location?: { readonly lat: number; readonly lon: number }
  /**
   * Whether the source believes the repeater is on the air. Sources that do not
   * track it report `true`, so this is a reason to hide something, never a
   * reason to trust that the rest is current.
   */
  readonly operational: boolean
  readonly dmr?: DmrParams
}

/**
 * The DMR settings a repeater listing can supply.
 *
 * No power, no radio ID and no encryption: those are properties of the operator
 * and their licence, not of the repeater, and a directory has no business
 * setting them.
 */
export interface DmrParams {
  /**
   * Range-checked against the target radio before use. Upstream data really
   * does carry values above 15, and the DM-32UV stores this in four bits.
   */
  readonly colorCode: number
  readonly timeSlot?: 1 | 2
  readonly talkgroup?: number
}

/**
 * One DMR talk group.
 *
 * Not a channel and not a contact - a talk group is a number the network routes
 * on, and the DM-32UV keeps it in a list of its own. `lib/model/codeplug.ts`
 * spells out why the three are separate types.
 */
export interface TalkGroupRecord {
  readonly sourceId: string
  readonly number: number
  readonly name: string
}

/**
 * A record that could not be read, reported against the identifier its
 * publisher uses.
 *
 * Mirrors `CsvRowIssue` in `lib/io/chirp-csv-import.ts` on purpose: one bad
 * record never costs the rest of the fetch, and the problem is always
 * attributable to something the user can go and look at.
 */
export interface SourceIssue {
  readonly ref: string
  readonly severity: 'error' | 'warning'
  readonly message: string
}

export interface SourceResult {
  readonly records: readonly RepeaterRecord[]
  readonly issues: readonly SourceIssue[]
}

/** What a source can be asked for. Not every source honours every field. */
export interface SourceQuery {
  readonly near?: { readonly lat: number; readonly lon: number }
  /** Kilometres from `near`. Ignored without it. */
  readonly withinKm?: number
  readonly modes?: readonly Modulation[]
  readonly callsign?: string
}

export interface DataSource {
  readonly id: string
  readonly name: string
  /** Shown wherever data from this source is displayed, and copied onto every channel it produces. */
  readonly attribution: string
  /** What the publisher permits, in one line. Never guessed - see docs/provenance.md. */
  readonly licence: string
  readonly homepage: string
  /**
   * Whether to offer this source at all.
   *
   * The off switch for a publisher who asks us to stop. Flipping this must be
   * the entire change required, which is why nothing outside this registry
   * names a source directly.
   */
  readonly enabled: boolean
  /** What this source requires of its host. Empty means it works anywhere. */
  readonly needs: readonly HostCapability[]
}

/**
 * How a source reaches the network.
 *
 * Supplied by the host rather than called directly, so `lib/` never names
 * `fetch`, the desktop build can route through its own validated channel, and a
 * test can hand over a recorded response instead of touching the network.
 */
export type JsonFetcher = (url: string) => Promise<unknown>

export interface TalkGroupResult {
  readonly talkGroups: readonly TalkGroupRecord[]
  readonly issues: readonly SourceIssue[]
}

/** The query half of a source, loaded separately from its metadata. */
export interface SourceImpl {
  readonly id: string
  fetchRepeaters(get: JsonFetcher, query: SourceQuery): Promise<SourceResult>
  /** Only DMR networks publish these. */
  fetchTalkGroups?(get: JsonFetcher): Promise<TalkGroupResult>
}

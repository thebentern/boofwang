// SPDX-License-Identifier: GPL-3.0-or-later
import { importChirpCsv, type CsvRowIssue } from '#core/io/chirp-csv-import.js'
import type { PresetChannel, PresetSet } from '#core/io/preset-data.js'
import type { RepeaterRecord } from '#core/data/source.js'
import { LEGACY_PRESETS_KEY } from '#core/storage/db.js'
import { hz, mW } from '#core/model/units.js'

/**
 * Channel sets the user brought in themselves.
 *
 * These lived in `localStorage`, on the reasoning that a set was a few
 * kilobytes of frequencies rather than something irreplaceable. That held while
 * a set meant a CHIRP CSV. It stopped holding the moment a set could be a
 * fetched repeater list: tens of thousands of records is past the ~5 MB origin
 * cap several times over, and the old code caught the quota error and said
 * nothing, so a set worked for the session and was gone on reload.
 *
 * Now in IndexedDB, one record per set, with a quota failure reported rather
 * than swallowed. The old key is read once and migrated, so nobody loses what
 * they had.
 */

const STORAGE_KEY = LEGACY_PRESETS_KEY

export interface ImportResultSummary {
  readonly set: PresetSet | null
  readonly issues: readonly CsvRowIssue[]
  readonly unknownColumns: readonly string[]
}

function toPresetChannel(c: {
  name: string
  rxFreq: number
  tx: PresetChannel['tx']
  txAllowed: boolean
  tone: PresetChannel['tone']
  bandwidthHz: number
  power: { mW: number }
}): PresetChannel {
  return {
    name: c.name,
    rxFreq: hz(c.rxFreq),
    tx: c.tx,
    txAllowed: c.txAllowed,
    tone: c.tone,
    bandwidthHz: c.bandwidthHz,
    powerMW: mW(c.power.mW),
  }
}

/** A fetched repeater as a stageable channel. */
function repeaterToPreset(r: RepeaterRecord): PresetChannel {
  return {
    name: r.callsign || r.city,
    rxFreq: r.rxFreq,
    tx: r.tx,
    // A repeater is there to be transmitted through. Whether this particular
    // radio may is `clampChannel`'s decision, made against its bands.
    txAllowed: true,
    tone: r.tone,
    bandwidthHz: r.bandwidthHz,
    // No power: see `PresetChannel.powerMW`. The directory does not say, so
    // neither does this, and staging takes the radio's own maximum.
    modulation: r.modulation,
    ...(r.dmr === undefined ? {} : { dmr: r.dmr }),
  }
}

const imported = ref<PresetSet[]>([])
let loaded = false

/** Newest first, which the base-36 timestamp in the id already sorts by. */
const byNewest = (a: PresetSet, b: PresetSet) => b.id.localeCompare(a.id)

/**
 * A set id that cannot collide.
 *
 * The millisecond alone did: importing two files from one picker produced two
 * sets with the same id, and the second overwrote the first in a store keyed on
 * it.
 */
function newId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`
}

export function useImportedPresets() {
  const db = useBoofwangDb()

  async function load() {
    if (loaded) return
    loaded = true
    try {
      const stored = await db.listPresets()
      if (stored.length > 0) {
        imported.value = stored.sort(byNewest)
        return
      }
      // Nothing in IndexedDB. Anything under the old key is this user's, from
      // before the move, and is theirs to keep.
      if (typeof localStorage === 'undefined') return
      const raw = localStorage.getItem(STORAGE_KEY)
      if (!raw) return
      const legacy = JSON.parse(raw) as PresetSet[]
      if (!Array.isArray(legacy) || legacy.length === 0) return
      for (const s of legacy) await db.putPreset(s)
      imported.value = legacy.sort(byNewest)
      // Only removed once every set is safely in the new store, so an
      // interrupted migration repeats rather than loses.
      localStorage.removeItem(STORAGE_KEY)
    } catch {
      imported.value = []
    }
  }

  /**
   * Keep a set, or say why it could not be kept.
   *
   * Throws rather than swallowing. The caller has a toast; a set that silently
   * failed to save looks identical to one that saved, right up until the page
   * is reloaded.
   *
   * The JSON round-trip is not paranoia. A set assembled from anything that has
   * been through a `ref` carries Vue reactive proxies, and IndexedDB's
   * structured clone refuses them outright - "#<Object> could not be cloned",
   * thrown from `put`, after the search has already succeeded. `toRaw` only
   * unwraps the top level, and a `PresetSet` is plain data all the way down, so
   * this is both sufficient and honest about what it does.
   */
  async function store(set: PresetSet) {
    const plain = JSON.parse(JSON.stringify(set)) as PresetSet
    await db.putPreset(plain)
    imported.value = [plain, ...imported.value.filter((s) => s.id !== plain.id)]
  }

  /**
   * Read a CHIRP CSV into a set.
   *
   * RepeaterBook, RadioReference and CHIRP itself all export this format, so
   * one reader serves all three and none of them needs a network call, an API
   * key, or the user's password for somebody else's site.
   */
  async function importCsv(name: string, text: string): Promise<ImportResultSummary> {
    const { channels, issues, unknownColumns } = importChirpCsv(text)
    if (channels.length === 0) return { set: null, issues, unknownColumns }

    const base = name.replace(/\.[^.]+$/, '')
    const set: PresetSet = {
      id: newId('imported'),
      group: 'saved',
      name: base,
      shortName: base.slice(0, 28),
      icon: 'i-lucide-file-down',
      source: 'Saved here',
      description: `${channels.length} channel${channels.length === 1 ? '' : 's'} imported from ${name}.`,
      licence: 'Whatever the frequencies in this file require. boofwang did not write them and cannot say.',
      attribution: name,
      stepHz: hz(5000),
      channels: channels.map(toPresetChannel),
    }

    await store(set)
    return { set, issues, unknownColumns }
  }

  /**
   * Keep a set of repeaters fetched from a directory.
   *
   * The attribution and licence come from the source's registry entry rather
   * than from anything typed here, so the credit shown beside the channels is
   * the same string `docs/provenance.md` records.
   */
  async function saveFetched(
    name: string,
    records: readonly RepeaterRecord[],
    source: { name: string; attribution: string; licence: string },
  ): Promise<PresetSet> {
    const set: PresetSet = {
      id: newId('fetched'),
      group: 'saved',
      name,
      shortName: name.slice(0, 28),
      icon: 'i-lucide-radio-tower',
      source: 'Saved here',
      description: `${records.length} repeater${records.length === 1 ? '' : 's'} from ${source.name}.`,
      licence: source.licence,
      attribution: source.attribution,
      stepHz: hz(5000),
      channels: records.map(repeaterToPreset),
    }
    await store(set)
    return set
  }

  /** Keep a set of channels from the open codeplug for reuse on another radio. */
  async function saveSet(name: string, channels: readonly PresetChannel[]): Promise<PresetSet> {
    const set: PresetSet = {
      id: newId('saved'),
      group: 'saved',
      name,
      shortName: name.slice(0, 28),
      icon: 'i-lucide-save',
      source: 'Saved here',
      description: `${channels.length} channel${channels.length === 1 ? '' : 's'} saved from a codeplug.`,
      licence: 'Whatever the frequencies in this file require. boofwang did not write them and cannot say.',
      attribution: 'Saved in this browser',
      stepHz: hz(5000),
      channels: [...channels],
    }
    await store(set)
    return set
  }

  async function remove(id: string) {
    await db.deletePreset(id)
    imported.value = imported.value.filter((s) => s.id !== id)
  }

  return { imported: readonly(imported), load, importCsv, saveFetched, saveSet, remove }
}

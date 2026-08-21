import { importChirpCsv, type CsvRowIssue } from '#core/io/chirp-csv-import.js'
import type { PresetChannel, PresetSet } from '#core/io/preset-data.js'
import { hz, mW } from '#core/model/units.js'

/**
 * Channel sets the user brought in themselves.
 *
 * Kept in `localStorage` rather than IndexedDB: a set is a few kilobytes of
 * frequencies, it is the user's own file rather than something irreplaceable,
 * and the simpler store means one less thing between them and a programmed
 * radio. Backups of radios, which cannot be re-downloaded, live in IndexedDB.
 */
const STORAGE_KEY = 'boofwang:presets'

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

const imported = ref<PresetSet[]>([])
let loaded = false

function persist() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(imported.value))
  } catch {
    // A full or disabled store is not worth interrupting anyone over; the set
    // still works for this session.
  }
}

export function useImportedPresets() {
  if (!loaded && typeof localStorage !== 'undefined') {
    loaded = true
    try {
      const raw = localStorage.getItem(STORAGE_KEY)
      if (raw) imported.value = JSON.parse(raw) as PresetSet[]
    } catch {
      imported.value = []
    }
  }

  /**
   * Read a CHIRP CSV into a set.
   *
   * RepeaterBook, RadioReference and CHIRP itself all export this format, so
   * one reader serves all three and none of them needs a network call, an API
   * key, or the user's password for somebody else's site.
   */
  function importCsv(name: string, text: string): ImportResultSummary {
    const { channels, issues, unknownColumns } = importChirpCsv(text)
    if (channels.length === 0) return { set: null, issues, unknownColumns }

    const set: PresetSet = {
      id: `imported-${Date.now().toString(36)}`,
      group: 'saved',
      name: name.replace(/\.[^.]+$/, ''),
      shortName: name.replace(/\.[^.]+$/, '').slice(0, 28),
      icon: 'i-lucide-file-down',
      source: 'Saved here',
      description: `${channels.length} channel${channels.length === 1 ? '' : 's'} imported from ${name}.`,
      licence: 'Whatever the frequencies in this file require — boofwang did not write them and cannot say.',
      attribution: name,
      stepHz: hz(5000),
      channels: channels.map(toPresetChannel),
    }

    imported.value = [set, ...imported.value]
    persist()
    return { set, issues, unknownColumns }
  }

  /** Keep a set of channels from the open codeplug for reuse on another radio. */
  function saveSet(name: string, channels: readonly PresetChannel[]): PresetSet {
    const set: PresetSet = {
      id: `saved-${Date.now().toString(36)}`,
      group: 'saved',
      name,
      shortName: name.slice(0, 28),
      icon: 'i-lucide-save',
      source: 'Saved here',
      description: `${channels.length} channel${channels.length === 1 ? '' : 's'} saved from a codeplug.`,
      licence: 'Whatever the frequencies in this file require — boofwang did not write them and cannot say.',
      attribution: 'Saved in this browser',
      stepHz: hz(5000),
      channels: [...channels],
    }
    imported.value = [set, ...imported.value]
    persist()
    return set
  }

  function remove(id: string) {
    imported.value = imported.value.filter((s) => s.id !== id)
    persist()
  }

  return { imported: readonly(imported), importCsv, saveSet, remove }
}

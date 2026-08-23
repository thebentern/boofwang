// SPDX-License-Identifier: GPL-3.0-or-later
// Vue's reactivity is imported rather than left to Nuxt's auto-imports, as the
// codeplug store does and for the same reason: this store is exercised by a
// spec that mounts it under a bare Pinia, and outside the Nuxt build there is
// nothing to supply `ref` and `computed`. Nuxt prefers an explicit import to
// its own, so nothing changes for the app.
import { computed, markRaw, ref, shallowRef, toRaw } from 'vue'
import { defineStore } from 'pinia'
import { validateFleetRoster, type FleetOutcome, type FleetPlan, type FleetUnit } from '#core/radio/fleet.js'
import type { Codeplug, RadioId } from '#core/model/codeplug.js'
import { SCHEMAS } from '#core/radio/registry.js'

/**
 * A fleet run: one codeplug, a roster of radios, and a record of which ones
 * have had it.
 *
 * The record is the part that has to be right. Twenty handsets go through one
 * cable over an afternoon, they all look the same, and the only question that
 * matters afterwards is which of them were done - so every row carries the
 * fingerprint of the physical unit that took it, and a radio presented twice is
 * caught rather than programmed twice with two different identities.
 *
 * Nothing here is persisted. That is deliberate rather than unfinished: the
 * master codeplug lives in the codeplug store and is lost on a reload too, and
 * a run whose roster survived a reload while its document did not would be a
 * half-restored session that looks whole. The roster exports as CSV, which is
 * the part worth keeping.
 */

/** What the roster editor shows about the codeplug every radio is getting. */
export interface MasterFacts {
  readonly title: string
  readonly variant: string | null
  readonly channels: number
  readonly zones: number
  readonly talkGroups: number
  readonly keys: number
}

export const useFleetStore = defineStore('fleet', () => {
  const roster = ref<FleetUnit[]>([])

  /**
   * The radio model the roster is for.
   *
   * Set before the run as well as during it, and that is not a detail: the
   * duplicate-ID check needs a schema to know what a DMR ID may be, and the
   * whole point of it is to fire while the roster is still being typed. Left
   * to `startRun` it was null until the moment it stopped mattering, so a
   * roster with two radios on one ID started the run without a word.
   */
  const radio = ref<RadioId | null>(null)

  /**
   * The club codeplug, cloned out of the editor when the run starts.
   *
   * A clone rather than a reference, and the reason is the first read: reading
   * a unit replaces the editor's document with that radio's, so by the time the
   * master is needed the store no longer holds it. Copying once per run is
   * proportionate - every unit's transplant copies the same lists again anyway.
   */
  const master = shallowRef<Codeplug | null>(null)
  const masterFacts = ref<MasterFacts | null>(null)
  const copyKeys = ref(false)

  const outcomes = ref<Record<string, FleetOutcome>>({})
  const currentId = ref<string | null>(null)
  /** The plan for the radio on the cable now, or null before it has been read. */
  const plan = shallowRef<FleetPlan | null>(null)
  const currentUnitHash = ref<string | null>(null)
  /**
   * Whether any radio in this run has been read yet.
   *
   * Only used to decide whether to say the editor is holding a handset's
   * codeplug rather than the master, which is true from the first read and
   * false before it. Saying it at the top of a run was a small lie in the one
   * place the page is explaining where the user's document went.
   */
  const sawRead = ref(false)

  const running = computed(() => master.value !== null)
  const schema = computed(() => (radio.value ? SCHEMAS[radio.value] : null))

  const problems = computed(() => (schema.value ? validateFleetRoster(roster.value, schema.value) : []))
  const errors = computed(() => problems.value.filter((p) => p.severity === 'error'))
  const warnings = computed(() => problems.value.filter((p) => p.severity === 'warning'))

  const written = computed(() => roster.value.filter((u) => outcomes.value[u.id]?.state === 'written'))
  const skipped = computed(() => roster.value.filter((u) => outcomes.value[u.id]?.state === 'skipped'))

  /**
   * Rows still to do, in roster order.
   *
   * A failed row stays in here on purpose. The ordinary failure is a cable
   * pulled or a radio switched off, and the person is standing there holding
   * the radio - having to abandon the run to try it again would be absurd.
   */
  const pending = computed(() =>
    roster.value.filter((u) => {
      const state = outcomes.value[u.id]?.state
      return state !== 'written' && state !== 'skipped'
    }),
  )

  const current = computed(() => roster.value.find((u) => u.id === currentId.value) ?? null)

  /** The next id a hand-added row gets, so ids never collide with a re-import. */
  let minted = 0
  function mintId(): string {
    minted++
    return `row-${minted}-${roster.value.length + 1}`
  }

  /** Point the roster at a radio model. Ignored mid-run, which owns its own. */
  function setRadio(id: RadioId | null) {
    if (master.value === null) radio.value = id
  }

  function setRoster(units: readonly FleetUnit[]) {
    roster.value = units.map((u) => ({ ...u }))
    outcomes.value = {}
    currentId.value = null
    plan.value = null
  }

  function addRow() {
    roster.value = [...roster.value, { id: mintId(), label: '', dmrId: null, name: '' }]
  }

  function updateRow(id: string, patch: Partial<Omit<FleetUnit, 'id'>>) {
    roster.value = roster.value.map((u) => (u.id === id ? { ...u, ...patch } : u))
  }

  function removeRow(id: string) {
    roster.value = roster.value.filter((u) => u.id !== id)
    const { [id]: _gone, ...rest } = outcomes.value
    outcomes.value = rest
    if (currentId.value === id) clearCurrent()
  }

  /**
   * Take the codeplug out of the editor and begin.
   *
   * The roster is frozen from here: changing a DMR ID after five radios have
   * been done is how two of them end up sharing one, and the duplicate check
   * that would have caught it ran before the run started.
   */
  function startRun(doc: Codeplug, id: RadioId, facts: MasterFacts) {
    master.value = markRaw(structuredClone(toRaw(doc)))
    radio.value = id
    masterFacts.value = facts
    outcomes.value = {}
    currentId.value = null
    plan.value = null
    currentUnitHash.value = null
    sawRead.value = false
  }

  function endRun() {
    master.value = null
    masterFacts.value = null
    clearCurrent()
  }

  function beginUnit(id: string) {
    currentId.value = id
    plan.value = null
    currentUnitHash.value = null
  }

  function setPlan(next: FleetPlan, unitHash: string | null) {
    plan.value = markRaw(next)
    currentUnitHash.value = unitHash
    sawRead.value = true
  }

  function clearCurrent() {
    currentId.value = null
    plan.value = null
    currentUnitHash.value = null
  }

  function record(id: string, outcome: FleetOutcome) {
    outcomes.value = { ...outcomes.value, [id]: outcome }
  }

  /**
   * Put a written or skipped row back in the queue.
   *
   * Needed because a row can be right and its outcome wrong: a callsign typed
   * with a digit transposed, a radio that was written and then factory reset in
   * the same afternoon. The duplicate-unit check reads only written rows, so
   * reopening one is also how a handset that was done by mistake is released.
   */
  function reopen(id: string) {
    const { [id]: _gone, ...rest } = outcomes.value
    outcomes.value = rest
  }

  return {
    roster,
    radio,
    master,
    masterFacts,
    copyKeys,
    outcomes,
    currentId,
    current,
    plan,
    currentUnitHash,
    sawRead,
    running,
    schema,
    problems,
    errors,
    warnings,
    written,
    skipped,
    pending,
    setRadio,
    setRoster,
    addRow,
    updateRow,
    removeRow,
    startRun,
    endRun,
    beginUnit,
    setPlan,
    clearCurrent,
    record,
    reopen,
  }
})

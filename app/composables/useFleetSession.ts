// SPDX-License-Identifier: GPL-3.0-or-later
import { planFleetUnit, unitAlreadyProgrammed, type FleetUnit } from '#core/radio/fleet.js'
import { blocksToSend } from '#core/radio/diff.js'
import { encodeBwp } from '#core/io/bwp.js'
import type { MasterFacts } from '~/stores/fleet'

/**
 * The fleet loop: connect, back up, apply the roster, write - once per radio.
 *
 * Every one of those four steps is a step that already exists. This composable
 * sequences them and keeps the record; it opens no port, sends no byte and
 * calls no driver method that writes. `connectAndRead` and `writeToRadio` are
 * the same two functions the connect page and the write page use, unchanged,
 * and the second of them re-evaluates the write gate and hands `writeImage` the
 * backup regardless of anything decided here. A fleet write is twenty ordinary
 * writes, not a new kind of write.
 *
 * Two things about the sequence are load-bearing.
 *
 * The read and the write are separate connections, with a disconnect between
 * them, exactly as they are for one radio. It is tempting to hold the port open
 * across both - it would halve the chooser prompts over twenty handsets - but a
 * read followed by a write on one open port has never been exercised on a
 * DM-32UV, whose programming mode is stateful enough that a second handshake on
 * an already-handshaken port is answered with silence. Saving a click is not
 * worth being the first person to find out what that does.
 *
 * And the write is confirmed by the slide, once per radio, like every other
 * write in boofwang. That is about two seconds against the two or three
 * minutes a DM-32UV takes to read and write, so it is noise in the time it
 * costs and the single most important rule in the codebase in what it buys.
 * There is no fleet exception to "a write is never one click from idle"
 * because there is no version of this screen that is worth one.
 */
export function useFleetSession() {
  const fleet = useFleetStore()
  const codeplug = useCodeplugStore()
  const session = useRadioSession()
  const toast = useToast()

  /** What the roster editor says about the codeplug every radio is getting. */
  function facts(): MasterFacts {
    return {
      title: codeplug.doc?.meta.title || 'Untitled',
      variant: codeplug.image?.variant ?? null,
      channels: codeplug.channelCount,
      zones: codeplug.zones.length,
      talkGroups: codeplug.talkGroups.length,
      keys: codeplug.doc?.encryptionKeys.filter((k) => k.keyHex !== '').length ?? 0,
    }
  }

  /**
   * Take the open codeplug as the master and start the run.
   *
   * Refused without one. There is nothing to distribute and, more to the point,
   * no schema to check the roster against.
   */
  function startRun(): boolean {
    const doc = codeplug.doc
    const radio = doc?.radio
    if (!doc || !radio) {
      toast.add({
        title: 'There is no codeplug to send',
        description: 'Read a radio or open a codeplug file first. That one becomes the master for the run.',
        icon: 'i-lucide-circle-alert',
        color: 'error',
        duration: 0,
      })
      return false
    }
    // Unwritten edits are on no radio and in no backup, so once the first read
    // replaces the editor the run's copy is the only one, and ending the run
    // has to say so. The rendered image is what saving it would need.
    fleet.startRun(
      doc,
      radio,
      facts(),
      codeplug.dirty ? { image: codeplug.encoded, generation: codeplug.generation } : null,
    )
    // The editor still holds the master, unwritten edits and all, and the run
    // now has its own copy. The first read may replace it on that account.
    fleet.noteEditor(codeplug.revision)
    return true
  }

  /**
   * Whether ending the run would discard the only copy of the master.
   *
   * True once the master had unwritten edits and the editor has since been
   * given a different document. While the editor still holds it, edited
   * further or not, ending the run loses nothing of it.
   */
  function masterOnlyHere(): boolean {
    const edits = fleet.masterEdits
    return edits !== null && codeplug.generation !== edits.generation
  }

  /** Save the master as the run took it, as "Save a copy" would have then. */
  async function saveMaster() {
    const image = fleet.masterEdits?.image
    if (!image) {
      toast.add({
        title: 'The master cannot be saved as a codeplug file',
        description:
          'Its edits could not be rendered onto the image it was opened from, so there is no image to save.',
        icon: 'i-lucide-triangle-alert',
        color: 'error',
        duration: 0,
      })
      return
    }
    // A raw image carries no firmware name, and an empty one left the file
    // named "dm32uv--master".
    const variant = image.variant.replace(/[^\w.-]+/g, '_') || 'codeplug'
    const stamp = new Date().toISOString().slice(0, 19).replaceAll(':', '-')
    await saveFile(await encodeBwp(image), `${image.radioId}-${variant}-master-${stamp}.bwp`, 'application/octet-stream')
  }

  /**
   * Whether reading a radio now would lose work.
   *
   * Every read replaces the editor's document, which is safe while that is
   * the master the run took or a plan it made, and not once somebody has
   * edited it by hand. The run's master is the copy taken when it started, so
   * an edit made since is not in it, not on a radio and not in a backup. The
   * page asks before a read that would lose one, as the connect page does.
   */
  function canRead(): boolean {
    return codeplug.canReplace(fleet.editorRevision)
  }

  /**
   * Read the radio on the cable and work out what this row would do to it.
   *
   * The read is the backup. It is stored unprompted by `connectAndRead`, with
   * the fingerprint of the unit it came from, and it is the thing the driver
   * demands before it will write - so the loop's second step needs no code of
   * its own, which is the best reason to have arranged it this way.
   *
   * `consent` is the revision somebody agreed to discard when `canRead` said
   * no. Without it the run vouches for its own document and nothing else, so
   * `connectAndRead` still refuses to replace an edit nobody was asked about.
   */
  async function readUnit(unit: FleetUnit, consent: number | null = null): Promise<boolean> {
    const master = fleet.master
    const radio = fleet.radio
    if (!master || !radio) return false

    fleet.beginUnit(unit.id)

    // `connectAndRead` reports its own failures by toast and returns nothing, so
    // the one reliable signal that a radio was read is the image being
    // replaced. It calls `codeplug.load` on no other path.
    const before = codeplug.image
    await session.connectAndRead(radio, null, { discarding: consent ?? fleet.editorRevision })
    if (codeplug.image === before) {
      fleet.clearCurrent()
      return false
    }

    const driver = codeplug.driverRef
    const image = codeplug.image
    const doc = codeplug.doc
    const schema = codeplug.schema
    if (!driver || !image || !doc || !schema) {
      fleet.clearCurrent()
      return false
    }

    const unitHash = await driver.unitFingerprint(image)

    // The same radio presented twice. The rule is in `lib` so it can be
    // tested without a radio; see it for why this matters more than it looks.
    const took = unitAlreadyProgrammed(unitHash, unit.id, fleet.outcomes)
    if (took !== null) {
      const other = fleet.roster.find((u) => u.id === took)
      toast.add({
        title: 'This radio has already been programmed in this run',
        description:
          `This radio already took the row for ${JSON.stringify(other?.label ?? took)}. Writing ` +
          `${JSON.stringify(unit.label)} to it would overwrite that. Plug in a different radio, or move that ` +
          'row back to pending.',
        icon: 'i-lucide-shield-alert',
        color: 'error',
        duration: 0,
      })
      fleet.clearCurrent()
      return false
    }

    try {
      const plan = planFleetUnit({
        master,
        unit,
        recipient: doc,
        schema,
        now: new Date().toISOString(),
        copyEncryptionKeys: fleet.copyKeys,
      })
      // The same handover a one-radio clone makes: the merged document becomes
      // an unsaved edit, and the diff, the gate and the slide all happen
      // afterwards against it.
      codeplug.replaceDocument(plan.codeplug)
      fleet.setPlan(plan, unitHash)
      // Unwritten, and still the run's own: reading this radio again makes it
      // again, so the next read may replace it without asking.
      fleet.noteEditor(codeplug.revision)
      return true
    } catch (e) {
      toast.add({
        title: 'This codeplug cannot be put on this radio',
        description: e instanceof Error ? e.message : String(e),
        icon: 'i-lucide-triangle-alert',
        color: 'error',
        duration: 0,
      })
      fleet.clearCurrent()
      return false
    }
  }

  /** Blocks this write would send, counted the way the confirmation counts them. */
  function pendingBlocks(): number {
    return blocksToSend({
      diff: codeplug.pendingWrite,
      imageBytes: codeplug.image?.regions.reduce((n, r) => n + r.data.length, 0) ?? 0,
      blockBytes: codeplug.driverRef?.writeBlockBytes ?? 0,
      wholeImage: codeplug.schema?.capabilities.writesWholeImage === true,
    })
  }

  /**
   * Send the current row's plan to the radio it was planned against.
   *
   * `writeToRadio` does the whole of it: reconnect, re-evaluate the gate, find
   * the backup, and hand `writeImage` a reference to it. What is added here is
   * the record of what happened, which is the only thing a fleet run needs that
   * a single write does not.
   */
  async function writeCurrent(): Promise<boolean> {
    const unit = fleet.current
    if (!unit) return false

    const blocks = pendingBlocks()
    const unitHash = fleet.currentUnitHash
    const before = codeplug.image

    await session.writeToRadio()

    // Same signal as the write page uses: the baseline is replaced with what
    // was sent, and on no other path.
    const ok = codeplug.image !== before
    fleet.record(unit.id, {
      state: ok ? 'written' : 'failed',
      at: new Date().toISOString(),
      unitHash,
      blocks: ok ? blocks : 0,
      note: ok
        ? `${blocks} block${blocks === 1 ? '' : 's'} written`
        : 'Nothing was written. The reason is in the notification.',
    })
    if (ok) fleet.clearCurrent()
    return ok
  }

  /** Set this row aside without writing anything, with the reason on the record. */
  function skipCurrent(note: string) {
    const unit = fleet.current
    if (!unit) return
    fleet.record(unit.id, {
      state: 'skipped',
      at: new Date().toISOString(),
      unitHash: fleet.currentUnitHash,
      blocks: 0,
      note,
    })
    fleet.clearCurrent()
  }

  return { startRun, canRead, masterOnlyHere, saveMaster, readUnit, writeCurrent, skipCurrent, pendingBlocks }
}

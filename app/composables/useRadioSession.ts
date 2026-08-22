// SPDX-License-Identifier: GPL-3.0-or-later
import { SCHEMAS, createDriver, isImplemented } from '#core/radio/registry.js'
import { toStoredBackup } from '#core/storage/db.js'
import { encodeBwp, encodeRawBin } from '#core/io/bwp.js'
import { encodeChirpImg } from '#core/io/chirp-img.js'
import { exportChirpCsv, defaultHeader } from '#core/io/chirp-csv.js'
import { buildSummary, summaryHtml, summaryMarkdown } from '#core/io/summary.js'
import type { RadioId } from '#core/model/codeplug.js'
import type { RadioImage } from '#core/radio/image.js'
import { evaluateWriteGate } from '#core/radio/write-gate.js'
import type { PortChoice } from '~/composables/useWebSerial'
import type { TransportKind } from '#core/transport/transport.js'
import { forgetBluetoothGrant,
  reconnectBluetoothRadio, requestBluetoothRadio } from '~/composables/useWebBluetooth'

/**
 * What `device.connect` needs to label the connection.
 *
 * `exactOptionalPropertyTypes` is on, so an absent label has to be an absent
 * key rather than an explicit undefined.
 */
function connectInfo(choice: PortChoice) {
  return { ...choice.info, ...(choice.label === undefined ? {} : { label: choice.label }) }
}

/**
 * Get a port back, over the carrier this session last used.
 *
 * Writing and restoring both have to reconnect, because reading closes the
 * port when it finishes and editing takes as long as it takes. What they must
 * not do is decide *how* on the caller's behalf: `acquirePort` opens the
 * serial chooser, and asking someone holding a radio paired over Bluetooth to
 * pick a cable is not a prompt they can answer.
 *
 * The Bluetooth branch tries the granted device first, which needs no chooser
 * and no transient activation. Falling through to `requestBluetoothRadio` is
 * for the grant being gone or refused - and it has to stay the last thing
 * awaited on that path so the click's activation still covers it. (A reload
 * is not the case: `lastKind` is not persisted, so after one this function is
 * never asked for Bluetooth at all.)
 */
async function acquireLike(kind: TransportKind, radioId: RadioId | null): Promise<PortChoice | null> {
  /*
   * The carrier is chosen from the radio being written, not only from what
   * the last read happened to use. `lastKind` is session-wide: after a UV-5R
   * Mini has been read over Bluetooth, writing a DM-32UV .bwp opened here
   * would gatt.connect the Mini and run the DM-32UV's identify over it. A radio
   * whose schema does not list Bluetooth takes the cable regardless.
   *
   * The dev bridge wins over both. With `?bridge` and `pnpm bridge:ble` the
   * read goes through a BridgeSerialPort whose kind is 'bluetooth', so
   * `lastKind` says bluetooth while no device was ever granted - and the
   * Bluetooth branch would open the native chooser, or throw "this browser
   * does not support Web Bluetooth", never the bridge. That is the one harness
   * the README documents for exercising BLE on hardware, and a BLE write is
   * exactly what it would be used to verify.
   */
  const schema = radioId ? SCHEMAS[radioId] : null
  const radioHasBluetooth = schema?.capabilities.transports.includes('bluetooth') ?? false
  if (kind !== 'bluetooth' || !radioHasBluetooth || bridgeEnabled()) return await acquirePort()

  /*
   * A rejected reconnect is a missing grant, not a dead end. `??` only falls
   * through on null; a thrown DOMException from gatt.connect - radio switched
   * off, out of range, or a non-radio picked in the chooser - used to escape
   * here as "could not reach the radio over Bluetooth", with no way back to the
   * chooser and, after a refused write, no way to the cable either.
   */
  try {
    const again = await reconnectBluetoothRadio()
    if (again) return again
  } catch {
    forgetBluetoothGrant()
  }
  return await requestBluetoothRadio()
}

/** What went wrong opening a link, in the terms of the carrier it was over. */
function acquireFailure(kind: TransportKind) {
  return kind === 'bluetooth'
    ? { title: 'Could not reach the radio over Bluetooth', icon: 'i-lucide-signal' }
    : { title: 'Could not open a serial port', icon: 'i-lucide-cable' }
}

/**
 * The connect-read-save flow, in one place.
 *
 * The stores hold state; this holds the sequence, so a page can express "read
 * this radio" without knowing about transports, backups or file pickers.
 */
export function useRadioSession() {
  const device = useDeviceStore()
  const codeplug = useCodeplugStore()
  const transfer = useTransferStore()
  const db = useBoofwangDb()
  const toast = useToast()

  /**
   * The most recent backup matching the radio this codeplug came from.
   *
   * Matched on the connected radio when there is one, and otherwise on the
   * open codeplug's own variant - enough for the dialog to say whether a way
   * back exists. The binding check that matters happens in `writeImage`, which
   * compares the backup's fingerprint against the radio on the cable.
   */
  async function latestBackupForOpenCodeplug(): Promise<{
    identHash: string
    id: string
    unitHash?: string | null
    createdAt: string
  } | null> {
    const all = await db.listBackups()
    const hash = device.ident?.identHash
    const candidates = (hash ? all.filter((b) => b.identHash === hash) : all.filter((b) => b.radioId === codeplug.doc?.radio))
      .slice()
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
    const best = candidates[0]
    return best
      ? { identHash: best.identHash, id: best.id, unitHash: best.unitHash ?? null, createdAt: best.createdAt }
      : null
  }

  /**
   * Send the edited codeplug to the radio.
   *
   * A stored backup of this radio is required, and the driver refuses without
   * one regardless of what this function does. Two things it deliberately does
   * *not* claim: the backup is not re-taken here, and it is not necessarily
   * from this session. What is guaranteed is that one exists and that it came
   * from this physical unit - the driver compares its fingerprint against the
   * calibration on the cable before writing. The dialog shows the backup's age
   * so the person deciding can see how far back "back" is.
   *
   * Re-reading before every write would be the stronger guarantee, and is not
   * done yet because this radio's programming mode is stateful: a read
   * followed by a write on one open port has never been exercised on hardware,
   * and guessing at it would risk the path that is verified.
   */
  async function writeToRadio() {
    const image = codeplug.encoded
    const base = codeplug.image
    if (!image || !base || !codeplug.doc?.radio) return

    // Reading disconnects when it finishes, so by the time someone has edited a
    // channel there is usually no live port. Reconnecting here rather than
    // demanding it first keeps the button about intent: the click is itself the
    // transient activation a chooser needs, so this works on real Web Serial
    // and Web Bluetooth and not only through the dev bridge.
    if (!device.connected) {
      const kind = device.lastKind
      let choice: PortChoice | null
      try {
        choice = await acquireLike(kind, codeplug.doc?.radio ?? null)
      } catch (e) {
        toast.add({
          ...acquireFailure(kind),
          description: e instanceof Error ? e.message : String(e),
          color: 'error',
          duration: 0,
        })
        return
      }
      if (!choice) return
      try {
        await device.connect(choice.port, codeplug.doc.radio, connectInfo(choice))
      } catch (e) {
        toast.add({
          title: 'Could not connect to the radio',
          description: e instanceof Error ? e.message : String(e),
          icon: 'i-lucide-triangle-alert',
          color: 'error',
          duration: 0,
        })
        return
      }
    }

    const ident = device.ident
    if (!ident) return

    const backup = await latestBackupForOpenCodeplug()
    if (!backup) {
      toast.add({
        title: 'No backup of this radio',
        description: 'Read the radio before writing to it, so there is a way back.',
        icon: 'i-lucide-shield-alert',
        color: 'error',
        duration: 0,
      })
      return
    }

    // Evaluate the gate here, not only in the component that drew the button.
    //
    // The UI uses this to decide whether the button is enabled; that is a
    // convenience, not a control. Anything that reaches this function - a
    // keyboard shortcut, a component that forgot to check, a future caller -
    // has to pass the same test, and the reasons are the ones the user was
    // already shown.
    const gate = evaluateWriteGate({
      schema: codeplug.schema!,
      ident,
      imageVariant: image.variant,
      imageRadioId: image.radioId,
      backup,
      diagnostics: codeplug.diagnostics,
      encodeError: codeplug.encodeError,
      changedBytes: codeplug.pendingWrite?.changedBytes ?? 0,
      unownedRanges: codeplug.pendingWrite?.unowned ?? [],
      documentDirty: codeplug.dirty,
      transport: device.lastKind,
    })
    if (!gate.allowed) {
      toast.add({
        title: 'This write is blocked',
        description: gate.blockers.map((b) => [b.message, b.remedy].filter(Boolean).join(' ')).join(' '),
        icon: 'i-lucide-shield-alert',
        color: 'error',
        duration: 0,
      })
      return
    }

    const signal = transfer.begin('Writing to the radio')
    try {
      const report = await device.currentDriver().writeImage(device.currentTransport(), image, {
        signal,
        ident,
        backup: {
          id: backup.id,
          identHash: backup.identHash,
          unitHash: backup.unitHash ?? null,
          createdAt: backup.createdAt,
        },
        baseImage: base,
        adapter: device.portLabel,
        progress: (p) => transfer.report(p),
      })

      // The radio now holds what we sent, so that becomes the new baseline.
      codeplug.load({ ...image, sha256: base.sha256 }, device.currentDriver())

      toast.add({
        title: 'Written and verified',
        description: `${report.blocksWritten} block(s), ${report.bytesWritten} bytes. Every block was read back and matched.`,
        icon: 'i-lucide-circle-check',
        color: 'success',
        duration: 10_000,
      })
    } catch (e) {
      device.captureFailure(e)
      toast.add({
        title: 'Write failed',
        description: e instanceof Error ? e.message : String(e),
        icon: 'i-lucide-triangle-alert',
        color: 'error',
        duration: 0,
      })
    } finally {
      transfer.end()
      await device.disconnect()
    }
  }

  /**
   * Put a stored image back on the radio.
   *
   * Distinct from `writeToRadio`, and the difference is the whole point:
   * `writeImage` normally refuses when the radio disagrees with the image the
   * edit was based on, because that divergence is unintended and writing over
   * it would silently mix two codeplugs. A restore is the opposite - the radio
   * is *expected* to differ, and making it match again is the entire request.
   * So no base image is supplied, and the driver writes whichever blocks differ from
   * what it reads off the radio.
   */
  async function restoreToRadio(image: RadioImage) {
    if (!device.connected) {
      const kind = device.lastKind
      let choice: PortChoice | null
      try {
        choice = await acquireLike(kind, codeplug.doc?.radio ?? null)
      } catch (e) {
        toast.add({
          ...acquireFailure(kind),
          description: e instanceof Error ? e.message : String(e),
          color: 'error',
          duration: 0,
        })
        return
      }
      if (!choice) return
      try {
        await device.connect(choice.port, image.radioId, connectInfo(choice))
      } catch (e) {
        toast.add({
          title: 'Could not connect to the radio',
          description: e instanceof Error ? e.message : String(e),
          icon: 'i-lucide-triangle-alert',
          color: 'error',
          duration: 0,
        })
        return
      }
    }

    const ident = device.ident
    if (!ident) return

    const signal = transfer.begin('Restoring the radio')
    try {
      const report = await device.currentDriver().writeImage(device.currentTransport(), image, {
        signal,
        ident,
        // The image being restored *is* the way back, so it is its own backup
        // reference - but the fingerprint still has to be the image's own, not
        // one asserted on its behalf. Handing the driver a fabricated match
        // would defeat the per-unit check on the one path where restoring the
        // wrong radio's codeplug does the most damage.
        backup: {
          id: 'restore',
          identHash: ident.identHash,
          unitHash: await device.currentDriver().unitFingerprint(image),
          createdAt: image.createdAt,
        },
        adapter: device.portLabel,
        progress: (p) => transfer.report(p),
      })
      codeplug.load(image, device.currentDriver())

      // Say what was actually restored, not what was asked for. Some drivers
      // write only part of an image on purpose - the DM-32UV cannot write
      // roaming zone membership or the twenty-odd blocks nothing has decoded -
      // and calling that a full restore would leave someone believing their
      // whole radio had been rolled back.
      const total = image.regions.length
      const scope = device.currentDriver().schema.capabilities.writeScope
      const partial = report.blocksWritten > 0 && report.blocksWritten < total
      toast.add({
        title:
          report.blocksWritten === 0
            ? scope
              ? 'Nothing to restore in the part this radio can write'
              : 'The radio already matched this backup'
            : partial
              ? 'Partly restored'
              : 'Restored and verified',
        description:
          report.blocksWritten === 0
            ? scope
              ? `The ${scope} already match this backup. The rest of the radio cannot be written by ` +
                'boofwang and was not compared.'
              : 'Nothing needed to be written.'
            : partial
              ? `${report.blocksWritten} of ${total} block(s) were restored and verified. This radio only ` +
                `supports writing ${scope ?? 'part of its memory'}, so the rest is unchanged.`
              : `${report.blocksWritten} block(s) restored. Every one was read back and matched.`,
        icon: partial || (report.blocksWritten === 0 && scope) ? 'i-lucide-info' : 'i-lucide-circle-check',
        color: partial || (report.blocksWritten === 0 && scope) ? 'warning' : 'success',
        duration: 12_000,
      })
    } catch (e) {
      device.captureFailure(e)
      toast.add({
        title: 'Restore failed',
        description: e instanceof Error ? e.message : String(e),
        icon: 'i-lucide-triangle-alert',
        color: 'error',
        duration: 0,
      })
    } finally {
      transfer.end()
      await device.disconnect()
    }
  }

  /**
   * Read a radio, over whatever it is connected by.
   *
   * `acquired` exists for Bluetooth. `requestDevice` needs transient user
   * activation just as `requestPort` does, and the chooser it opens is a second
   * dialogue the user has to answer - so the page has to raise it inside its own
   * click handler and hand the result here, rather than this function deciding
   * after the fact which chooser to open. When it is absent the serial path is
   * unchanged.
   */
  async function connectAndRead(id: RadioId, acquired?: PortChoice | null) {
    if (!isImplemented(id)) {
      toast.add({ title: 'Not implemented yet', description: `There is no driver for this radio yet.`, color: 'neutral' })
      return
    }

    // requestPort needs transient user activation, so it has to be the first
    // thing that happens after the click. `acquirePort` is the same call unless
    // the dev bridge is enabled (see useWebSerial), in which case the port
    // comes from a localhost socket instead of the native chooser.
    //
    // Wrapped, because this can fail for perfectly ordinary reasons - the cable
    // is not plugged in, the browser has no Web Serial - and an unhandled
    // rejection here means the user clicks the button and nothing at all
    // happens.
    let choice: Awaited<ReturnType<typeof acquirePort>>
    try {
      choice = acquired ?? (await acquirePort())
    } catch (e) {
      toast.add({
        title: 'Could not open a serial port',
        description: e instanceof Error ? e.message : String(e),
        icon: 'i-lucide-cable',
        color: 'error',
        duration: 0,
      })
      return
    }
    if (!choice) return

    try {
      const ident = await device.connect(choice.port, id, connectInfo(choice))

      if (!ident.caps.write && ident.caps.reason) {
        toast.add({
          title: 'Read-only firmware',
          description: ident.caps.reason,
          icon: 'i-lucide-info',
          color: 'warning',
          duration: 12_000,
        })
      }

      const signal = transfer.begin(`Reading ${createDriver(id).schema.model}`)
      try {
        const image = await device.currentDriver().readImage(device.currentTransport(), ident, {
          signal,
          progress: (p) => transfer.report(p),
        })
        // Persisted immediately and unprompted, and *before* the document is
        // loaded: the moment a codeplug is worth editing is the moment it is
        // worth being able to get back.
        //
        // The order is not cosmetic. Opening the codeplug is what tells the
        // rest of the app a radio has been read, and the status bar answers
        // "is there a way back" the instant it hears that. Loading first meant
        // it always looked before the backup landed, so every read ended with
        // a toast saying a backup had been saved next to a status bar saying
        // to read the radio to get one.
        await db.putBackup(
          toStoredBackup(image, {
            id: crypto.randomUUID(),
            origin: 'download',
            identHash: ident.identHash,
            unitHash: await device.currentDriver().unitFingerprint(image),
            label: `${image.variant} · read ${new Date().toLocaleString()}`,
          }),
        )

        codeplug.load(image, device.currentDriver())

        toast.add({
          title: 'Codeplug read',
          description: `${codeplug.channelCount} channel(s). A backup was saved in this browser.`,
          icon: 'i-lucide-circle-check',
          color: 'success',
        })
      } finally {
        transfer.end()
      }
    } catch (e) {
      device.captureFailure(e)
      const message = e instanceof Error ? e.message : String(e)
      toast.add({
        title: 'Could not read the radio',
        description: message,
        icon: 'i-lucide-triangle-alert',
        color: 'error',
        duration: 0,
        actions: device.traceJson()
          ? [
              {
                label: 'Save the protocol log',
                icon: 'i-lucide-file-down',
                color: 'neutral' as const,
                variant: 'subtle' as const,
                onClick: () => void downloadTrace(),
              },
            ]
          : undefined,
      })
    } finally {
      await device.disconnect()
    }
  }

  function baseName() {
    const v = codeplug.image?.variant?.replace(/[^\w.-]+/g, '_') ?? 'codeplug'
    const stamp = new Date().toISOString().slice(0, 19).replaceAll(':', '-')
    return `${codeplug.doc?.radio ?? 'radio'}-${v}-${stamp}`
  }

  /**
   * The image to save: what the user is looking at, not what was read.
   *
   * Both file exports used `codeplug.image`, which is the image as it came off
   * the radio. Editing a channel and saving the codeplug therefore wrote the
   * pre-edit bytes and said nothing, so the file quietly disagreed with the CSV
   * export beside it - which has always used the edited document - and reopening
   * it lost the work.
   *
   * When the edits cannot be encoded at all there is no honest image to write,
   * so the save is refused with the reason rather than silently falling back to
   * the stale one.
   */
  function imageToSave(): RadioImage | null {
    if (!codeplug.image) return null
    if (codeplug.encoded) return codeplug.encoded
    if (codeplug.dirty) {
      toast.add({
        title: 'These edits cannot be saved as a codeplug image',
        description:
          `${codeplug.encodeError ?? 'The codeplug could not be encoded.'} ` +
          'Export a CHIRP CSV instead, which keeps the edits.',
        icon: 'i-lucide-triangle-alert',
        color: 'error',
        duration: 0,
      })
      return null
    }
    return codeplug.image
  }

  async function downloadBwp() {
    const image = imageToSave()
    if (!image) return
    await saveFile(await encodeBwp(image), `${baseName()}.bwp`, 'application/octet-stream')
  }

  async function downloadRawBin() {
    const image = imageToSave()
    if (!image) return
    await saveFile(encodeRawBin(image), `${baseName()}.bin`, 'application/octet-stream')
  }

  /**
   * A CHIRP-compatible `.img`.
   *
   * The point of the format is that CHIRP can open it, so this refuses radios
   * CHIRP has no driver for rather than writing a file that looks importable
   * and is not.
   */
  async function downloadChirpImg() {
    const image = imageToSave()
    if (!image) return
    try {
      await saveFile(await encodeChirpImg(image), `${baseName()}.img`, 'application/octet-stream')
    } catch (e) {
      toast.add({
        title: 'Cannot save a CHIRP image for this radio',
        description: e instanceof Error ? e.message : String(e),
        icon: 'i-lucide-circle-alert',
        color: 'error',
        duration: 0,
      })
    }
  }

  async function downloadCsv() {
    if (!codeplug.doc) return
    const text = exportChirpCsv(codeplug.doc, { header: defaultHeader(codeplug.doc) })
    await saveFile(text, `${baseName()}.csv`, 'text/csv')
  }

  /**
   * The channel plan in a form that can be sent to a person.
   *
   * Built from the edited document rather than the image, like the CSV beside
   * it, because what someone is asked to check is the plan as it stands. The
   * radio's name comes from the schema so the file says "Baofeng DM-32UV"
   * rather than `dm32uv`, and the firmware from the image so a reader can tell
   * whether their radio is the one this was written against.
   *
   * `buildSummary` never reads the codeplug's keys - see the note in
   * `lib/io/summary.ts` - so there is nothing to redact here.
   */
  function currentSummary() {
    const doc = codeplug.doc
    if (!doc) return null
    const schema = codeplug.schema
    const firmware = codeplug.image?.variant
    return buildSummary(doc, {
      ...(schema === null ? {} : { radio: `${schema.vendor} ${schema.model}` }),
      ...(firmware === undefined ? {} : { firmware }),
    })
  }

  async function downloadSummaryHtml() {
    const summary = currentSummary()
    if (!summary) return
    await saveFile(summaryHtml(summary), `${baseName()}-summary.html`, 'text/html')
  }

  async function downloadSummaryMarkdown() {
    const summary = currentSummary()
    if (!summary) return
    await saveFile(summaryMarkdown(summary), `${baseName()}-summary.md`, 'text/markdown')
  }

  async function downloadTrace() {
    const json = device.traceJson()
    if (!json) return
    const stamp = new Date().toISOString().slice(0, 19).replaceAll(':', '-')
    await saveFile(json, `boofwang-trace-${stamp}.json`, 'application/json')
  }

  return {
    connectAndRead,
    writeToRadio,
    restoreToRadio,
    latestBackupForOpenCodeplug,
    downloadBwp,
    downloadRawBin,
    downloadChirpImg,
    downloadCsv,
    downloadSummaryHtml,
    downloadSummaryMarkdown,
    downloadTrace,
  }
}

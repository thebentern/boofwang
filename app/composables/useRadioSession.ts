// SPDX-License-Identifier: GPL-3.0-or-later
import { createDriver, isImplemented } from '#core/radio/registry.js'
import { toStoredBackup } from '#core/storage/db.js'
import { encodeBwp, encodeRawBin } from '#core/io/bwp.js'
import { exportChirpCsv, defaultHeader } from '#core/io/chirp-csv.js'
import type { RadioId } from '#core/model/codeplug.js'
import type { RadioImage } from '#core/radio/image.js'
import { evaluateWriteGate } from '#core/radio/write-gate.js'

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
    // user gesture `requestPort` needs, so this works on real Web Serial and not
    // only through the dev bridge.
    if (!device.connected) {
      let choice: Awaited<ReturnType<typeof acquirePort>>
      try {
        choice = await acquirePort()
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
        await device.connect(choice.port, codeplug.doc.radio, choice.info)
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
      let choice: Awaited<ReturnType<typeof acquirePort>>
      try {
        choice = await acquirePort()
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
        await device.connect(choice.port, image.radioId, choice.info)
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
      // write only part of an image on purpose - the DM-32UV writes just the
      // encryption key slots - and calling that a full restore would leave
      // someone believing their channels had been rolled back when they had
      // not.
      const total = image.regions.length
      const partial = report.blocksWritten > 0 && report.blocksWritten < total
      toast.add({
        title:
          report.blocksWritten === 0
            ? 'The radio already matched this backup'
            : partial
              ? 'Partly restored'
              : 'Restored and verified',
        description:
          report.blocksWritten === 0
            ? 'Nothing needed to be written.'
            : partial
              ? `${report.blocksWritten} of ${total} block(s) were restored and verified. This radio only ` +
                'supports writing part of its memory, so the rest is unchanged.'
              : `${report.blocksWritten} block(s) restored. Every one was read back and matched.`,
        icon: partial ? 'i-lucide-info' : 'i-lucide-circle-check',
        color: partial ? 'warning' : 'success',
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

  async function connectAndRead(id: RadioId) {
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
      choice = await acquirePort()
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
      const ident = await device.connect(choice.port, id, choice.info)

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
        codeplug.load(image, device.currentDriver())

        // Persisted immediately and unprompted: the moment a codeplug is worth
        // editing is the moment it is worth being able to get back.
        await db.putBackup(
          toStoredBackup(image, {
            id: crypto.randomUUID(),
            origin: 'download',
            identHash: ident.identHash,
            unitHash: await device.currentDriver().unitFingerprint(image),
            label: `${image.variant} · read ${new Date().toLocaleString()}`,
          }),
        )

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

  async function downloadBwp() {
    if (!codeplug.image) return
    await saveFile(await encodeBwp(codeplug.image), `${baseName()}.bwp`, 'application/octet-stream')
  }

  async function downloadRawBin() {
    if (!codeplug.image) return
    await saveFile(encodeRawBin(codeplug.image), `${baseName()}.bin`, 'application/octet-stream')
  }

  async function downloadCsv() {
    if (!codeplug.doc) return
    const text = exportChirpCsv(codeplug.doc, { header: defaultHeader(codeplug.doc) })
    await saveFile(text, `${baseName()}.csv`, 'text/csv')
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
    downloadCsv,
    downloadTrace,
  }
}

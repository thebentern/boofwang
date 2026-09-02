// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Hand the user a file.
 *
 * The one place in `app/` that turns bytes into something a person can keep.
 * Three routes, chosen by capability rather than by host:
 *
 * - A shell that supplies `saveFile` (the mobile bridge) gets the bytes and
 *   decides where they go: on a phone that is the Documents folder and a
 *   share sheet, because a blob URL on an anchor does nothing useful in a
 *   WebView.
 * - `showSaveFilePicker` is Chromium-only, and Firefox 151 can drive a radio
 *   but cannot use it - so the download fallback is the normal path for a
 *   real share of users, not an edge case.
 * - The anchor download, for everyone else.
 *
 * This used to live in `useWebSerial.ts`, with a second copy inlined in the
 * startup-image page. A third route was the point at which two copies
 * stopped being harmless.
 */
export async function saveFile(data: Uint8Array | string, filename: string, mime: string): Promise<boolean> {
  const { bridge } = useShell()
  if (bridge?.saveFile) return bridge.saveFile(data, filename, mime)

  const blob = new Blob([data as BlobPart], { type: mime })

  const picker = (window as unknown as { showSaveFilePicker?: unknown }).showSaveFilePicker
  if (typeof picker === 'function') {
    try {
      const handle = await (picker as (o: unknown) => Promise<FileSystemFileHandle>)({
        suggestedName: filename,
        types: [{ description: 'boofwang codeplug', accept: { [mime]: [`.${filename.split('.').pop()}`] } }],
      })
      const writable = await handle.createWritable()
      await writable.write(blob)
      await writable.close()
      return true
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') return false
      // Anything else: fall through to the download below rather than failing.
    }
  }

  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
  return true
}

// SPDX-License-Identifier: GPL-3.0-or-later
import { setSleepImplementation } from '#core/transport/transport.js'

/**
 * Give the transport a timer the browser will not throttle.
 *
 * Chrome clamps `setTimeout` to about 1 Hz in a hidden tab. Measured on this
 * app while backgrounded: `setTimeout(10)` returned after 999 ms. Every delay
 * in a radio protocol then stretches to a second, which is merely slow for most
 * steps and fatal for the DM-32UV's programming-mode entry, whose three steps
 * are specified 10 ms apart - the radio closes the window long before the third
 * arrives. It also widens every read enough for that radio's idle heartbeat to
 * land inside one.
 *
 * A dedicated worker's timers are not clamped the same way: the same
 * measurement gives 12 ms and 154 ms. So the sleep goes through one.
 *
 * This matters for real use, not only for automated sessions - a user who
 * switches tabs part-way through writing a codeplug is in exactly this state.
 */
export default defineNuxtPlugin(() => {
  if (typeof Worker === 'undefined') return

  const source = `
    onmessage = (e) => {
      const [id, ms] = e.data
      setTimeout(() => postMessage(id), ms)
    }
  `
  let worker: Worker
  try {
    worker = new Worker(URL.createObjectURL(new Blob([source], { type: 'text/javascript' })))
  } catch {
    // No worker available: the plain timer still works, just slowly when hidden.
    return
  }

  let nextId = 0
  const pending = new Map<number, () => void>()
  worker.addEventListener('message', (e: MessageEvent<number>) => {
    const resolve = pending.get(e.data)
    if (resolve) {
      pending.delete(e.data)
      resolve()
    }
  })

  setSleepImplementation(
    (ms) =>
      new Promise<void>((resolve) => {
        const id = nextId++
        pending.set(id, resolve)
        worker.postMessage([id, ms])
      }),
  )
})

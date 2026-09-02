// SPDX-License-Identifier: GPL-3.0-or-later
import { defineStore } from 'pinia'
import type { Progress } from '#core/radio/driver.js'

/**
 * Progress and cancellation for a running read or write.
 *
 * Progress is throttled before it reaches reactivity: a UV-K5 read reports 64
 * times and a DM-32UV read will report hundreds, and re-rendering on every one
 * competes with the transfer itself for the main thread.
 */
export const useTransferStore = defineStore('transfer', () => {
  const active = ref(false)
  const phase = ref<Progress['phase'] | null>(null)
  const done = ref(0)
  const total = ref(0)
  const label = ref('')
  const log = ref<string[]>([])
  /**
   * Whether the host took the app away from the transfer while it ran.
   *
   * Set by the mobile shell when the app goes to the background, and by
   * nothing else. A read that fails after this is blamed on the interruption
   * rather than on the radio, which is the difference between "try again with
   * the screen on" and a bug report about a radio that was never at fault.
   */
  const interrupted = ref(false)

  let controller: AbortController | null = null
  let lastEmit = 0

  const percent = computed(() => (total.value > 0 ? Math.min(100, (done.value / total.value) * 100) : 0))
  const canCancel = computed(() => active.value && controller !== null)

  function begin(what: string) {
    active.value = true
    phase.value = null
    done.value = 0
    total.value = 0
    label.value = what
    log.value = [what]
    interrupted.value = false
    lastEmit = 0
    controller = new AbortController()
    return controller.signal
  }

  function report(p: Progress) {
    // ~10 Hz, but always let the final tick through so the bar reaches 100%.
    const now = Date.now()
    const finished = p.done >= p.total
    if (!finished && now - lastEmit < 100) return
    lastEmit = now
    phase.value = p.phase
    done.value = p.done
    total.value = p.total
    if (p.label) label.value = p.label
  }

  function note(line: string) {
    log.value = [...log.value.slice(-200), line]
  }

  function cancel() {
    controller?.abort()
  }

  function markInterrupted() {
    if (interrupted.value) return
    interrupted.value = true
    note(`boofwang went to the background at ${Math.round(percent.value)}%`)
  }

  function end() {
    active.value = false
    controller = null
  }

  return {
    active,
    phase,
    done,
    total,
    label,
    log,
    interrupted,
    percent,
    canCancel,
    begin,
    report,
    note,
    markInterrupted,
    cancel,
    end,
  }
})

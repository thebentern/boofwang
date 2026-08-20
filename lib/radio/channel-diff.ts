// SPDX-License-Identifier: GPL-3.0-or-later
import type { Channel, Codeplug } from '../model/index.js'
import { txFrequency } from '../model/channel.js'

/**
 * What a write will change, in the user's terms.
 *
 * `diffImages` answers "which bytes move", which is what the write gate needs
 * and what proves the encoder is behaving. It is not what a person can consent
 * to. Nobody can look at "1,792 bytes across 14 blocks" and know whether a
 * weather channel just became transmit-capable.
 *
 * This produces one row per channel with a verb, and singles out the two
 * changes that carry consequence beyond their size: a channel gaining transmit,
 * and a channel being erased.
 */

export type ChangeKind = 'edit' | 'add' | 'gain' | 'erase'

export interface ChannelChange {
  readonly slot: number
  readonly kind: ChangeKind
  /** How the channel read before, empty string when it did not exist. */
  readonly before: string
  /** How it will read after, empty string when it is being erased. */
  readonly after: string
  /**
   * The consequence worth naming, when there is one.
   *
   * `gains-transmit` is the reason this module exists. A receive-only channel
   * quietly becoming transmit-capable is the failure that puts a public-safety
   * or weather frequency into a radio someone can key up, and it is invisible
   * in a byte count.
   */
  readonly note?: 'gains-transmit' | 'loses-transmit' | 'slot-cleared' | 'error-cleared' | 'from-preset'
}

export interface ChannelDiff {
  readonly changes: readonly ChannelChange[]
  readonly changed: number
  readonly gainsTransmit: number
  readonly erased: number
  /** Channels that were receive-only before and are not in the result. */
  readonly receiveOnlyLost: number
}

/** How a channel reads in one line, for the before/after columns. */
export function describeChannel(c: Channel): string {
  const mhz = (hz: number) => (hz / 1e6).toFixed(5)
  const tx = txFrequency(c)
  const name = c.name.trim()
  const head = name ? `${name} · ${mhz(c.rxFreq)}` : mhz(c.rxFreq)
  if (!c.txAllowed) return `${head} · RX only`
  if (tx !== null && tx !== c.rxFreq) return `${head} → ${mhz(tx)}`
  return head
}

function sameChannel(a: Channel, b: Channel): boolean {
  return (
    a.name === b.name &&
    a.rxFreq === b.rxFreq &&
    a.txAllowed === b.txAllowed &&
    txFrequency(a) === txFrequency(b) &&
    a.modulation === b.modulation &&
    a.bandwidthHz === b.bandwidthHz &&
    a.power.mW === b.power.mW &&
    a.skip === b.skip &&
    JSON.stringify(a.tone) === JSON.stringify(b.tone)
  )
}

/**
 * Compare the codeplug as read against the codeplug as edited.
 *
 * Both are documents rather than images, so this says nothing about whether a
 * given change is writable on this radio - the gate and the driver decide that.
 * It describes intent, which is what a person is being asked to approve.
 */
export function diffChannels(before: Codeplug, after: Codeplug): ChannelDiff {
  const changes: ChannelChange[] = []
  const slots = new Set<number>([...before.channels.keys(), ...after.channels.keys()])

  let gainsTransmit = 0
  let erased = 0
  let receiveOnlyLost = 0

  for (const slot of [...slots].sort((a, b) => a - b)) {
    const was = before.channels.get(slot)
    const now = after.channels.get(slot)

    if (!was && !now) continue

    if (was && !now) {
      erased++
      if (!was.txAllowed) receiveOnlyLost++
      changes.push({ slot, kind: 'erase', before: describeChannel(was), after: '', note: 'slot-cleared' })
      continue
    }

    if (!was && now) {
      changes.push({ slot, kind: 'add', before: '', after: describeChannel(now) })
      continue
    }

    if (was && now) {
      if (sameChannel(was, now)) continue

      // A channel that could not transmit and now can is its own kind, not an
      // edit that happens to include a flag.
      const gained = !was.txAllowed && now.txAllowed
      const lost = was.txAllowed && !now.txAllowed
      if (gained) gainsTransmit++
      if (lost) receiveOnlyLost += 0

      changes.push({
        slot,
        kind: gained ? 'gain' : 'edit',
        before: describeChannel(was),
        after: describeChannel(now),
        ...(gained ? { note: 'gains-transmit' as const } : lost ? { note: 'loses-transmit' as const } : {}),
      })
    }
  }

  return { changes, changed: changes.length, gainsTransmit, erased, receiveOnlyLost }
}

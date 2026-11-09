// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Ascending numbers as a person would write them: a run of three or more as
 * "28 to 41", anything shorter one by one, so "12, 15, and 20 to 22".
 *
 * Written for the monitor export, whose notices once listed fourteen channels
 * one sentence each, and shared because the keys page lists slots the same
 * way: a DM-32UV whose CPS encrypted TAC 1-14 uses fourteen of them, and
 * "slots 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, and 14" is a sentence
 * nobody reads to the end. Expects them sorted and without repeats, which is
 * how every caller already holds them.
 */
export function ranges(numbers: readonly number[]): string {
  const parts: string[] = []
  for (let i = 0; i < numbers.length; ) {
    let j = i
    while (j + 1 < numbers.length && numbers[j + 1] === numbers[j]! + 1) j++
    if (j - i >= 2) parts.push(`${numbers[i]} to ${numbers[j]}`)
    else for (let k = i; k <= j; k++) parts.push(String(numbers[k]))
    i = j + 1
  }
  return new Intl.ListFormat('en', { type: 'conjunction' }).format(parts)
}

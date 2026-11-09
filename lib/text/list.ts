// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * "a, b, and c", for a sentence built from parts the code holds.
 *
 * The formatter `ranges` ends with, given a name so that the next sentence
 * that needs one does not grow a hand-rolled join with its own idea of where
 * the "and" goes.
 */
export function andList(parts: readonly string[]): string {
  return new Intl.ListFormat('en', { type: 'conjunction' }).format(parts)
}

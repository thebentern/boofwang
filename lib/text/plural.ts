// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The word that goes with a count: `plural(3, 'channel')` is "channels" and
 * `plural(1, 'It', 'They')` is "It".
 *
 * The number is not folded in, because the sentence does not always show it
 * ("They will be dropped") and because a message that reads "1 channel(s)" is
 * the thing this replaces.
 */
export function plural(n: number, singular: string, pluralForm = `${singular}s`): string {
  return n === 1 ? singular : pluralForm
}

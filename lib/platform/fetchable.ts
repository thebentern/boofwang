// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Check a URL is one a shell is willing to fetch on the page's behalf.
 *
 * https only, and nothing else is negotiable: a shell's fetch runs outside the
 * renderer where the same-origin policy does not apply, so this is the one
 * place in boofwang where a URL from the page reaches the network unfiltered.
 * Returns the parsed URL or throws with the reason.
 *
 * This is a second copy of the function in `electron/site.mjs`, deliberately.
 * The Electron files are plain `.mjs` run by Node with no TypeScript loader,
 * so `electron/site.mjs` cannot import this file at runtime, and the app
 * bundle should not reach into `electron/` for a rule it needs in a WebView.
 * Two copies that can drift are worse than one, so
 * `test/lib/platform/fetchable.spec.ts` runs both over the same list of URLs
 * and fails the moment they disagree.
 */
export function assertFetchable(url: string): URL {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new Error(`${JSON.stringify(String(url))} is not a URL`)
  }
  if (parsed.protocol !== 'https:') {
    throw new Error(`boofwang fetches over https only, not ${parsed.protocol}`)
  }
  return parsed
}

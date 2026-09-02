// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest'
import { DATA_SOURCES, availableSources, sourceById, unreachableSources } from '#core/data/registry.js'
import { capabilitiesFor, detectHost, hostSupports } from '#core/platform/host.js'

describe('the registry keeps its promises about attribution', () => {
  it('gives every source a non-empty attribution', () => {
    // Credit is the consideration boofwang offers for data it has no licence
    // for. A source that ships without it is a source being used for nothing in
    // return.
    for (const s of DATA_SOURCES) {
      expect(s.attribution.trim(), s.id).not.toBe('')
    }
  })

  it('gives every source a licence line and a homepage', () => {
    for (const s of DATA_SOURCES) {
      expect(s.licence.trim(), s.id).not.toBe('')
      expect(s.homepage, s.id).toMatch(/^https:\/\//)
    }
  })

  it('has no duplicate ids', () => {
    expect(new Set(DATA_SOURCES.map((s) => s.id)).size).toBe(DATA_SOURCES.length)
  })

  it('writes interface copy in the house style', () => {
    // These strings render in the product, so they follow the product's rules:
    // no em-dashes, and boofwang stays lowercase.
    for (const s of DATA_SOURCES) {
      expect(s.licence, s.id).not.toMatch(/—/)
      expect(s.licence, s.id).not.toMatch(/\bBoofwang\b/)
    }
  })
})

describe('capability gating', () => {
  it('keeps a source needing cross-origin fetch out of the browser build', () => {
    const web = availableSources('browser').map((s) => s.id)
    expect(web).toContain('brandmeister')
    expect(web).not.toContain('hearham')
    expect(web).not.toContain('radioid')
  })

  it('offers everything on the desktop build', () => {
    const desktop = availableSources('desktop').map((s) => s.id)
    for (const s of DATA_SOURCES) expect(desktop, s.id).toContain(s.id)
  })

  it('offers everything on both mobile builds', () => {
    for (const host of ['android', 'ios'] as const) {
      const ids = availableSources(host).map((s) => s.id)
      for (const s of DATA_SOURCES) expect(ids, `${host} ${s.id}`).toContain(s.id)
    }
  })

  it('does not gate the source that needs nothing', () => {
    // BrandMeister reflects the requesting origin, so the DM-32UV talk group
    // and contact import works on the web. If this ever starts being gated,
    // the web build has been hollowed out for no reason.
    const bm = sourceById('brandmeister')!
    expect(bm.needs).toEqual([])
    expect(hostSupports('browser', bm.needs)).toBe(true)
  })

  it('splits sources into reachable and unreachable with nothing lost', () => {
    for (const host of ['browser', 'desktop', 'android', 'ios'] as const) {
      const seen = [...availableSources(host), ...unreachableSources(host)].map((s) => s.id)
      const enabled = DATA_SOURCES.filter((s) => s.enabled).map((s) => s.id)
      expect([...seen].sort(), host).toEqual([...enabled].sort())
    }
  })

  it('hides a withdrawn source from both lists', () => {
    // `enabled: false` is the switch for a publisher who asks us to stop.
    // Withdrawn is not the same as unreachable: nobody should be told to
    // install an app to reach something we have stopped offering.
    const withdrawn = { ...sourceById('hearham')!, enabled: false }
    expect(withdrawn.enabled).toBe(false)
    for (const host of ['browser', 'desktop', 'android', 'ios'] as const) {
      const all = [...availableSources(host), ...unreachableSources(host)]
      expect(all.every((s) => s.enabled), host).toBe(true)
    }
  })
})

describe('detectHost fails closed', () => {
  it('answers browser for anything that is not the exact shape the preload promises', () => {
    // A bug that guesses "desktop" offers a control that cannot work. Every
    // ambiguous input has to land on the less capable answer.
    for (const injected of [
      undefined,
      null,
      {},
      { desktop: false },
      { desktop: 'true' },
      { desktop: 1 },
      'desktop',
      [],
    ]) {
      expect(detectHost(injected), JSON.stringify(injected) ?? 'undefined').toBe('browser')
    }
  })

  it('answers desktop only for a literal true', () => {
    expect(detectHost({ desktop: true })).toBe('desktop')
  })

  it('grants the browser host nothing a shell would have to supply', () => {
    // `usbHost` and `print` are true in a browser because they describe the
    // machine, not the shell. Everything a shell adds is absent.
    const caps = capabilitiesFor('browser')
    expect(caps.crossOriginFetch).toBe(false)
    expect(caps.fileVault).toBe(false)
    expect(caps.customUserAgent).toBe(false)
    expect(caps.nativeSerial).toBe(false)
    expect(caps.nativeBluetooth).toBe(false)
    expect(caps.shareSheet).toBe(false)
  })

  it('reaches the cross-origin sources from both mobile shells', () => {
    // The mobile plugin fetches outside the WebView just as the desktop shell
    // fetches outside the renderer, so the same two sources open up.
    for (const host of ['android', 'ios'] as const) {
      const ids = availableSources(host).map((s) => s.id)
      expect(ids, host).toContain('hearham')
      expect(ids, host).toContain('radioid')
    }
  })
})

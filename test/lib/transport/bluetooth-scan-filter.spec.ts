// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest'
import {
  advertisedServicesOf,
  matchesProfiles,
  namePrefixesOf,
} from '#core/transport/bluetooth-scan-filter.js'
import {
  BL1_DONGLE_PROFILES,
  NORDIC_UART,
  TIDRADIO_BL1_FF00,
  UV5RM_BLE,
  normaliseUuid,
} from '#core/transport/bluetooth-uuids.js'

describe('matching by name, the way the chooser does', () => {
  it('lists a UV-5R Mini by the name two real units advertised', () => {
    expect(matchesProfiles({ name: 'walkie-talkie' }, [UV5RM_BLE])).toBe(true)
  })

  it('covers each enumerated casing and no other', () => {
    // `namePrefix` is case-sensitive, so the profile enumerates the casings
    // rather than assuming one. The filter here has to be as literal.
    expect(matchesProfiles({ name: 'Walkie-Talkie' }, [UV5RM_BLE])).toBe(true)
    expect(matchesProfiles({ name: 'WALKIE TALKIE' }, [UV5RM_BLE])).toBe(true)
    expect(matchesProfiles({ name: 'wAlKiE' }, [UV5RM_BLE])).toBe(false)
  })

  it('matches a prefix, so a trailing space in the name is harmless', () => {
    // The BF_Writer's name as a real one advertised it, trailing space and
    // all. A prefix compare does not care what follows.
    expect(matchesProfiles({ name: 'BF_Writer_CD4 ' }, [TIDRADIO_BL1_FF00])).toBe(true)
  })

  it('reads the advertisement-carried local name too', () => {
    // Some platforms report the name from the scan record separately from
    // the cached device name, and either is enough for the browser.
    expect(matchesProfiles({ localName: 'TIDRADIO PTTf816cb-A' }, [TIDRADIO_BL1_FF00])).toBe(true)
    expect(matchesProfiles({ name: null, localName: 'walkie-talkie' }, [UV5RM_BLE])).toBe(true)
  })

  it('does not match a name that merely contains the prefix', () => {
    expect(matchesProfiles({ name: 'my walkie' }, [UV5RM_BLE])).toBe(false)
  })
})

describe('matching by advertised service, not enumerated service', () => {
  it('lists the BF_Writer by the service it broadcasts', () => {
    /*
     * BF98 is what the dongle advertises; FF00 is where its characteristics
     * live and was learned by connecting. The browser matches only the
     * broadcast, and the first release filtered on FF00 and listed nothing
     * with the dongle a foot away. This filter must make the same distinction.
     */
    expect(matchesProfiles({ uuids: ['bf98'] }, [TIDRADIO_BL1_FF00])).toBe(true)
  })

  it('still lists the fob that advertises FF00 itself', () => {
    expect(matchesProfiles({ uuids: ['ff00'] }, [TIDRADIO_BL1_FF00])).toBe(true)
  })

  it('lists a nameless FFE0 advertisement for the UV-5R Mini', () => {
    // Whether the Mini advertises FFE0 is unverified, but if it does, the
    // service half of the filter is what catches a unit with no name.
    expect(matchesProfiles({ uuids: ['ffe0'] }, [UV5RM_BLE])).toBe(true)
  })

  it('accepts the 128-bit spelling of a 16-bit alias', () => {
    // Platforms differ on which form they report, and a compare on the raw
    // string would silently miss a radio for a reason nobody could see.
    expect(matchesProfiles({ uuids: ['0000FFE0-0000-1000-8000-00805F9B34FB'] }, [UV5RM_BLE])).toBe(true)
  })

  it('ignores an entry that is not a UUID rather than refusing the whole advertisement', () => {
    expect(matchesProfiles({ uuids: ['garbage', 'ffe0'] }, [UV5RM_BLE])).toBe(true)
  })
})

describe('what does not match', () => {
  it('leaves an unrelated device off the list', () => {
    expect(matchesProfiles({ name: 'JBL Flip', uuids: ['180f', '1812'] }, [UV5RM_BLE, ...BL1_DONGLE_PROFILES])).toBe(
      false,
    )
  })

  it('lists nothing at all for an empty candidate list', () => {
    // No candidates is no filter to match, not a filter that matches
    // everything - "show every device" is a different, explicit request.
    expect(matchesProfiles({ name: 'walkie-talkie', uuids: ['ffe0'] }, [])).toBe(false)
  })

  it('does not list a device with no name and no services', () => {
    expect(matchesProfiles({}, [UV5RM_BLE, TIDRADIO_BL1_FF00])).toBe(false)
  })
})

describe('the lists a scan is built from', () => {
  it('collects advertised services, substituting them for the enumerated one where they differ', () => {
    const services = advertisedServicesOf([UV5RM_BLE, TIDRADIO_BL1_FF00, NORDIC_UART])
    expect(services).toContain(normaliseUuid('ffe0'))
    expect(services).toContain(normaliseUuid('bf98'))
    expect(services).toContain(normaliseUuid('ff00'))
    expect(services).toContain(NORDIC_UART.service)
    expect(new Set(services).size).toBe(services.length)
  })

  it('collects every name prefix once', () => {
    // Both dongle profiles share one prefix list; a scan carrying it twice
    // is harmless in the browser and noise everywhere else.
    const prefixes = namePrefixesOf(BL1_DONGLE_PROFILES)
    expect(prefixes).toEqual([...TIDRADIO_BL1_FF00.namePrefixes])
    expect(namePrefixesOf([UV5RM_BLE])).toEqual(['walkie', 'Walkie', 'WALKIE'])
  })
})

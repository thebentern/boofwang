// SPDX-License-Identifier: GPL-3.0-or-later
import { DesyncedError, DeviceDisconnectedError, TransportTimeoutError } from '../transport/errors.js'
import type { RadioDriver } from './driver.js'

/**
 * What to do about a transfer that failed on the wire.
 *
 * The error classes say what went wrong precisely, which is the right thing for
 * a bug report and the wrong thing to leave somebody holding. "Serial stream is
 * out of sync (while attempting: write)" is accurate and tells a person nothing
 * they can act on - and a desync is sticky, so every button they press
 * afterwards fails the same way until the port is reopened.
 *
 * The advice differs by radio, which is why this takes the driver rather than
 * guessing. A UV-K5 has a reset command that can be fired on the way out, so
 * reconnecting is enough. The others have no way to leave programming mode at
 * all, so the cable is the only thing that resets them.
 */
export function recoveryAdvice(error: unknown, driver: Pick<RadioDriver, 'abortPolicy'> | null): string | null {
  const stranded = driver?.abortPolicy !== 'reset-command'

  /*
   * Unplugging is recommended over reloading the page, deliberately.
   *
   * A reload closes the port too, but it also discards the open codeplug and
   * every unwritten edit in it - which is a bad trade for someone whose radio
   * is fine and whose line is merely confused. Pulling the cable resets the
   * radio and keeps the work.
   */
  const reseat = stranded
    ? 'Unplug the cable and plug it back in, then read the radio again. This radio has no command for '
      + 'leaving programming mode, so the cable is what resets it. Reloading the page also clears the '
      + 'line, but it discards the codeplug you have open.'
    : 'Read the radio again. If that does not clear it, unplug the cable and plug it back in.'

  if (error instanceof DesyncedError) {
    return 'A reply arrived late and everything after it would be shifted, so nothing further is trusted. '
      + reseat
  }

  if (error instanceof TransportTimeoutError) {
    /*
     * On a radio with no way out of programming mode, silence usually means it
     * is still in it.
     *
     * The DM-32UV answers V-frames before programming mode and not after, and
     * it leaves that mode only when the port closes. So an attempt that got as
     * far as entering it strands the radio, and every retry afterwards asks a
     * question the radio will not answer - a timeout with nothing buffered,
     * which reads like a dead cable and is not one.
     */
    return stranded
      ? 'Nothing came back. If an earlier attempt got as far as talking to the radio, it is probably still '
        + 'in programming mode, which it only leaves when the cable is pulled. Unplug the cable, plug it '
        + 'back in, and read the radio again. Otherwise check the radio is switched on and the plug is '
        + 'pushed all the way in.'
      : 'Nothing came back. Check the radio is switched on and the plug is pushed all the way in, then '
        + 'try again.'
  }

  if (error instanceof DeviceDisconnectedError) {
    return 'The cable came out, or the adapter was unplugged. Plug it back in and read the radio again.'
  }

  return null
}

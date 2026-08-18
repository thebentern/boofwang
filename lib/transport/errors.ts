// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Transport errors are deliberately specific.
 *
 * When a driver is being brought up against a radio whose protocol is only
 * partly documented, "read failed" is useless and "expected 8 bytes for
 * PSEARCH, got 3 after 5000ms; buffer holds 06 44 50" is the whole debugging
 * session. Every error below carries what was actually on the wire.
 */

export class TransportError extends Error {
  override readonly name: string = 'TransportError'
}

export class TransportClosedError extends TransportError {
  override readonly name = 'TransportClosedError'
  constructor(readonly op: string) {
    super(`Port is not open (while attempting: ${op})`)
  }
}

export class TransportTimeoutError extends TransportError {
  override readonly name = 'TransportTimeoutError'
  constructor(
    readonly op: string,
    readonly timeoutMs: number,
    readonly buffered: string,
    readonly bufferedLength: number,
  ) {
    super(
      `Timed out after ${timeoutMs}ms waiting for ${op}. ` +
        `${bufferedLength} byte(s) buffered: ${buffered || '(nothing)'}`,
    )
  }
}

/**
 * The line is out of step and cannot be trusted.
 *
 * Raised for every operation after a timeout or abort, until `resync()` runs.
 * The failure this prevents is the nasty one: a late reply to a timed-out
 * command satisfies the *next* read, every frame after it is shifted by a few
 * bytes, and the driver cheerfully writes the resulting garbage to the radio.
 */
export class DesyncedError extends TransportError {
  override readonly name = 'DesyncedError'
  constructor(readonly op: string) {
    super(`Serial stream is out of sync (while attempting: ${op}). Resynchronise before continuing.`)
  }
}

export class DeviceDisconnectedError extends TransportError {
  override readonly name = 'DeviceDisconnectedError'
  constructor(message = 'The radio was disconnected') {
    super(message)
  }
}

export class TransferAbortedError extends TransportError {
  override readonly name = 'TransferAbortedError'
  constructor(readonly op: string) {
    super(`Transfer aborted (while attempting: ${op})`)
  }
}

export class ReadLimitError extends TransportError {
  override readonly name = 'ReadLimitError'
  constructor(
    readonly op: string,
    readonly limit: number,
  ) {
    super(`Read exceeded ${limit} bytes without finding the delimiter (while attempting: ${op})`)
  }
}

/** A reply arrived but did not match what the protocol requires. */
export class ProtocolError extends TransportError {
  override readonly name: string = 'ProtocolError'
  constructor(
    message: string,
    readonly expected?: string,
    readonly received?: string,
  ) {
    super(
      message +
        (expected !== undefined ? `\n  expected: ${expected}` : '') +
        (received !== undefined ? `\n  received: ${received}` : ''),
    )
  }
}

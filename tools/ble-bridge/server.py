#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""A localhost WebSocket-to-Bluetooth bridge, for development only.

The serial bridge beside this one exists because Web Serial deliberately
requires a person to answer a native port chooser, which an automated session
can never do. Web Bluetooth is worse: its chooser cannot be styled, read or
predicted either, and the browsers that implement it at all are a narrower set
than those with Web Serial.

So the browser is taken out of the Bluetooth path entirely. This process holds
the GATT connection and speaks exactly the protocol `tools/serial-bridge`
speaks - JSON control messages, raw binary frames both directions - so
`BridgeSerialPort` connects to it without knowing or caring that the far end is
a radio over the air rather than a cable. Everything above `SerialPortLike` is
the shipping code path, unchanged.

Written in Python rather than Node beside its sibling for one reason: `bleak`
works on macOS today and has read a whole codeplug off a real radio, where
`noble` is fragile there and would need a second permission grant.

Not part of the built app. Nothing starts it automatically. It binds to
loopback, refuses non-local origins, and the client half is gated behind both a
dev build and an explicit `?bridge` parameter.

    pnpm bridge:ble                       # this process
    pnpm dev                              # in another terminal
    open http://localhost:3000/?bridge

macOS will refuse Bluetooth to a process whose owning application has not been
granted it, and refuses by killing the process rather than returning an error -
an instant exit with no message is that, not a fault here.
"""
import argparse
import asyncio
import json
import sys
from urllib.parse import urlparse

try:
    from bleak import BleakClient, BleakScanner
except ImportError:
    sys.exit("bleak is not installed.  python3 -m venv .venv && .venv/bin/pip install bleak websockets")
try:
    import websockets
except ImportError:
    sys.exit("websockets is not installed.  python3 -m venv .venv && .venv/bin/pip install bleak websockets")

HOST = "127.0.0.1"
PORT = 8766
ALLOWED_ORIGINS = ("http://localhost", "http://127.0.0.1", "http://[::1]")

# The Baofeng wireless CPS profile, confirmed by a radio answering its own
# identify magic on it. See lib/transport/bluetooth-uuids.ts, which holds the
# same numbers for the browser-side path.
SERVICE = "0000ffe0-0000-1000-8000-00805f9b34fb"
WRITE_CHAR = "0000ffe1-0000-1000-8000-00805f9b34fb"
NOTIFY_CHAR = "0000ffe1-0000-1000-8000-00805f9b34fb"

# The floor an ATT payload is guaranteed to carry. Negotiating higher is
# possible but not worth the failure mode: a write that silently truncates
# looks like a radio that stopped answering half way through a frame.
MTU_PAYLOAD = 20


def log(*a):
    print(*a, flush=True)


class Discovery:
    """A rolling view of what is advertising nearby.

    Scanning on demand does not work here. The client gives a port list two
    seconds - fine for enumerating serial devices, which is a directory read -
    but a BLE scan needs several seconds of listening to be reliable, so an
    on-demand scan times out before it can answer. That failure looks exactly
    like a bridge that is not running.

    So the scanner runs for the life of the process and `list` answers from
    what it has already seen, which is both instant and a better model of a
    medium where devices come and go rather than being plugged in.
    """

    def __init__(self, args):
        self.args = args
        self.seen: dict[str, dict] = {}
        self._scanner: BleakScanner | None = None

    def _on_detect(self, device, adv):
        uuids = [u.lower() for u in (adv.service_uuids or [])]
        if not self.args.all and SERVICE not in uuids:
            return
        name = device.name or adv.local_name
        if device.address not in self.seen:
            log(f"saw {name or '(unnamed)'} at {device.address}")
        self.seen[device.address] = {
            "path": device.address,
            "manufacturer": name,
            "serialNumber": None,
            "vendorId": None,
            "productId": None,
            # The whole reason this field exists: a driver that varies on the
            # carrier has to be told, not left to guess.
            "kind": "bluetooth",
        }

    async def start(self):
        self._scanner = BleakScanner(detection_callback=self._on_detect)
        await self._scanner.start()

    def ports(self):
        return sorted(self.seen.values(), key=lambda p: p["path"])


class Bridge:
    """One browser tab, holding at most one radio."""

    def __init__(self, ws, args, discovery):
        self.ws = ws
        self.args = args
        self.discovery = discovery
        self.client: BleakClient | None = None
        self.rx = 0
        self.tx = 0

    async def send(self, obj):
        await self.ws.send(json.dumps(obj))

    async def on_notify(self, _sender, data: bytearray):
        self.rx += len(data)
        try:
            await self.ws.send(bytes(data))
        except Exception:
            pass

    async def scan(self):
        """Whatever the rolling scanner has seen, answered immediately."""
        return self.discovery.ports()

    async def open(self, msg):
        if self.client is not None:
            await self.close_radio("reopening")
        address = msg.get("path")
        if not address:
            raise ValueError("open needs the device address in `path`")

        log(f"connecting to {address}")
        client = BleakClient(address)
        await client.connect()
        await client.start_notify(NOTIFY_CHAR, self.on_notify)
        self.client = client
        self.rx = self.tx = 0
        log(f"connected to {address} over {NOTIFY_CHAR[4:8].upper()}")
        await self.send({"op": "open", "ok": True, "path": address, "kind": "bluetooth"})

    async def write(self, payload: bytes):
        if self.client is None:
            raise RuntimeError("no radio is connected")
        # The page cannot know the MTU, so the split happens here. Without it a
        # frame longer than the payload limit is silently truncated.
        for i in range(0, len(payload), MTU_PAYLOAD):
            await self.client.write_gatt_char(WRITE_CHAR, payload[i:i + MTU_PAYLOAD], response=False)
        self.tx += len(payload)

    async def close_radio(self, reason: str):
        client, self.client = self.client, None
        if client is None:
            return
        try:
            await client.stop_notify(NOTIFY_CHAR)
        except Exception:
            pass
        try:
            await client.disconnect()
        except Exception:
            pass
        log(f"disconnected ({reason}); {self.tx} bytes out, {self.rx} bytes in")

    async def handle(self, raw):
        if isinstance(raw, (bytes, bytearray)):
            await self.write(bytes(raw))
            return
        try:
            msg = json.loads(raw)
        except json.JSONDecodeError:
            return await self.send({"op": "error", "message": "Malformed control message"})

        op = msg.get("op")
        try:
            if op == "list":
                return await self.send({"op": "list", "ports": await self.scan()})
            if op == "open":
                return await self.open(msg)
            if op in ("signals", "flush"):
                # There is no DTR, no RTS and no driver buffer to drain over
                # GATT. Answering ok rather than erroring keeps the driver code
                # identical across both carriers, which is the point.
                return await self.send({"op": op, "ok": True})
            if op == "close":
                await self.close_radio("client asked")
                return await self.send({"op": "close", "ok": True})
            return await self.send({"op": "error", "message": f"Unknown op {op!r}"})
        except Exception as e:
            log(f"{op} failed: {e}")
            return await self.send({"op": "error", "message": str(e)})


async def serve(args):
    discovery = Discovery(args)
    await discovery.start()

    async def connection(ws):
        origin = getattr(ws, "request", None) and ws.request.headers.get("Origin")
        if origin and not any(origin.startswith(o) for o in ALLOWED_ORIGINS):
            log(f"refused a connection from {origin}")
            await ws.close(code=1008, reason="origin not allowed")
            return
        log(f"client connected{f' from {origin}' if origin else ''}")
        bridge = Bridge(ws, args, discovery)
        try:
            async for raw in ws:
                await bridge.handle(raw)
        except websockets.ConnectionClosed:
            pass
        finally:
            await bridge.close_radio("client went away")
            log("client disconnected")

    async with websockets.serve(connection, HOST, args.port, max_size=None):
        log(f"boofwang bluetooth bridge listening on ws://{HOST}:{args.port}")
        log("development only: not part of the built app, and nothing starts it automatically")
        log(f"filtering the scan on {SERVICE}" + ("  (--all to see everything)" if not args.all else ""))
        log("scanning continuously; a port list is answered from what has been seen")
        await asyncio.Future()


def main():
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("--port", type=int, default=PORT, help=f"websocket port (default {PORT})")
    p.add_argument("--all", action="store_true", help="list every device, not just ones advertising the CPS service")
    args = p.parse_args()
    try:
        asyncio.run(serve(args))
    except KeyboardInterrupt:
        log("\nstopped")


if __name__ == "__main__":
    main()

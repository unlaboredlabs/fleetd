#!/usr/bin/env python3
"""scripts/netem.py: a userspace TCP proxy that makes a link slow, lossy and flaky, to measure fleetd's connections on
a weak network without root (the W464 sweep's numbers came through it). Point a client at --listen, the proxy at a
throwaway hub's port (its own FLEETD_HOME and port, never a real hub):

  scripts/netem.py --listen 48331 --target 47901 --control 48332 [--rtt 0.3 --loss 0.015 --mbit 1 --nat-idle 30]

- delay: half the RTT each way, plus one RTT for the TCP handshake before the first byte;
- bandwidth: each direction serialises its bytes at --mbit, with 52 bytes of TCP/IP header per 1448-byte segment;
- loss: a lost segment stalls its direction for an RTO plus a trip (head-of-line, as TCP sees it) and counts twice;
- --queue B: the bottleneck holds at most B bytes waiting to go out; past that the proxy stops reading, so the sender
  feels the link (its socket fills) as behind a real router. Absent: it holds everything (a sender never waits);
- --nat-idle S: a flow quiet both ways for S seconds is blackholed, as a cellular NAT forgets it: nothing gets through
  and neither end is told.
Control port, one command a line, answered with a JSON line: `stats` (bytes up and down, segments, connections),
`reset` (zero them), `drop <sec>` (reset every open connection, refuse new ones for <sec> s), `quit`.
"""
import argparse
import asyncio
import json
import random
import sys
import time

p = argparse.ArgumentParser()
p.add_argument("--listen", type=int, required=True)
p.add_argument("--target", type=int, required=True)
p.add_argument("--control", type=int, required=True)
p.add_argument("--rtt", type=float, default=0.300)
p.add_argument("--loss", type=float, default=0.015)
p.add_argument("--mbit", type=float, default=1.0)
p.add_argument("--nat-idle", type=float, default=0.0)
p.add_argument("--seed", type=int, default=1)
p.add_argument("--queue", type=int, default=0)
a = p.parse_args()
random.seed(a.seed)
MSS, HDR = 1448, 52
RTO = max(0.2, a.rtt) + a.rtt

stats = {"up": 0, "down": 0, "segs": 0, "conns": 0}
flows = {}
refuse_until = 0.0


class Direction:
    def __init__(self):
        self.free = 0.0  # when the link next has room (serialisation)
        self.last = 0.0  # in order: nothing arrives before what was sent earlier


async def pipe(reader, writer, d, key, flow):
    queue = asyncio.Queue()

    async def deliver():
        while True:
            at, data = await queue.get()
            if data is None:
                break
            delay = at - time.monotonic()
            if delay > 0:
                await asyncio.sleep(delay)
            if flow["dead"]:
                continue
            try:
                writer.write(data)
                await writer.drain()
            except Exception:
                break
        try:
            writer.close()
        except Exception:
            pass

    delivering = asyncio.create_task(deliver())
    try:
        while True:
            if a.queue:
                # The bottleneck's buffer is full: read nothing more until it drains.
                backlog = (d.free - time.monotonic()) * a.mbit * 1e6 / 8
                if backlog > a.queue:
                    await asyncio.sleep((backlog - a.queue) * 8 / (a.mbit * 1e6))
            data = await reader.read(16384 if a.queue else 65536)
            if not data or flow["dead"]:
                break
            now = time.monotonic()
            if a.nat_idle and now - flow["seen"] > a.nat_idle:
                flow["dead"] = True
                break
            flow["seen"] = now
            for i in range(0, len(data), MSS):
                seg = data[i:i + MSS]
                stats[key] += len(seg) + HDR
                stats["segs"] += 1
                d.free = max(now, d.free) + (len(seg) + HDR) * 8 / (a.mbit * 1e6)
                arrive = d.free + a.rtt / 2
                if random.random() < a.loss:
                    arrive += RTO
                    stats[key] += len(seg) + HDR
                d.last = arrive = max(arrive, d.last)
                queue.put_nowait((arrive, seg))
    except Exception:
        pass
    queue.put_nowait((0, None))
    if flow["dead"]:
        await asyncio.sleep(3600)  # a blackholed flow stays half-open, as behind a real NAT
    await delivering


async def handle(client_reader, client_writer):
    if time.monotonic() < refuse_until:
        client_writer.close()
        return
    try:
        target_reader, target_writer = await asyncio.open_connection("127.0.0.1", a.target)
    except Exception:
        client_writer.close()
        return
    stats["conns"] += 1
    flow = {"dead": False, "seen": time.monotonic(), "writers": (client_writer, target_writer)}
    flows[id(flow)] = flow
    await asyncio.sleep(a.rtt)
    await asyncio.gather(
        pipe(client_reader, target_writer, Direction(), "up", flow),
        pipe(target_reader, client_writer, Direction(), "down", flow),
    )
    flows.pop(id(flow), None)


async def control(reader, writer):
    global refuse_until
    line = (await reader.readline()).decode().split()
    out = {}
    if line[:1] == ["stats"]:
        out = dict(stats)
    elif line[:1] == ["reset"]:
        for k in stats:
            stats[k] = 0
        out = {"ok": True}
    elif line[:1] == ["drop"] and len(line) == 2:
        refuse_until = time.monotonic() + float(line[1])
        for flow in list(flows.values()):
            flow["dead"] = True
            for w in flow["writers"]:
                try:
                    w.transport.abort()
                except Exception:
                    pass
        out = {"dropped": len(flows)}
    elif line[:1] == ["quit"]:
        writer.write(b"{}\n")
        await writer.drain()
        sys.exit(0)
    writer.write((json.dumps(out) + "\n").encode())
    await writer.drain()
    writer.close()


async def main():
    proxy = await asyncio.start_server(handle, "127.0.0.1", a.listen)
    ctl = await asyncio.start_server(control, "127.0.0.1", a.control)
    print("netem ready", flush=True)
    await asyncio.gather(proxy.serve_forever(), ctl.serve_forever())


asyncio.run(main())

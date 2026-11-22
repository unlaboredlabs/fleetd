// scripts/netem.ts: a userspace TCP proxy that makes a link slow, lossy and flaky, to measure fleetd's connections on
// a weak network without root. Everything TCP goes through it (HTTP, WebSocket, the node link), so a browser, an app
// or a node pointed at its port sees the link a profile describes. Point it only at a throwaway hub's port (its own
// FLEETD_HOME and port), never a real hub. Runs under Node 24 and Bun alike, as a CLI or imported:
//
//   bun scripts/netem.ts --profile 3g --target 47901 [--listen 48331] [--control 48332] [--rtt 0.3 --loss 0.01 …]
//   import { startNetem } from "../../scripts/netem.ts";  const n = await startNetem({ target: 47901, profile: "3g" });
//
// The model, per direction of each connection:
// - delay: half the RTT each way plus jitter (uniform ±jitter, in order: TCP never delivers out of order), and one RTT
//   for the TCP handshake before the first byte;
// - bandwidth: bytes serialise at the direction's rate, with 52 bytes of TCP/IP header per 1448-byte segment;
// - loss: a lost segment stalls its direction for an RTO plus a trip (head-of-line, as TCP sees it), counted twice;
// - queue: the bottleneck holds at most `queue` bytes waiting; past that the proxy stops reading, so the sender's
//   socket fills as behind a real router (0: unbounded);
// - natIdle: a flow quiet both ways that long is blackholed, as a cellular NAT forgets it;
// - outages (`cut`, and `flap` on a timer): for their length nothing crosses the link. Connections open when it went
//   down are gone for good, neither end told (a laptop that slept, a switch from wifi to cell): their bytes vanish.
//   A connection opened during it hangs, as a SYN does, and goes through once the link is back. `stall` holds every
//   byte instead and lets it all through after (a short blip TCP rides out); `reset` kills every connection with an
//   RST and refuses new ones (a proxy or server restart).
//
// Control (CLI: a TCP port, one command a line, a JSON line back): `stats`, `reset`, `cut <s>`, `stall <s>`,
// `drop <s>` (the RST kind), `profile <name>`, `quit`. Stats count payload bytes each way (`up` = client → target) and
// `wireUp`/`wireDown` with headers and retransmits, connections made, and connections killed by outages.
import net from "node:net";

export interface Link {
  /** Round trip, seconds. */
  rtt: number;
  /** ± seconds on each one-way trip. */
  jitter: number;
  /** Chance a segment is lost (0..1). */
  loss: number;
  /** Bits per second, target → client and client → target (0: unlimited). */
  downBps: number;
  upBps: number;
  /** Bottleneck buffer, bytes (0: unbounded). */
  queue: number;
  /** A flow quiet both ways this long is blackholed (0: never). */
  natIdle: number;
  /** Every `every` seconds the link goes down for `for` seconds (cut semantics). */
  flap?: { every: number; for: number };
}

const base: Link = { rtt: 0, jitter: 0, loss: 0, downBps: 0, upBps: 0, queue: 0, natIdle: 0 };

/** The named profiles every sweep measures under. */
export const PROFILES: Record<string, Link> = {
  clean: base,
  "3g": { ...base, rtt: 0.3, jitter: 0.04, loss: 0.01, downBps: 1.6e6, upBps: 768e3, queue: 64 * 1024 },
  satellite: { ...base, rtt: 0.6, jitter: 0.02, loss: 0.005, downBps: 10e6, upBps: 2e6, queue: 256 * 1024 },
  "lossy-wifi": { ...base, rtt: 0.04, jitter: 0.03, loss: 0.05, downBps: 20e6, upBps: 10e6, queue: 128 * 1024 },
  flapping: { ...base, rtt: 0.08, jitter: 0.01, downBps: 10e6, upBps: 5e6, flap: { every: 30, for: 5 } },
  "tiny-bandwidth": { ...base, rtt: 0.15, jitter: 0.01, downBps: 256e3, upBps: 256e3, queue: 32 * 1024 },
};

export interface Stats {
  up: number;
  down: number;
  wireUp: number;
  wireDown: number;
  conns: number;
  killed: number;
}

export interface Netem {
  /** The port clients dial. */
  readonly port: number;
  readonly url: string;
  readonly stats: () => Stats;
  readonly reset: () => void;
  /** Link down for `seconds`: open connections lost silently, new ones hang until it's back. */
  readonly cut: (seconds: number) => void;
  /** Link down for `seconds`, every byte held and delivered after. */
  readonly stall: (seconds: number) => void;
  /** RST every connection, refuse new ones for `seconds`. */
  readonly drop: (seconds: number) => void;
  /** Whether the link is down right now. */
  readonly down: () => boolean;
  readonly setLink: (link: Link | string) => void;
  readonly close: () => Promise<void>;
}

const MSS = 1448;
const HDR = 52;

/** A small seeded PRNG (mulberry32), so a profile's losses repeat run to run. */
const rng = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

export const resolveLink = (link: Link | string, overrides: Partial<Link> = {}): Link => {
  const named = typeof link === "string" ? PROFILES[link] : link;
  if (named === undefined) throw new Error(`netem: no profile ${String(link)} (${Object.keys(PROFILES).join(", ")})`);
  return { ...named, ...overrides };
};

interface Flow {
  /** Killed by an outage: its bytes vanish from now on. */
  dead: boolean;
  seen: number;
  sockets: Array<net.Socket>;
  /** Waiting for the link to come back before dialling the target. */
  waiting?: () => void;
}

export const startNetem = async (opts: {
  target: number | { host: string; port: number };
  profile?: Link | string;
  overrides?: Partial<Link>;
  listen?: number;
  seed?: number;
}): Promise<Netem> => {
  const target = typeof opts.target === "number" ? { host: "127.0.0.1", port: opts.target } : opts.target;
  let link = resolveLink(opts.profile ?? "clean", opts.overrides);
  const random = rng(opts.seed ?? 1);
  const stats: Stats = { up: 0, down: 0, wireUp: 0, wireDown: 0, conns: 0, killed: 0 };
  const flows = new Set<Flow>();
  /** Every socket the proxy holds, dead flows' half-open ones too, for close(). */
  const sockets = new Set<net.Socket>();
  /** Until when (performance.now() ms) the link is down, and how. */
  let downUntil = 0;
  let downKind: "cut" | "stall" | "reset" = "cut";
  let flapTimer: ReturnType<typeof setInterval> | undefined;
  const now = () => performance.now();
  const isDown = () => now() < downUntil;

  const backUp = () => {
    for (const f of flows) {
      const go = f.waiting;
      f.waiting = undefined;
      go?.();
    }
  };
  let upTimer: ReturnType<typeof setTimeout> | undefined;
  const goDown = (seconds: number, kind: "cut" | "stall" | "reset") => {
    downUntil = Math.max(downUntil, now() + seconds * 1000);
    downKind = kind;
    if (kind !== "stall") {
      for (const f of flows) {
        if (f.waiting !== undefined || f.dead) continue; // not through yet: it hangs and goes on after
        f.dead = true;
        stats.killed++;
        if (kind === "reset") for (const s of f.sockets) s.resetAndDestroy?.() ?? s.destroy();
      }
    }
    clearTimeout(upTimer);
    upTimer = setTimeout(backUp, downUntil - now());
  };
  const armFlap = () => {
    clearInterval(flapTimer);
    flapTimer = undefined;
    const flap = link.flap;
    if (flap !== undefined) flapTimer = setInterval(() => goDown(flap.for, "cut"), flap.every * 1000);
    flapTimer?.unref?.();
  };
  armFlap();

  /** Carries one direction: from `from` to `to`, delayed, paced and lossy as the link says. */
  const pipe = (from: net.Socket, to: net.Socket, flow: Flow, dir: "up" | "down") => {
    let free = 0; // when the link next has room (serialisation), ms
    let last = 0; // in order: nothing arrives before what was sent earlier
    const queue: Array<{ at: number; data: Buffer }> = [];
    let timer: ReturnType<typeof setTimeout> | undefined;
    let ended = false;
    const pump = () => {
      timer = undefined;
      const t = now();
      while (queue.length > 0 && queue[0]!.at <= t) {
        // A stalled link holds its bytes until it's back.
        if (isDown() && downKind === "stall") {
          timer = setTimeout(pump, downUntil - t + 1);
          return;
        }
        const { data } = queue.shift()!;
        if (!flow.dead && !to.destroyed) to.write(data);
      }
      if (queue.length > 0) timer = setTimeout(pump, Math.max(0, queue[0]!.at - t));
      else if (ended && !flow.dead) to.end();
      resume();
    };
    const resume = () => {
      if (link.queue <= 0 || !from.isPaused()) return;
      const rate = dir === "down" ? link.downBps : link.upBps;
      const backlog = rate > 0 ? ((free - now()) / 1000) * (rate / 8) : 0;
      if (backlog <= link.queue) from.resume();
    };
    from.on("data", (chunk: Buffer) => {
      const t = now();
      if (link.natIdle > 0 && !flow.dead && t - flow.seen > link.natIdle * 1000) {
        flow.dead = true;
        stats.killed++;
      }
      flow.seen = t;
      if (flow.dead) return;
      // Bytes sent while the link is cut never arrive; while stalled they wait (pump holds them).
      if (isDown() && downKind === "cut") return;
      const rate = dir === "down" ? link.downBps : link.upBps;
      for (let i = 0; i < chunk.length; i += MSS) {
        const seg = chunk.subarray(i, i + MSS);
        const wire = seg.length + HDR;
        stats[dir] += seg.length;
        stats[dir === "up" ? "wireUp" : "wireDown"] += wire;
        free = rate > 0 ? Math.max(t, free) + (wire * 8 * 1000) / rate : t;
        const jitter = link.jitter > 0 ? (random() * 2 - 1) * link.jitter * 1000 : 0;
        let at = free + Math.max(0, (link.rtt * 1000) / 2 + jitter);
        if (link.loss > 0 && random() < link.loss) {
          at += (Math.max(0.2, link.rtt) + link.rtt) * 1000;
          stats[dir === "up" ? "wireUp" : "wireDown"] += wire;
        }
        last = at = Math.max(at, last);
        queue.push({ at, data: Buffer.from(seg) });
      }
      if (timer === undefined) timer = setTimeout(pump, Math.max(0, queue[0]!.at - t));
      if (link.queue > 0 && rate > 0 && ((free - t) / 1000) * (rate / 8) > link.queue) from.pause();
    });
    from.on("end", () => {
      ended = true;
      if (queue.length === 0 && timer === undefined && !flow.dead) to.end();
    });
  };

  const server = net.createServer((client) => {
    client.setNoDelay(true);
    if (isDown() && downKind === "reset") {
      client.resetAndDestroy?.() ?? client.destroy();
      return;
    }
    const flow: Flow = { dead: false, seen: now(), sockets: [client] };
    flows.add(flow);
    sockets.add(client);
    client.on("close", () => sockets.delete(client));
    client.pause();
    const forget = () => {
      flows.delete(flow);
      for (const s of flow.sockets) s.destroy();
    };
    client.on("error", forget);
    client.on("close", () => {
      // A dead flow stays half-open on the other side, as behind a real NAT: only a live one passes the close on.
      if (!flow.dead) forget();
      else flows.delete(flow);
    });
    const dial = () => {
      if (client.destroyed) return;
      stats.conns++;
      const upstream = net.connect(target.port, target.host);
      upstream.setNoDelay(true);
      flow.sockets.push(upstream);
      sockets.add(upstream);
      upstream.on("close", () => sockets.delete(upstream));
      upstream.on("error", forget);
      upstream.on("close", () => {
        if (!flow.dead) forget();
      });
      upstream.once("connect", () => {
        // The handshake's round trip before the first byte.
        setTimeout(() => {
          pipe(client, upstream, flow, "up");
          pipe(upstream, client, flow, "down");
          client.resume();
        }, link.rtt * 1000);
      });
    };
    if (isDown()) flow.waiting = dial;
    else dial();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.listen ?? 0, "127.0.0.1", () => resolve());
  });
  const port = (server.address() as net.AddressInfo).port;
  return {
    port,
    url: `http://127.0.0.1:${port}`,
    stats: () => ({ ...stats }),
    reset: () => {
      for (const k of Object.keys(stats) as Array<keyof Stats>) stats[k] = 0;
    },
    cut: (s) => goDown(s, "cut"),
    stall: (s) => goDown(s, "stall"),
    drop: (s) => goDown(s, "reset"),
    down: isDown,
    setLink: (l) => {
      link = resolveLink(l);
      armFlap();
    },
    close: async () => {
      clearInterval(flapTimer);
      clearTimeout(upTimer);
      for (const s of sockets) s.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
};

/** One command to a CLI netem's control port; its JSON answer. */
export const netemControl = (port: number, command: string) =>
  new Promise<Record<string, unknown>>((resolve, reject) => {
    const c = net.connect(port, "127.0.0.1", () => c.write(`${command}\n`));
    let text = "";
    c.on("data", (d) => {
      text += d;
      if (text.includes("\n")) {
        c.end();
        resolve(JSON.parse(text) as Record<string, unknown>);
      }
    });
    c.on("error", reject);
  });

const cli = async (argv: Array<string>) => {
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) flags.set(argv[i]!.replace(/^--/u, ""), argv[i + 1] ?? "");
  const num = (k: string) => (flags.has(k) ? Number(flags.get(k)) : undefined);
  const targetArg = flags.get("target");
  if (targetArg === undefined) throw new Error("netem: --target <port|host:port> is required");
  const [host, p] = targetArg.includes(":") ? targetArg.split(":") : ["127.0.0.1", targetArg];
  const overrides: Partial<Link> = {};
  const rtt = num("rtt");
  if (rtt !== undefined) overrides.rtt = rtt;
  const jitter = num("jitter");
  if (jitter !== undefined) overrides.jitter = jitter;
  const loss = num("loss");
  if (loss !== undefined) overrides.loss = loss;
  const mbit = num("mbit");
  if (mbit !== undefined) overrides.downBps = overrides.upBps = mbit * 1e6;
  const queue = num("queue");
  if (queue !== undefined) overrides.queue = queue;
  const natIdle = num("nat-idle");
  if (natIdle !== undefined) overrides.natIdle = natIdle;
  const n = await startNetem({
    target: { host: host!, port: Number(p) },
    profile: flags.get("profile") ?? "clean",
    overrides,
    listen: num("listen"),
    seed: num("seed"),
  });
  const control = net.createServer((sock) => {
    let buf = "";
    sock.on("data", (d) => {
      buf += d;
      const nl = buf.indexOf("\n");
      if (nl < 0) return;
      const [cmd, arg] = buf.slice(0, nl).trim().split(/\s+/u);
      let out: unknown = { ok: true };
      try {
        if (cmd === "stats") out = n.stats();
        else if (cmd === "reset") n.reset();
        else if (cmd === "cut") n.cut(Number(arg));
        else if (cmd === "stall") n.stall(Number(arg));
        else if (cmd === "drop") n.drop(Number(arg));
        else if (cmd === "profile") n.setLink(arg ?? "clean");
        else if (cmd === "quit") {
          sock.end("{}\n", () => process.exit(0));
          return;
        } else out = { error: `unknown command ${cmd}` };
      } catch (e) {
        out = { error: String(e) };
      }
      sock.end(`${JSON.stringify(out)}\n`);
    });
  });
  await new Promise<void>((resolve) => control.listen(num("control") ?? 0, "127.0.0.1", () => resolve()));
  const controlPort = (control.address() as net.AddressInfo).port;
  process.stdout.write(`${JSON.stringify({ ready: true, listen: n.port, control: controlPort, profile: flags.get("profile") ?? "clean" })}\n`);
  const stop = () => void n.close().then(() => process.exit(0));
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
};

if (import.meta.main ?? process.argv[1]?.endsWith("netem.ts")) {
  cli(process.argv.slice(2)).catch((e: unknown) => {
    process.stderr.write(`${String(e)}\n`);
    process.exit(1);
  });
}

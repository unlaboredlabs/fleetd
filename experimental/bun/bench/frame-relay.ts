// Live-screen frame relay, Rust hub against Bun: one node streams a browser session's frames, 100 app connections
// watch it, and the hub relays each frame to every one. Measures the hub process's CPU per frame relayed (utime +
// stime from /proc), its peak RSS, and the time from the node's send to each watcher's receipt.
//
//   bun bench/frame-relay.ts rust [--fleetd <binary>] [--viewers 100] [--frames 300] [--fps 30] [--kb 60]
//   bun bench/frame-relay.ts bun  [same]
//
// Each run is on a fresh home under $TMPDIR, with FLEETD_HOME pointed there, on a free loopback port: never the live
// hub. The Rust hub is the real binary (`hub start`); its node is this script, linked by an ed25519 key it writes into
// the fresh database, and its watchers authenticate with a human key written there too. The Bun hub is
// bench/relay-bun-hub.ts: its real node link and src/hub/browser, with a stand-in for /app until that area lands.
import { Database } from "bun:sqlite";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const arg = (name: string, fallback: string) => {
  const at = process.argv.indexOf(`--${name}`);
  return at > 0 ? process.argv[at + 1]! : fallback;
};
const mode = process.argv[2] === "bun" ? "bun" : "rust";
const VIEWERS = Number(arg("viewers", "100"));
const FRAMES = Number(arg("frames", "300"));
const FPS = Number(arg("fps", "30"));
const KB = Number(arg("kb", "60"));
const SESSION = "B0123456789abcdef0123456789abcdef";

const root = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "fleetd-relay-bench-"));
const home = join(root, "hub");
const port = 20_000 + Math.floor(Math.random() * 10_000);
const env = { ...process.env, FLEETD_HOME: root, FLEETD_HUB_URL: `http://127.0.0.1:${port}` };

const child =
  mode === "rust"
    ? Bun.spawn([arg("fleetd", join(homedir(), ".fleetd", "bin", "fleetd")), "hub", "start", "--home", home, "--listen", `127.0.0.1:${port}`], {
        env,
        stdout: "ignore",
        stderr: "ignore",
      })
    : Bun.spawn(["bun", join(import.meta.dir, "relay-bun-hub.ts"), home, String(port)], { env, stdout: "pipe", stderr: "inherit" });

async function up(): Promise<void> {
  for (let i = 0; i < 200; i++) {
    try {
      if (mode === "rust") {
        if ((await fetch(`http://127.0.0.1:${port}/healthz`)).ok) return;
      } else {
        await fetch(`http://127.0.0.1:${port}/x`);
        return;
      }
    } catch {
      // Not listening yet.
    }
    await Bun.sleep(50);
  }
  throw new Error("the hub didn't come up");
}

const cpuMs = () => {
  const fields = readFileSync(`/proc/${child.pid}/stat`, "utf8").split(") ")[1]!.split(" ");
  return ((Number(fields[11]) + Number(fields[12])) * 1000) / 100;
};
const rssMb = () => {
  const line = readFileSync(`/proc/${child.pid}/status`, "utf8").split("\n").find((l) => l.startsWith("VmHWM:"))!;
  return Number(line.split(/\s+/)[1]) / 1024;
};

const B32 = "abcdefghijklmnopqrstuvwxyz234567";
const KEY = `fld_${[...crypto.getRandomValues(new Uint8Array(52))].map((b) => B32[b % 32]).join("")}`;
const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const pubRaw = publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("base64");

function seed(): void {
  const db = new Database(join(home, "hub.sqlite"));
  db.run("PRAGMA busy_timeout = 5000");
  const now = new Date().toISOString();
  db.query("INSERT OR REPLACE INTO machines (machine_id, data) VALUES ('devbox', ?)").run(
    JSON.stringify({ machineId: "devbox", name: "devbox", nodeVersion: "0.0.0", status: "offline", lastSeenAt: now, tags: [] }),
  );
  db.query("INSERT OR REPLACE INTO node_keys (machine_id, pub_key) VALUES ('devbox', ?)").run(pubRaw);
  db.query("INSERT INTO agent_keys (key_id, hash, prefix, name, grants, created_ms, kind) VALUES ('key_bench', ?, ?, 'bench', ?, ?, 'human')").run(
    new Bun.CryptoHasher("sha256").update(KEY).digest("hex"),
    KEY.slice(0, 10),
    JSON.stringify([{ role: "operate", machines: "*" }]),
    Date.now(),
  );
  const session = {
    sessionId: SESSION,
    projectRef: { machineId: "devbox", projectId: "p1" },
    kind: "browser",
    threadId: "t1",
    purpose: "bench",
    state: "live",
    control: "agent",
    startedAt: now,
    files: [],
    credentialsFilled: 0,
  };
  db.query("INSERT INTO browser_sessions (session_id, machine_id, project_id, started_ms, state, bytes, data) VALUES (?, 'devbox', 'p1', ?, 'live', 0, ?)").run(
    SESSION,
    Date.now(),
    JSON.stringify(session),
  );
  db.close();
}

/** The node: links with its key, answers the challenge, then waits to be told the session is watched. */
async function linkNode(): Promise<{ ws: WebSocket; watched: Promise<void> }> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/node/link`);
  let watchedResolve!: () => void;
  const watched = new Promise<void>((r) => (watchedResolve = r));
  const linked = new Promise<void>((resolve, reject) => {
    ws.onmessage = (e) => {
      const m = JSON.parse(String(e.data)) as { t: string; nonce?: string; on?: boolean };
      if (m.t === "challenge") {
        const sig = sign(null, Buffer.from(m.nonce!), privateKey).toString("base64");
        ws.send(
          JSON.stringify({
            t: "hello",
            machineId: "devbox",
            name: "devbox",
            tags: [],
            nodeVersion: "0.0.0",
            protocol: 1,
            pubKey: pubRaw,
            sig,
            capabilities: ["browser"],
          }),
        );
      } else if (m.t === "welcome") resolve();
      else if (m.t === "browser_watch" && m.on) watchedResolve();
    };
    ws.onclose = (e) => reject(new Error(`the node link closed: ${e.code} ${e.reason}`));
  });
  await linked;
  return { ws, watched };
}

type Viewer = { ws: WebSocket; got: Map<number, number> };

async function viewer(): Promise<Viewer> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/app`);
  const got = new Map<number, number>();
  await new Promise((r) => (ws.onopen = r));
  const ready = new Promise<void>((resolve) => {
    ws.onmessage = (e) => {
      const text = String(e.data);
      if (text.startsWith('{"t":"ready"') || text.includes('"t":"ready"')) resolve();
      if (text.includes('"browser_frame"')) {
        const seq = Number(/"seq":(\d+)/.exec(text)?.[1]);
        got.set(seq, performance.now());
      }
    };
  });
  ws.send(JSON.stringify({ t: "auth", key: KEY }));
  await ready;
  ws.send(JSON.stringify({ t: "browser_watch", session: SESSION }));
  return { ws, got };
}

const pct = (xs: number[], p: number) => xs.sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor((xs.length * p) / 100))] ?? Number.NaN;

try {
  await up();
  seed();
  const node = await linkNode();
  const viewers: Viewer[] = [];
  for (let i = 0; i < VIEWERS; i++) viewers.push(await viewer());
  await node.watched;
  await Bun.sleep(300);
  // A JPEG-sized frame of base64: the hub relays it as it is, never decoding it.
  const jpegB64 = Buffer.alloc(KB * 1024, 7).toString("base64");
  const sentAt = new Map<number, number>();
  // The hub's own background work over a window as long as the stream's, with no frames: subtracted below.
  const streamMs = (FRAMES / FPS) * 1000 + 1500;
  const idle0 = cpuMs();
  await Bun.sleep(streamMs);
  const idle = cpuMs() - idle0;
  const cpu0 = cpuMs();
  const t0 = performance.now();
  for (let seq = 1; seq <= FRAMES; seq++) {
    sentAt.set(seq, performance.now());
    node.ws.send(JSON.stringify({ t: "browser_frame", sessionId: SESSION, seq, jpegB64, width: 1280, height: 800, control: "agent" }));
    await Bun.sleep(1000 / FPS);
  }
  await Bun.sleep(1500);
  const raw = cpuMs() - cpu0;
  const cpu = Math.max(raw - idle, 0);
  const wall = performance.now() - t0;
  const latencies: number[] = [];
  let delivered = 0;
  for (const v of viewers) {
    for (const [seq, at] of v.got) {
      if (!sentAt.has(seq)) continue;
      delivered += 1;
      latencies.push(at - sentAt.get(seq)!);
    }
  }
  const result = {
    hub: mode,
    viewers: VIEWERS,
    frames: FRAMES,
    frameKb: KB,
    fps: FPS,
    delivered,
    expected: VIEWERS * FRAMES,
    hubCpuMsRaw: Math.round(raw),
    hubCpuMsIdle: Math.round(idle),
    hubCpuMs: Math.round(cpu),
    hubCpuPct: Math.round((cpu / wall) * 1000) / 10,
    cpuUsPerDelivery: Math.round((cpu * 1000) / Math.max(delivered, 1) * 10) / 10,
    latencyMsP50: Math.round(pct(latencies, 50) * 10) / 10,
    latencyMsP99: Math.round(pct(latencies, 99) * 10) / 10,
    hubPeakRssMb: Math.round(rssMb()),
  };
  console.log(JSON.stringify(result));
  for (const v of viewers) v.ws.close();
  node.ws.close();
} finally {
  child.kill("SIGTERM");
  await child.exited;
  rmSync(root, { recursive: true, force: true });
}

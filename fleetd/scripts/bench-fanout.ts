// One event stream to many viewers, against any hub: `bun scripts/bench-fanout.ts --url
// http://127.0.0.1:4795 --home <its hub home> [--viewers 100] [--events 500]`. It adds a person and a human key to
// the hub's database (as `fleetd pair` would), connects the viewers on /app with that key, each streaming events,
// then one writer sets the person's chat pins `--events` times, each a `chat.pins` event every viewer reads. It
// reports how long each event took to reach the last viewer (p50, p99, max) and the events per second through all.
// Only for a hub on a fresh --home: never the live one.
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { Inflater } from "../src/hub/link/deflate.ts";

const { values } = parseArgs({
  options: {
    url: { type: "string" },
    home: { type: "string" },
    viewers: { type: "string", default: "100" },
    events: { type: "string", default: "500" },
    deflate: { type: "boolean", default: false },
    // At most this many writes not yet seen by every viewer: an open loop would measure the queue, not the hub.
    window: { type: "string", default: "8" },
  },
});
if (!values.url || !values.home) throw new Error("--url and --home are required");
const viewers = Number(values.viewers);
const total = Number(values.events);
const window = Number(values.window);
const wsUrl = `${values.url.replace(/^http/, "ws")}/app`;

const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";
const bytes = crypto.getRandomValues(new Uint8Array(52));
const key = `fld_${[...bytes].map((b) => BASE32[b % 32]).join("")}`;
const db = new Database(join(values.home, "hub.sqlite"));
db.run("PRAGMA busy_timeout = 5000");
const person = `p_${[...crypto.getRandomValues(new Uint8Array(8))].map((b) => BASE32[b % 32]).join("")}`;
db.query("INSERT INTO people (person_id, name, role, created_ms) VALUES (?, 'Bench', 'owner', ?)").run(person, Date.now());
db.query(
  "INSERT INTO agent_keys (key_id, hash, prefix, name, grants, created_ms, kind, person_id) VALUES (?, ?, ?, 'bench', ?, ?, 'human', ?)",
).run(
  `key_${person}`,
  new Bun.CryptoHasher("sha256").update(key).digest("hex"),
  key.slice(0, 10),
  JSON.stringify([{ role: "admin", machines: "*" }]),
  Date.now(),
  person,
);
db.close();

type Frame = { t: string; seq?: number; type?: string; cursor?: number } & Record<string, unknown>;

function connect(onFrame: (f: Frame) => void): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    ws.binaryType = "arraybuffer";
    // Compressed frames are one stream per connection: read in order.
    const inflater = new Inflater(64 << 20);
    let queue = Promise.resolve();
    ws.addEventListener("message", (e) => {
      const data = e.data;
      if (typeof data === "string") {
        queue = queue.then(() => onFrame(JSON.parse(data) as Frame));
        return;
      }
      const text = inflater.inflate(new Uint8Array(data as ArrayBuffer));
      queue = queue.then(async () => onFrame(JSON.parse(await text) as Frame));
    });
    ws.addEventListener("open", () => {
      ws.send(JSON.stringify({ t: "auth", key, ...(values.deflate ? { features: ["deflate"] } : {}) }));
      resolve(ws);
    });
    ws.addEventListener("error", () => reject(new Error(`could not connect to ${wsUrl}`)));
  });
}

// seq -> how many viewers have it, and when it was asked for.
const seen = new Map<number, number>();
const sentAt: number[] = [];
const latencies: number[] = [];
let done = 0;
let resolveAll: () => void = () => {};
const allSeen = new Promise<void>((r) => (resolveAll = r));
let firstSeq: number | undefined;
let release: () => void = () => {};

const sockets: WebSocket[] = [];
let cursor = 0;
const control = await connect(() => {});
for (let i = 0; i < viewers; i++) {
  sockets.push(
    await connect((f) => {
      if (f.t !== "event" || f.type !== "chat.pins" || f.seq === undefined) return;
      const n = (seen.get(f.seq) ?? 0) + 1;
      seen.set(f.seq, n);
      if (n === viewers) {
        firstSeq ??= f.seq;
        const index = f.seq - firstSeq;
        const at = sentAt[index];
        if (at !== undefined) latencies.push(performance.now() - at);
        seen.delete(f.seq);
        done++;
        release();
        if (done === total) resolveAll();
      }
    }),
  );
}
// Every viewer streams from the head, as the app does after its snapshot.
const head = await new Promise<number>((resolve) => {
  const ws = new WebSocket(wsUrl);
  ws.addEventListener("open", () => ws.send(JSON.stringify({ t: "auth", key })));
  ws.addEventListener("message", (e) => {
    const f = JSON.parse(e.data as string) as Frame;
    if (f.t === "ready") ws.send(JSON.stringify({ t: "call", id: "h", tool: "events_wait", input: { timeoutSec: 0 } }));
    if (f.t === "result") {
      ws.close();
      resolve((f.output as { cursor: number }).cursor);
    }
  });
});
cursor = head;
for (const ws of sockets) ws.send(JSON.stringify({ t: "events", cursor }));
await Bun.sleep(300);

const refs = [{ machineId: "devbox", projectId: "p1" }];
const started = performance.now();
for (let i = 0; i < total; i++) {
  while (i - done >= window) await new Promise<void>((r) => (release = r));
  sentAt.push(performance.now());
  control.send(JSON.stringify({ t: "call", id: `w${i}`, tool: "chat_pins_set", input: { pins: refs } }));
}
await allSeen;
const elapsed = performance.now() - started;
latencies.sort((a, b) => a - b);
const at = (p: number) => latencies[Math.min(latencies.length - 1, Math.floor(p * latencies.length))]?.toFixed(2);
console.log(
  JSON.stringify({
    viewers,
    events: total,
    deflate: values.deflate,
    window,
    eventsPerSec: Math.round((total / elapsed) * 1000),
    deliveriesPerSec: Math.round(((total * viewers) / elapsed) * 1000),
    toLastViewerMs: { p50: at(0.5), p99: at(0.99), max: latencies.at(-1)?.toFixed(2) },
  }),
);
for (const ws of [...sockets, control]) ws.close();
process.exit(0);

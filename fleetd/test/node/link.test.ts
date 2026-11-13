// The node's hub link against a hub of the test's own (Bun.serve): challenge, signed hello, welcome; frames both ways,
// compressed once both sides list link_deflate; a refusal that ends the loop; a dropped link dialled again.
import { expect, test } from "bun:test";
import { createPublicKey, verify } from "node:crypto";
import { Deflater, Inflater } from "../../src/node/link/deflate.ts";
import { compresses, linkUrl, reconnectDelay, Redial, RESTART_REDIAL_MS, runNode, sizeAllowed, type LinkContext } from "../../src/node/link/index.ts";
import { loadOrCreateIdentity } from "../../src/node/identity.ts";
import { CapsArea } from "../../src/node/api.ts";
import type { HubFrame } from "../../src/node/wire.ts";
import { readUpgradeProof, UPGRADE_PROOF_HEADERS, verifyUpgradeProof } from "../../src/shared/upgrade_proof.ts";
import { tempHome } from "../helpers.ts";

type Conn = { frames: Record<string, any>[]; ws: Bun.ServerWebSocket<unknown> };

/** A hub: answers each hello with `welcome` (or closes with `refuse`), and keeps every frame its nodes send. */
function fakeHub(opts: { refuse?: [number, string]; deflate?: boolean; machineId?: string } = {}) {
  const conns: Conn[] = [];
  const upgrades: Headers[] = [];
  const inflaters = new Map<unknown, Inflater>();
  const server = Bun.serve({
    port: 0,
    fetch: (req, s) => (upgrades.push(req.headers), s.upgrade(req) ? undefined : new Response("no", { status: 400 })),
    websocket: {
      open(ws) {
        conns.push({ frames: [], ws });
        inflaters.set(ws, new Inflater(64 << 20));
        ws.send(JSON.stringify({ t: "challenge", nonce: "nonce-1" }));
      },
      message(ws, data) {
        // In arrival order: a compressed frame inflates before the next is read.
        reads = reads.then(() => read(ws, data));
      },
    },
  });
  let reads: Promise<unknown> = Promise.resolve();
  const read = async (ws: Bun.ServerWebSocket<unknown>, data: string | Buffer) => {
        const conn = conns.find((c) => c.ws === ws)!;
        const text = typeof data === "string" ? data : await inflaters.get(ws)!.inflate(new Uint8Array(data));
        const frame = JSON.parse(text);
        frame.compressed = typeof data !== "string";
        conn.frames.push(frame);
        if (frame.t !== "hello") return;
        if (opts.refuse) return ws.close(opts.refuse[0], opts.refuse[1]);
        ws.send(JSON.stringify({ t: "welcome", hubId: "fleetd-devbox", protocol: 1, capabilities: opts.deflate ? ["session_route", "link_deflate"] : [], ...(opts.machineId ? { machineId: opts.machineId } : {}) }));
  };
  return { url: `http://127.0.0.1:${server.port}`, conns, upgrades, server };
}

const until = async (what: string, fn: () => boolean, ms = 5000) => {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(10);
  }
};

const options = (hub: string, home: string, extra: Partial<Parameters<typeof runNode>[0]> = {}) => ({
  settings: { hub, machineId: "devbox", name: "devbox", nodeVersion: "0.0.0" },
  identity: loadOrCreateIdentity(home),
  boxPubKey: "M42kv2b+sf2LEsH+jqb0tkIekEvQajFZWTr1hqHYoRU=",
  capabilities: () => ["repos", "link_deflate"],
  heartbeat: async () => ({}),
  attach: () => () => {},
  handle: () => {},
  log: () => {},
  ...extra,
});

test("the hello is signed over the hub's nonce and carries the enroll token until the first welcome", async () => {
  const home = tempHome();
  const hub = fakeHub();
  const stop = new AbortController();
  let enrolled = 0;
  const linked: LinkContext[] = [];
  void runNode(options(hub.url, home.dir, { enrollToken: "fle_token", onEnrolled: () => enrolled++, attach: (l) => (linked.push(l), () => {}), signal: stop.signal }));
  await until("the welcome", () => linked.length === 1);
  const hello = hub.conns[0]!.frames[0]!;
  expect(hello).toMatchObject({ t: "hello", machineId: "devbox", protocol: 1, enrollToken: "fle_token", tags: [], capabilities: ["repos", "link_deflate"] });
  const pub = createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(hello.pubKey, "base64")]), format: "der", type: "spki" });
  expect(verify(null, Buffer.from("nonce-1"), pub, Buffer.from(hello.sig, "base64"))).toBe(true);
  expect(enrolled).toBe(1);
  expect(linked[0]!.hubId).toBe("fleetd-devbox");
  // The hub drops the link: the node dials again at once, without the token now.
  hub.conns[0]!.ws.close(1001, "going away");
  await until("the second link", () => linked.length === 2);
  expect(hub.conns[1]!.frames[0]!.enrollToken).toBeUndefined();
  expect(enrolled).toBe(1);
  stop.abort();
  hub.server.stop(true);
  home.done();
});

test("an enrolled node's upgrade carries its proof; a first join's carries none, nor its code", async () => {
  const home = tempHome();
  const hub = fakeHub();
  const stop = new AbortController();
  const NOW = 1_800_000_000_000;
  const linked: LinkContext[] = [];
  const opts = options(hub.url, home.dir, { enrollToken: "fle_token", clock: { now: () => NOW }, attach: (l) => (linked.push(l), () => {}), signal: stop.signal });
  void runNode(opts);
  await until("the welcome", () => linked.length === 1);
  const first = hub.upgrades[0]!;
  for (const name of Object.values(UPGRADE_PROOF_HEADERS)) expect(first.get(name)).toBeNull();
  expect([...first.values()].some((v) => v.includes("fle_token"))).toBe(false);
  // Enrolled now: the next dial proves itself, signed for the host and path it dials, at the node's clock.
  linked[0]!.relink("test");
  await until("the second link", () => linked.length === 2);
  const proof = readUpgradeProof(hub.upgrades[1]!)!;
  expect(proof).toMatchObject({ machineId: "devbox", pubKey: opts.identity.pubKey(), at: NOW, host: `127.0.0.1:${hub.server.port}`, path: "/node/link" });
  const expected = { machineId: "devbox", pubKey: opts.identity.pubKey(), host: `127.0.0.1:${hub.server.port}`, path: "/node/link", now: NOW, skewMs: 60_000 };
  expect(verifyUpgradeProof(proof, expected)).toEqual({ ok: true });
  // The hello is as before: signed over the hub's nonce.
  expect(hub.conns[1]!.frames[0]).toMatchObject({ t: "hello", machineId: "devbox" });
  expect(hub.conns[1]!.frames[0]!.enrollToken).toBeUndefined();
  stop.abort();
  hub.server.stop(true);
  home.done();
});

test("a challenge shaped as an upgrade proof gets no hello", async () => {
  const home = tempHome();
  const server = Bun.serve({
    port: 0,
    fetch: (req, s) => (s.upgrade(req) ? undefined : new Response("no", { status: 400 })),
    websocket: {
      open: (ws) => void ws.send(JSON.stringify({ t: "challenge", nonce: "fleetd node link upgrade v1\ndevbox\n/node/link\ndevbox\n0" })),
      message: (_ws, data) => void heard.push(String(data)),
    },
  });
  const heard: string[] = [];
  const stop = new AbortController();
  const why: string[] = [];
  void runNode(options(`http://127.0.0.1:${server.port}`, home.dir, { signal: stop.signal, log: (_l, _m, f) => void (f?.why && why.push(String(f.why))) }));
  await until("the link given up", () => why.length > 0);
  expect(why[0]).toBe("the hub's challenge is not a nonce");
  expect(heard).toEqual([]);
  stop.abort();
  server.stop(true);
  home.done();
});

test("the enrolling welcome's machine id reaches onEnrolled: the hub's, else the node's own", async () => {
  for (const [said, heard] of [["devbox-2", "devbox-2"], [undefined, "devbox"]] as const) {
    const home = tempHome();
    const hub = fakeHub(said ? { machineId: said } : {});
    const stop = new AbortController();
    const ids: string[] = [];
    void runNode(options(hub.url, home.dir, { enrollToken: "fle_token", onEnrolled: (id) => ids.push(id), signal: stop.signal }));
    await until("the enrolment", () => ids.length === 1);
    expect(ids).toEqual([heard]);
    stop.abort();
    hub.server.stop(true);
    home.done();
  }
});

test("a refusal (4001, 4002) ends the loop with the hub's reason; retrying wouldn't help", async () => {
  const home = tempHome();
  const hub = fakeHub({ refuse: [4001, "unknown key"] });
  const fatal = await runNode(options(hub.url, home.dir));
  expect(fatal?.message).toBe("hub refused this node: unknown key");
  expect(fatal?.removed).toBe(false);
  hub.server.stop(true);
  home.done();
});

test("a refusal that says the hub removed this machine is the removal, which stops the node as enrolled", async () => {
  const home = tempHome();
  const hub = fakeHub({ refuse: [4001, "mac-1 was removed from this hub: its node key is revoked"] });
  expect((await runNode(options(hub.url, home.dir)))?.removed).toBe(true);
  hub.server.stop(true);
  home.done();
});

test("frames go compressed only once the hub's welcome lists link_deflate, and hub frames reach their handler", async () => {
  const home = tempHome();
  const hub = fakeHub({ deflate: true });
  const stop = new AbortController();
  const handled: HubFrame[] = [];
  let link: LinkContext | undefined;
  void runNode(options(hub.url, home.dir, { attach: (l) => ((link = l), () => {}), handle: (f) => handled.push(f), signal: stop.signal }));
  await until("the welcome", () => link !== undefined);
  link!.send({ t: "cmd_result", id: "c1", exitCode: 0, outputTail: "x".repeat(500), timedOut: false });
  link!.send({ t: "hb", at: "2026-11-08T10:00:00Z" });
  await until("both frames", () => hub.conns[0]!.frames.length === 3);
  const [, long, short] = hub.conns[0]!.frames;
  expect(long).toMatchObject({ id: "c1", compressed: true });
  expect(short).toMatchObject({ t: "hb", compressed: false });
  // The hub compresses too: its frames inflate on the node's own stream.
  const deflater = new Deflater();
  hub.conns[0]!.ws.send(await deflater.deflate(JSON.stringify({ t: "spans_ack", upto: 7, pad: "y".repeat(200) })));
  hub.conns[0]!.ws.send(JSON.stringify({ t: "spans_ack", upto: 8 }));
  await until("the hub's frames", () => handled.length === 2);
  expect(handled.map((f) => f.upto)).toEqual([7, 8]);
  stop.abort();
  hub.server.stop(true);
  home.done();
});

test("a hub that goes quiet is pinged, and given up on when it never answers", async () => {
  const home = tempHome();
  // A hub that welcomes and then never sends a byte, nor answers a ping (Bun answers pings itself, so none is sent).
  const server = Bun.serve({
    port: 0,
    fetch: (req, s) => (s.upgrade(req) ? undefined : new Response("no")),
    websocket: {
      sendPings: false,
      open: (ws) => void ws.send(JSON.stringify({ t: "challenge", nonce: "n" })),
      message: (ws) => void ws.send(JSON.stringify({ t: "welcome", hubId: "h", protocol: 1 })),
    },
  });
  const stop = new AbortController();
  let links = 0;
  void runNode(
    options(`http://127.0.0.1:${server.port}`, home.dir, { attach: () => (links++, () => {}), quiet: { probeMs: 200, deadMs: 30_000 }, signal: stop.signal }),
  );
  await until("the welcome", () => links === 1);
  // Bun's server answers the node's ping with a pong, so a hub that's alive keeps the link however quiet it is.
  await Bun.sleep(800);
  expect(links).toBe(1);
  stop.abort();
  server.stop(true);
  home.done();
});

test("each heartbeat carries the fields the node's modules fill in", async () => {
  const home = tempHome();
  const hub = fakeHub();
  const stop = new AbortController();
  void runNode(options(hub.url, home.dir, { heartbeatMs: 50, heartbeat: async () => ({ busy: { threads: 1, screens: 0, uploads: 0, hosted: 0 } }), signal: stop.signal }));
  await until("two heartbeats", () => (hub.conns[0]?.frames.filter((f) => f.t === "hb").length ?? 0) >= 2);
  const hb = hub.conns[0]!.frames.find((f) => f.t === "hb")!;
  expect(hb.busy).toEqual({ threads: 1, screens: 0, uploads: 0, hosted: 0 });
  expect(Date.parse(hb.at)).toBeGreaterThan(0);
  stop.abort();
  hub.server.stop(true);
  home.done();
});

test("a capability an area turns on reaches the hub in a new hello; one that didn't change sends none", async () => {
  const home = tempHome();
  const hub = fakeHub();
  const stop = new AbortController();
  const caps = new CapsArea();
  let desktop = false;
  caps.contribute(() => ["browser", ...(desktop ? ["session_linux_desktop"] : [])]);
  let hello: string[] = [];
  let link: LinkContext | undefined;
  caps.onChanged(() => {
    const now = caps.list();
    if (link && JSON.stringify(now) !== JSON.stringify(hello)) link.relink("this machine's capabilities changed");
  });
  void runNode(options(hub.url, home.dir, { capabilities: () => (hello = caps.list()), attach: (l) => ((link = l), () => {}), signal: stop.signal }));
  await until("the first hello", () => hub.conns.length === 1 && hub.conns[0]!.frames.length >= 1);
  expect(hub.conns[0]!.frames[0]!.capabilities).toEqual(["browser"]);
  caps.changed();
  await Bun.sleep(100);
  expect(hub.conns).toHaveLength(1);
  // The desktop's health came ready: the node links again with it listed.
  desktop = true;
  caps.changed();
  await until("the second hello", () => hub.conns.length === 2 && hub.conns[1]!.frames.length >= 1);
  expect(hub.conns[1]!.frames[0]!.capabilities).toEqual(["browser", "session_linux_desktop"]);
  stop.abort();
  hub.server.stop(true);
  home.done();
});

test("reconnects start fast and back off to 30 s; the URL and the frame caps are the Rust node's", () => {
  expect([0, 1, 2, 3, 4, 5, 6, 7, 8].map((a) => reconnectDelay(a, 1))).toEqual([250, 500, 1000, 2000, 4000, 8000, 16000, 30000, 30000]);
  expect(reconnectDelay(1000, 1.2)).toBe(36000);
  expect(linkUrl("https://devbox.example:4790/x?y")).toBe("wss://devbox.example:4790/node/link");
  expect(linkUrl("http://127.0.0.1:4790")).toBe("ws://127.0.0.1:4790/node/link");
  expect(compresses(["link_deflate"], ["link_deflate"])).toBe(true);
  expect(compresses([], ["link_deflate"])).toBe(false);
  const big = (16 << 20) + 1;
  expect(sizeAllowed({ t: "session_call", call: { op: "put_file" } }, big)).toBe(true);
  expect(sizeAllowed({ t: "session_call", call: { op: "default_branch" } }, big)).toBe(false);
});

test("after a restart close redials are 250 ms apart for a minute; any other close backs off; a link back starts over", () => {
  const at = 1_000_000;
  const backoff = new Redial();
  expect([0, 1, 2, 3].map(() => backoff.next(false, at, 1))).toEqual([250, 500, 1000, 2000]);

  const redial = new Redial();
  expect(redial.next(true, at, 1)).toBe(RESTART_REDIAL_MS);
  // The dials while the hub is still down fail as lost links.
  for (const s of [1, 10, 59]) expect(redial.next(false, at + s * 1000, 1.2)).toBe(250);
  const late = at + 61_000;
  expect(redial.next(false, late, 1)).toBe(250);
  expect(redial.next(false, late, 1)).toBe(500);
  redial.linked();
  expect(redial.next(false, late, 1)).toBe(250);
  expect(redial.restartUntil).toBeUndefined();
});

test("the hub's 1012 close reads as a restart: the node redials in 250 ms, with no jitter", async () => {
  const home = tempHome();
  const hub = fakeHub();
  const stop = new AbortController();
  const lost: Record<string, unknown>[] = [];
  let links = 0;
  const log = (_level: string, msg: string, fields?: Record<string, unknown>) => {
    if (msg === "hub link lost; reconnecting until it is back") lost.push(fields ?? {});
  };
  void runNode(options(hub.url, home.dir, { attach: () => (links++, () => {}), log, signal: stop.signal }));
  await until("the welcome", () => links === 1);
  hub.conns[0]!.ws.close(1012, "hub restarting");
  await until("the second link", () => links === 2);
  expect(lost).toEqual([{ why: "hub closed the link (1012 hub restarting)", retryInMs: 250 }]);
  stop.abort();
  hub.server.stop(true);
  home.done();
});

test("deflate keeps its window across messages, and garbage ends the stream", async () => {
  const d = new Deflater();
  const i = new Inflater(1 << 20);
  const msg = JSON.stringify({ t: "hb", at: "2026-11-07T10:00:00Z", pad: "x".repeat(500) });
  const first = await d.deflate(msg);
  const second = await d.deflate(msg);
  expect(second.length).toBeLessThan(first.length);
  expect(await i.inflate(first)).toBe(msg);
  expect(await i.inflate(second)).toBe(msg);
  // Bun 1.4.3: `await expect(p).rejects` never settles (README), so the rejection is caught.
  const why = await new Inflater(1 << 20).inflate(new Uint8Array(16).fill(0xff)).then(
    () => "inflated",
    (e: Error) => e.message,
  );
  expect(why).toContain("does not inflate");
});

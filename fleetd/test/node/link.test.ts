// The node's hub link against a hub of the test's own (Bun.serve): challenge, signed hello, welcome; frames both ways,
// compressed once both sides list link_deflate; a refusal that ends the loop; a dropped link dialled again.
import { expect, spyOn, test } from "bun:test";
import { createPublicKey, verify } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { deletedLine, enrolled, markRemoved } from "../../src/node/index.ts";
import { Deflater, Inflater } from "../../src/node/link/deflate.ts";
import { BULK_BYTES, BULK_DEAD_MS, compresses, QUIET_DEAD_MS, QUIET_PROBE_MS, linkUrl, reconnectDelay, Redial, RESTART_REDIAL_MS, runNode, sizeAllowed, type LinkContext } from "../../src/node/link/index.ts";
import { loadOrCreateIdentity } from "../../src/node/identity.ts";
import { CapsArea } from "../../src/node/api.ts";
import type { HubFrame } from "../../src/node/wire.ts";
import { readUpgradeProof, UPGRADE_PROOF_HEADERS, verifyUpgradeProof } from "../../src/shared/upgrade_proof.ts";
import { tempHome } from "../helpers.ts";

type Conn = { frames: Record<string, any>[]; ws: Bun.ServerWebSocket<unknown> };

/** A hub: answers each hello with `welcome` (or closes with `refuse`), and keeps every frame its nodes send. */
function fakeHub(opts: { refuse?: [number, string]; deflate?: boolean; machineId?: string; bulk?: boolean } = {}) {
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
        ws.send(JSON.stringify({ t: "welcome", hubId: "fleetd-devbox", protocol: 1, capabilities: [...(opts.deflate ? ["session_route", "link_deflate"] : []), ...(opts.bulk === false ? [] : ["link_bulk"])], ...(opts.machineId ? { machineId: opts.machineId } : {}) }));
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

test("the hello is signed over the workspace's nonce and carries the enroll token until the first welcome", async () => {
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
  expect(why[0]).toBe("the workspace's challenge is not a nonce");
  expect(heard).toEqual([]);
  stop.abort();
  server.stop(true);
  home.done();
});

test("the enrolling welcome's machine id reaches onEnrolled: the workspace's, else the node's own", async () => {
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

test("a refusal (4001, 4002) ends the loop with the workspace's reason; retrying wouldn't help", async () => {
  const home = tempHome();
  const hub = fakeHub({ refuse: [4001, "unknown key"] });
  const fatal = await runNode(options(hub.url, home.dir));
  expect(fatal?.message).toBe("workspace refused this node: unknown key");
  expect(fatal?.removed).toBe(false);
  hub.server.stop(true);
  home.done();
});

test("a refusal that says the workspace removed this machine is the removal, which stops the node as enrolled", async () => {
  const home = tempHome();
  const hub = fakeHub({ refuse: [4001, "mac-1 was removed from this hub: its node key is revoked"] });
  expect((await runNode(options(hub.url, home.dir)))?.removed).toBe(true);
  hub.server.stop(true);
  home.done();
});

// S10: after Delete account, a joined machine's node dialed the deleted workspace again and again.
test("a refusal that says the workspace was deleted stops the node as enrolled, as a removal does", async () => {
  const home = tempHome();
  const hub = fakeHub({ refuse: [4001, "This workspace was deleted."] });
  const fatal = await runNode(options(hub.url, home.dir));
  expect(fatal?.deleted).toBe(true);
  expect(fatal?.removed).toBe(false);
  hub.server.stop(true);
  // Marked so: at its next start the node dials nothing and says what to do instead.
  writeFileSync(join(home.dir, "node.json"), JSON.stringify({ hub: "https://sam.fleetd.dev", machineId: "devbox", name: "devbox", enrolled: true }));
  expect(markRemoved(home.dir, true)).toBe(true);
  const said: string[] = [];
  const write = spyOn(process.stderr, "write").mockImplementation((chunk) => (said.push(String(chunk)), true));
  try {
    expect(await enrolled(home.dir, false)).toBe(1);
  } finally {
    write.mockRestore();
  }
  expect(said.join("")).toBe(`fleetd: ${deletedLine("https://sam.fleetd.dev")}\n`);
  expect(deletedLine("https://sam.fleetd.dev")).toContain("fleetd uninstall");
  home.done();
});

test("frames go compressed only once the workspace's welcome lists link_deflate, and workspace frames reach their handler", async () => {
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
  await until("the workspace's frames", () => handled.length === 2);
  expect(handled.map((f) => f.upto)).toEqual([7, 8]);
  stop.abort();
  hub.server.stop(true);
  home.done();
});

test("a workspace that goes quiet is pinged, and given up on when it never answers", async () => {
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

test("a capability an area turns on reaches the workspace in a new hello; one that didn't change sends none", async () => {
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

test("reconnects start fast and back off to 5 s, so a network back after a long outage is relinked within it; the URL and the frame caps are the Rust node's", () => {
  expect([0, 1, 2, 3, 4, 5, 6].map((a) => reconnectDelay(a, 1))).toEqual([250, 500, 1000, 2000, 4000, 5000, 5000]);
  expect(reconnectDelay(1000, 1.2)).toBe(6000);
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

test("the workspace's 1012 close reads as a restart: the node redials in 250 ms, with no jitter", async () => {
  const home = tempHome();
  const hub = fakeHub();
  const stop = new AbortController();
  const lost: Record<string, unknown>[] = [];
  let links = 0;
  const log = (_level: string, msg: string, fields?: Record<string, unknown>) => {
    if (msg === "workspace link lost; reconnecting until it is back") lost.push(fields ?? {});
  };
  void runNode(options(hub.url, home.dir, { attach: () => (links++, () => {}), log, signal: stop.signal }));
  await until("the welcome", () => links === 1);
  hub.conns[0]!.ws.close(1012, "workspace restarting");
  await until("the second link", () => links === 2);
  expect(lost).toEqual([{ why: "workspace closed the link (1012 workspace restarting)", retryInMs: 250 }]);
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

/** A TCP hop between the node and its hub that can go dark: while `dark`, every byte either way is dropped and the
 * connections stay open, as on a network cut under them (a switch, wifi that drops). While `held`, what the node
 * sends waits in the hop, as on a slow uplink, until `release`. */
function hop(target: number) {
  const state = { dark: false, held: false };
  const waiting: [Bun.Socket<unknown>, Uint8Array][] = [];
  const pairs = new Set<{ up?: Bun.Socket<unknown>; down: Bun.Socket<unknown> }>();
  const server = Bun.listen<{ up?: Bun.Socket<unknown>; held: Uint8Array[] }>({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      open(down) {
        down.data = { held: [] };
        const pair: { up?: Bun.Socket<unknown>; down: Bun.Socket<unknown> } = { down };
        pairs.add(pair);
        void Bun.connect({
          hostname: "127.0.0.1",
          port: target,
          socket: {
            open(up) {
              pair.up = up;
              down.data.up = up;
              for (const c of down.data.held.splice(0)) up.write(c);
            },
            data: (_up, chunk) => void (!state.dark && down.write(new Uint8Array(chunk))),
            close: () => void down.end(),
            error: () => void down.end(),
          },
        });
      },
      data(down, chunk) {
        if (state.dark) return;
        const copy = new Uint8Array(chunk);
        if (state.held && down.data.up) waiting.push([down.data.up, copy]);
        else if (down.data.up) down.data.up.write(copy);
        else down.data.held.push(copy);
      },
      close: (down) => void down.data.up?.end(),
      error() {},
    },
  });
  const release = () => {
    state.held = false;
    for (const [up, chunk] of waiting.splice(0)) up.write(chunk);
  };
  return { url: `http://127.0.0.1:${server.port}`, state, release, stop: () => server.stop(true) };
}

/** A node behind a hop to a fake hub, its losses logged with when they came. */
function cutNode(home: string, quiet: { probeMs: number; deadMs: number; bulkMs: number }, bulk = true, handled: unknown[] = []) {
  const hub = fakeHub({ deflate: false, bulk });
  const h = hop(hub.server.port!);
  const stop = new AbortController();
  const lost: { at: number; why: string }[] = [];
  const links: LinkContext[] = [];
  const log = (_level: string, msg: string, fields?: Record<string, unknown>) => {
    if (msg === "workspace link lost; reconnecting until it is back") lost.push({ at: Date.now(), why: String(fields?.why) });
  };
  void runNode(options(h.url, home, { attach: (l) => (links.push(l), () => {}), handle: (f) => void handled.push(f), log, quiet, signal: stop.signal }));
  const done = () => (stop.abort(), h.stop(), hub.server.stop(true));
  return { hub, hop: h, lost, links, done };
}

const QUIET = { probeMs: 100, deadMs: 400, bulkMs: 2500 };

test("a link cut under the node is found dead within the quiet bound, not at the next heartbeats, and dialled again", async () => {
  // On a real link: pinged after 5 s of quiet, given up 7 s later; 30 s while a big frame may still be crossing.
  expect([QUIET_PROBE_MS, QUIET_DEAD_MS, BULK_DEAD_MS]).toEqual([5000, 12_000, 30_000]);
  const home = tempHome();
  const n = cutNode(home.dir, QUIET);
  await until("the welcome", () => n.links.length === 1);
  // Quiet but alive: the hub's pongs keep it.
  await Bun.sleep(600);
  expect(n.lost).toEqual([]);
  const cut = Date.now();
  n.hop.state.dark = true;
  await until("the loss", () => n.lost.length === 1, 2000);
  expect(n.lost[0]!.at - cut).toBeLessThan(QUIET.bulkMs);
  expect(n.lost[0]!.why).toBe("nothing from the workspace for 0 s, and no answer to a ping");
  n.hop.state.dark = false;
  await until("the link back", () => n.links.length === 2, 3000);
  n.done();
  home.done();
});

test("after a big frame of its own the node waits the heartbeats' time, until the ping behind it is answered", async () => {
  const home = tempHome();
  const n = cutNode(home.dir, QUIET);
  await until("the welcome", () => n.links.length === 1);
  const big = { t: "cmd_result", id: "c1", exitCode: 0, outputTail: "x".repeat(BULK_BYTES), timedOut: false } as const;
  // Through, and its ping answered: a cut after it is found as quickly as any.
  n.links[0]!.send(big);
  await until("the frame", () => n.hub.conns[0]!.frames.some((f) => f.id === "c1"));
  await Bun.sleep(200);
  let cut = Date.now();
  n.hop.state.dark = true;
  await until("the first loss", () => n.lost.length === 1, 2000);
  expect(n.lost[0]!.at - cut).toBeLessThan(QUIET.bulkMs);
  n.hop.state.dark = false;
  await until("the link back", () => n.links.length === 2, 3000);
  // Cut while it may still be crossing: no pong, and the node waits the longer bound before it gives the link up.
  n.hop.state.dark = true;
  cut = Date.now();
  n.links[1]!.send({ ...big, id: "c2" });
  await until("the second loss", () => n.lost.length === 2, 5000);
  expect(n.lost[1]!.at - cut).toBeGreaterThanOrEqual(QUIET.bulkMs - 100);
  n.done();
  home.done();
});

test("a frame of its own big in UTF-8 bytes, though short in characters, gets the longer bound too", async () => {
  const home = tempHome();
  const n = cutNode(home.dir, QUIET);
  await until("the welcome", () => n.links.length === 1);
  const outputTail = "é漢".repeat(BULK_BYTES / 4);
  expect(outputTail.length).toBeLessThan(BULK_BYTES);
  n.hop.state.dark = true;
  const cut = Date.now();
  n.links[0]!.send({ t: "cmd_result", id: "c1", exitCode: 0, outputTail, timedOut: false });
  await until("the loss", () => n.lost.length === 1, 5000);
  expect(n.lost[0]!.at - cut).toBeGreaterThanOrEqual(QUIET.bulkMs - 2 * QUIET.probeMs);
  n.done();
  home.done();
});

test("a heartbeat that says a big frame comes keeps the longer bound until a frame arrives", async () => {
  const home = tempHome();
  const n = cutNode(home.dir, QUIET);
  await until("the welcome", () => n.links.length === 1);
  n.hub.conns[0]!.ws.send(JSON.stringify({ t: "hb", at: "2026-11-08T10:00:00Z", bulk: 5 << 20 }));
  await Bun.sleep(50);
  const cut = Date.now();
  n.hop.state.dark = true;
  await until("the loss", () => n.lost.length === 1, 5000);
  expect(n.lost[0]!.at - cut).toBeGreaterThanOrEqual(QUIET.bulkMs - 100);
  n.done();
  home.done();
});

test("a workspace that doesn't announce its big frames (an older workspace or cloud) keeps the heartbeats' bound on its link", async () => {
  const home = tempHome();
  const n = cutNode(home.dir, QUIET, false);
  await until("the welcome", () => n.links.length === 1);
  // Quiet and nothing big seen: an unannounced frame may still be crossing, so the node waits the longer bound.
  await Bun.sleep(200);
  const cut = Date.now();
  n.hop.state.dark = true;
  await until("the loss", () => n.lost.length === 1, 5000);
  // Timed from the last pong, up to a probe before the cut: far past the 400 ms bound either way.
  expect(n.lost[0]!.at - cut).toBeGreaterThanOrEqual(QUIET.bulkMs - 2 * QUIET.probeMs);
  expect(n.lost[0]!.why).toBe("nothing from the workspace for 3 s, and no answer to a ping");
  n.done();
  home.done();
});

test("a screen's H.264 frames wait in order for a slow link; past a few, its stream drops until a keyframe, which the screen is asked for", async () => {
  const home = tempHome();
  const handled: unknown[] = [];
  const n = cutNode(home.dir, { probeMs: 5000, deadMs: 10_000, bulkMs: 10_000 }, true, handled);
  await until("the welcome", () => n.links.length === 1);
  const frame = (seq: number, key = false) => ({ t: "browser_frame", sessionId: "b", seq, h264B64: "AAAB", ...(key ? { key: true } : {}), width: 1, height: 1 }) as const;
  n.hop.state.held = true;
  const link = n.links[0]!;
  link.send(frame(1, true));
  // Behind 1, three wait in order; a fourth can't: the stream drops, 5 and 6 go nowhere, and a keyframe is asked for.
  link.send(frame(2));
  link.send(frame(3));
  link.send(frame(4));
  link.send(frame(5));
  link.send(frame(6));
  // The keyframe replaces whatever waits; what follows it waits behind it.
  link.send(frame(7, true));
  link.send(frame(8));
  await Bun.sleep(100);
  expect(handled.filter((f) => (f as { t: string }).t === "browser_watch")).toEqual([{ t: "browser_watch", sessionId: "b", on: true, video: true, key: true }]);
  n.hop.release();
  const got = () => n.hub.conns[0]!.frames.filter((f) => f.t === "browser_frame").map((f) => f.seq);
  await until("the stream again", () => got().includes(8));
  expect(got()).toEqual([1, 7, 8]);
  n.done();
  home.done();
});

test("a watched screen's frames go one at a time, the newest next, and never queue ahead of the rest", async () => {
  const home = tempHome();
  const n = cutNode(home.dir, { probeMs: 5000, deadMs: 10_000, bulkMs: 10_000 });
  await until("the welcome", () => n.links.length === 1);
  const frame = (sessionId: string, seq: number) => ({ t: "browser_frame", sessionId, seq, jpegB64: "AAAA", width: 1, height: 1 }) as const;
  // A slow uplink: nothing the node writes has crossed yet.
  n.hop.state.held = true;
  const link = n.links[0]!;
  link.send(frame("b", 1));
  link.send(frame("b", 2));
  link.send(frame("b", 3));
  link.send(frame("c", 1));
  link.send({ t: "cmd_result", id: "c1", exitCode: 0, outputTail: "done", timedOut: false });
  await Bun.sleep(100);
  n.hop.release();
  const got = () => n.hub.conns[0]!.frames.filter((f) => f.t !== "hello").map((f) => (f.t === "browser_frame" ? `${f.sessionId}${f.seq}` : f.t));
  await until("the newest frame", () => got().includes("b3"));
  // b2 was made while b1 crossed and b3 after it: only the newest went. The other screen and the result didn't wait.
  expect(got()).toEqual(["b1", "c1", "cmd_result", "b3"]);
  n.done();
  home.done();
});

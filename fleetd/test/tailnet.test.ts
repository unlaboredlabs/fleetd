// The team's Tailscale gateway on the hub (src/hub/tailnet) against a stand-in Tailscale (tailnet_standin.ts): Connect
// gives Tailscale's sign-in page and nothing pasted, an approval connects it, its login state is kept only sealed, a
// node's signed dials and lookups go through it (and nobody else's), the machines that make hosted boxes hear whether
// it's on, a restart brings it back from its sealed state, and Disconnect logs it out and forgets it. A gateway on
// another host (a cloud's) is called again until the call lands on it.
import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { connect, createServer, type Server } from "node:net";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { serve, stop } from "../src/hub/http/index.ts";
import { type Gateway, NotHere, Off } from "../src/hub/tailnet/gateway.ts";
import { sqliteStore } from "../src/hub/tailnet/index.ts";
import { start as startTailnet } from "../src/hub/tailnet/loops.ts";
import { LocalGateway, runDirFor } from "../src/hub/tailnet/local.ts";
import { programs, TAILSCALE, unsupported } from "../src/hub/tailnet/tailscale.ts";
import { loadOrCreateIdentity } from "../src/node/identity.ts";
import { NodeTailnet } from "../src/node/sandbox/tailnet.ts";
import { CAP_SANDBOX } from "../src/shared/sandbox.ts";
import { DIAL_PATH, signedMessage } from "../src/shared/tailnet.ts";
import { addMachine, caller, testHub } from "./screens_helpers.ts";
import { LOGIN_URL, SELF_IPS, standInPrograms } from "./tailnet_standin.ts";

const root = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "fleetd-tailnet-"));
const servers: Server[] = [];
afterAll(() => {
  for (const s of servers) s.close();
  rmSync(root, { recursive: true, force: true });
});

const admin = caller("admin", { kind: "human", name: "ana" });
const member = caller("read", { kind: "human", name: "ben" });

let t: ReturnType<typeof testHub>;
let dir: string;
let marks: string;
let gw: LocalGateway;
let made = 0;

/** A gateway on the stand-in, in a run dir of the test's own. */
function gateway(): LocalGateway {
  return new LocalGateway({ home: dir, store: sqliteStore(t.hub), programs: async () => standInPrograms(dir, marks), runDir: join(dir, "run"), waitMs: 20, everyMs: 50 });
}

/** The hub's gateway from now on: the area set again (a hub sets it once; a test swaps it). */
const use = (g: Gateway) => (t.hub as unknown as { areas: Map<string, unknown> }).areas.set("tailnet", g);

beforeEach(() => {
  dir = join(root, `t${++made}`);
  marks = join(dir, "marks");
  mkdirSync(marks, { recursive: true });
  t = testHub();
  gw = gateway();
  use(gw);
});
afterEach(async () => {
  await gw.stop();
  t.done();
});

async function call(who: typeof admin, tool: string, input: Record<string, unknown> = {}): Promise<any> {
  const r = await t.tools.call(t.hub, who, tool, input);
  if ("output" in r) return r.output;
  throw new Error(r.error.kind === "tool" ? r.error.error.message : r.error.kind);
}

const until = async (what: string, ok: () => boolean, ms = 5_000) => {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error(`timed out: ${what}`);
    await Bun.sleep(10);
  }
};

/** What Tailscale does once the person approves the device: the gateway's state says it's logged in. */
const approve = () => writeFileSync(join(dir, "run", "tailscaled.state"), "approved: node key");

/** A node's clock: the hub's (a test's own, never today's). */
const clock = () => ({ now: () => t.hub.clock.now() });

const sealedRow = () => t.hub.db.conn.query<{ sealed: Uint8Array }, []>("SELECT sealed FROM tailnet_gateway").get()?.sealed;

async function echoServer(): Promise<number> {
  const s = createServer((c) => c.pipe(c));
  servers.push(s);
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", () => r()));
  return (s.address() as { port: number }).port;
}

test("Connect gives Tailscale's sign-in page, with no key; approved, it's connected, and its state is kept sealed", async () => {
  expect(await call(member, "tailnet_get")).toEqual({ status: "off" });
  await expect(call(member, "tailnet_connect")).rejects.toThrow();
  expect(await call(admin, "tailnet_connect")).toEqual({ status: "login", loginUrl: LOGIN_URL });
  // `up` with no key, as a device of its own name, shields up: nothing on the tailnet reaches the hub's machine.
  const up = JSON.parse(await Bun.file(join(marks, "up-args")).text()) as string[];
  expect(up).toContain("--hostname=fleetd");
  expect(up).toContain("--shields-up");
  expect(up.some((a) => /auth-?key/u.test(a))).toBe(false);
  // A second Connect while it waits gives the same page, and starts nothing more.
  expect(await call(admin, "tailnet_connect")).toEqual({ status: "login", loginUrl: LOGIN_URL });
  approve();
  await until("connected", () => gw.state().status === "connected");
  expect(await call(member, "tailnet_get")).toEqual({ status: "connected", tailnet: "example.com", device: "fleetd" });
  expect(gw.suffix()).toBe("tail1234.ts.net");
  // Sealed in the hub's database, never as it is.
  await until("sealed", () => sealedRow() !== undefined);
  expect(Buffer.from(sealedRow()!).includes(Buffer.from("approved"))).toBe(false);
  expect(Buffer.from((await sqliteStore(t.hub).load())!).toString()).toBe("approved: node key");
});

test("a node's signed dials and lookups go through the gateway, and no one else's", async () => {
  await call(admin, "tailnet_connect");
  approve();
  await until("connected", () => gw.state().status === "connected");
  const server = serve(t.hub, t.tools, 0);
  try {
    const hub = `http://127.0.0.1:${server.port}`;
    const nodeHome = join(dir, "node");
    mkdirSync(nodeHome, { recursive: true });
    const identity = loadOrCreateIdentity(nodeHome);
    const code = t.hub.auth.nodes.createEnrollToken("devbox", "devbox").token;
    t.hub.auth.nodes.enrollNode(code, "devbox", identity.pubKey());
    const node = new NodeTailnet(hub, "devbox", identity, clock());
    // Off at the node until the hub says so: nothing is asked.
    await expect(node.dial("100.104.249.49", 1)).rejects.toThrow("no Tailscale connection");
    node.set({ suffix: "tail1234.ts.net" });
    expect(node.suffix).toBe("tail1234.ts.net");

    const echo = await echoServer();
    const conn = await node.dial("100.104.249.49", echo);
    const back = new Promise<string>((r) => conn.once("data", (d: Buffer) => r(d.toString())));
    conn.write("over the tailnet");
    expect(await back).toBe("over the tailnet");
    conn.destroy();
    await expect(node.dial("100.64.0.9", 22)).rejects.toThrow("connection refused");
    // A peer by name, and by its IPv6 address as a box's capture writes it out in full.
    for (const host of ["devbox.tail1234.ts.net", "fd7a:115c:a1e0:0:0:0:0:1"]) {
      const c = await node.dial(host, echo);
      const got = new Promise<string>((r) => c.once("data", (d: Buffer) => r(d.toString())));
      c.write(host);
      expect(await got).toBe(host);
      c.destroy();
    }
    // Never the gateway itself (userspace tailscaled hands its own address to the hub machine's loopback, where the
    // echo listens here), nor an address or name no peer has (tailscaled would dial that on the host's network).
    for (const host of [...SELF_IPS, "fd7a:115c:a1e0:0:0:0:0:70", "fleetd.tail1234.ts.net", "100.99.0.1", "ghost.tail1234.ts.net"])
      await expect(node.dial(host, echo)).rejects.toThrow("isn't a device on the tailnet the gateway reaches");
    expect(Buffer.from(await node.dns("devbox.tail1234.ts.net", 28)).toString()).toBe("devbox.tail1234.ts.net./AAAA");

    // Unsigned, signed by a key the hub didn't enroll, too old, or replayed: refused before the gateway.
    const plain = await fetch(`${hub}/node/tailnet/dns?name=x.ts.net&type=1`);
    expect(plain.status).toBe(401);
    const other = loadOrCreateIdentity(join(dir, "other"));
    const forged = new NodeTailnet(hub, "devbox", other, clock());
    forged.set({ suffix: "" });
    await expect(forged.dns("x.ts.net", 1)).rejects.toThrow("the signature doesn't verify");
    const stale = new NodeTailnet(hub, "devbox", identity, { now: () => t.hub.clock.now() - 10 * 60_000 });
    stale.set({ suffix: "" });
    await expect(stale.dns("x.ts.net", 1)).rejects.toThrow("too far from the hub's");
    const at = t.hub.clock.now();
    const headers = { "x-fleetd-machine": "devbox", "x-fleetd-at": String(at), "x-fleetd-nonce": "n".repeat(24), "x-fleetd-sig": identity.signTailnet(signedMessage("devbox", at, "n".repeat(24), "dns", "x.ts.net/1")) };
    expect((await fetch(`${hub}/node/tailnet/dns?name=x.ts.net&type=1`, { headers })).status).toBe(200);
    expect((await fetch(`${hub}/node/tailnet/dns?name=x.ts.net&type=1`, { headers })).status).toBe(401);
    // A dial's signature names its target: one for another target doesn't open it.
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}${DIAL_PATH}?host=100.104.249.49&port=22`, {
      headers: { ...headers, "x-fleetd-nonce": "m".repeat(24) },
    } as unknown as string[]);
    expect(await new Promise((r) => ((ws.onopen = () => r("open")), (ws.onerror = () => r("refused"))))).toBe("refused");
    // Only the tailnet: never the hub's own loopback or LAN, nor the internet, which tailscaled would dial itself.
    await expect(node.dial("127.0.0.1", echo)).rejects.toThrow("the hub refused the dial");
    for (const host of ["127.0.0.1", "localhost", "10.0.0.5", "github.com"]) {
      const at2 = t.hub.clock.now();
      const n2 = `${host.replace(/\W/gu, "")}${"q".repeat(20)}`;
      const h = { "x-fleetd-machine": "devbox", "x-fleetd-at": String(at2), "x-fleetd-nonce": n2, "x-fleetd-sig": identity.signTailnet(signedMessage("devbox", at2, n2, "dial", `${host}:${echo}`)) };
      expect((await fetch(`${hub}${DIAL_PATH}?host=${host}&port=${echo}`, { headers: h })).status).toBe(403);
    }
    await expect(node.dns("github.com", 1)).rejects.toThrow("isn't a name on the tailnet");
    // The node's identity key signs a tailnet call and nothing else; the hub's challenge can't be one.
    expect(() => identity.signTailnet("hello")).toThrow();
    expect(() => identity.sign(signedMessage("devbox", at, "x", "dns", "y"))).toThrow();

    // Disconnected: the gateway is off, and what was asked is refused at once.
    await call(admin, "tailnet_disconnect");
    await expect(node.dns("x.ts.net", 1)).rejects.toThrow("no Tailscale connection");
    await expect(node.dial("100.104.249.49", echo)).rejects.toThrow("no Tailscale connection");
  } finally {
    await stop(server);
  }
}, 30_000);

test("the machines that make hosted boxes hear whether it's on, with its suffix, as they link and on every change", async () => {
  const told: { m: string; tailnet: unknown }[] = [];
  t.link.answer = async (m, f) => {
    const frame = f as unknown as { action?: string; tailnet?: unknown };
    if (frame.action === "tailnet") told.push({ m, tailnet: frame.tailnet });
    return { ok: true };
  };
  startTailnet(t.hub);
  addMachine(t.hub, "devbox");
  addMachine(t.hub, "mac");
  t.link.link("devbox", [CAP_SANDBOX]);
  t.link.link("mac", []);
  await until("told at link", () => told.length === 1);
  expect(told).toEqual([{ m: "devbox", tailnet: null }]);
  await call(admin, "tailnet_connect");
  approve();
  await until("told it's on", () => told.length === 2);
  expect(told[1]).toEqual({ m: "devbox", tailnet: { suffix: "tail1234.ts.net" } });
  await call(admin, "tailnet_disconnect");
  await until("told it's off", () => told.length === 3);
  expect(told[2]).toEqual({ m: "devbox", tailnet: null });
});

test("a restart brings it back from its sealed state; Disconnect logs it out and forgets it, sealed and in its run dir", async () => {
  await call(admin, "tailnet_connect");
  approve();
  await until("connected", () => gw.state().status === "connected");
  await until("sealed", () => sealedRow() !== undefined);
  // The hub stops: tailscaled ends and its run dir goes, the sealed state stays.
  await gw.stop();
  expect(existsSync(join(dir, "run"))).toBe(false);
  expect(sealedRow()).toBeDefined();
  gw = gateway();
  use(gw);
  expect(gw.state().status).toBe("off");
  await gw.start();
  await until("back", () => gw.state().status === "connected");
  expect(readdirSync(join(dir, "run"))).toContain("tailscaled.state");

  expect(await call(admin, "tailnet_disconnect")).toEqual({ status: "off" });
  expect(existsSync(join(marks, "logged-out"))).toBe(true);
  expect(sealedRow()).toBeUndefined();
  expect(existsSync(join(dir, "run"))).toBe(false);
  await expect(gw.dial("100.104.249.49", 1)).rejects.toBeInstanceOf(Off);
  // Started again with nothing sealed: off, and nothing runs.
  await gw.start();
  expect(gw.state().status).toBe("off");
  expect(existsSync(join(dir, "run"))).toBe(false);
});

test("a hub that can't run it says why, and Connect is refused in those words", async () => {
  expect(unsupported("darwin", "arm64")).toBe("Tailscale's gateway runs on Linux hubs, and this hub runs on darwin (arm64)");
  expect(unsupported("linux", "x64")).toBeUndefined();
  expect(unsupported("linux", "arm64")).toBeUndefined();
  gw = new LocalGateway({ home: dir, store: sqliteStore(t.hub), programs: async () => standInPrograms(dir, marks), runDir: join(dir, "run"), unsupported: unsupported("darwin", "arm64") });
  use(gw);
  expect(await call(member, "tailnet_get")).toEqual({ status: "off", problem: "Tailscale's gateway runs on Linux hubs, and this hub runs on darwin (arm64)" });
  await expect(call(admin, "tailnet_connect")).rejects.toThrow("runs on Linux hubs");
});

test("its programs are Tailscale's pinned build, refused when the download doesn't match its checksum", async () => {
  const fake = (async () => new Response("not tailscale")) as unknown as typeof fetch;
  await expect(programs(join(dir, "ts"), fake, "x64")).rejects.toThrow("didn't match its checksum");
  expect(existsSync(join(dir, "ts", TAILSCALE.version))).toBe(false);
  // Fetched once: what is there is used.
  mkdirSync(join(dir, "ts", TAILSCALE.version), { recursive: true });
  for (const p of ["tailscale", "tailscaled"]) writeFileSync(join(dir, "ts", TAILSCALE.version, p), "");
  const never = (async () => {
    throw new Error("fetched again");
  }) as unknown as typeof fetch;
  expect(await programs(join(dir, "ts"), never, "x64")).toEqual({ tailscale: join(dir, "ts", TAILSCALE.version, "tailscale"), tailscaled: join(dir, "ts", TAILSCALE.version, "tailscaled") });
  // Its run dir is on a RAM-backed filesystem where there is one.
  expect(runDirFor("/srv/hub", { XDG_RUNTIME_DIR: dir })).toStartWith(join(dir, "fleetd-tailnet-"));
  expect(runDirFor("/srv/hub", { XDG_RUNTIME_DIR: join(dir, "missing") })).not.toStartWith(join(dir, "missing"));
});

test("a gateway on another host (a cloud's): the node calls again until its call lands on the one that holds it", async () => {
  const echo = await echoServer();
  let misses = 0;
  const cloud: Gateway = {
    state: () => ({ status: "connected" }),
    connect: async () => ({ status: "connected" }),
    disconnect: async () => ({ status: "off" }),
    suffix: () => "tail1234.ts.net",
    onChange: () => () => {},
    stop: async () => {},
    async dial(_h, port) {
      if (misses++ < 2) throw new NotHere();
      return connect({ host: "127.0.0.1", port });
    },
    async dns(name) {
      if (misses++ < 4) throw new NotHere();
      return new Uint8Array(Buffer.from(name));
    },
  };
  use(cloud);
  const server = serve(t.hub, t.tools, 0);
  try {
    const identity = loadOrCreateIdentity(join(dir, "node2"));
    t.hub.auth.nodes.enrollNode(t.hub.auth.nodes.createEnrollToken("devbox", "devbox").token, "devbox", identity.pubKey());
    const node = new NodeTailnet(`http://127.0.0.1:${server.port}`, "devbox", identity, clock());
    node.set({ suffix: "tail1234.ts.net" });
    const conn = await node.dial("100.104.249.49", echo);
    const back = new Promise<string>((r) => conn.once("data", (d: Buffer) => r(d.toString())));
    conn.write("found it");
    expect(await back).toBe("found it");
    conn.destroy();
    expect(Buffer.from(await node.dns("devbox.tail1234.ts.net", 1)).toString()).toBe("devbox.tail1234.ts.net");
    expect(misses).toBe(5);
  } finally {
    await stop(server);
  }
});

test("a dial's bytes keep their order both ways through the hub", async () => {
  await call(admin, "tailnet_connect");
  approve();
  await until("connected", () => gw.state().status === "connected");
  const server = serve(t.hub, t.tools, 0);
  try {
    const identity = loadOrCreateIdentity(join(dir, "node3"));
    t.hub.auth.nodes.enrollNode(t.hub.auth.nodes.createEnrollToken("devbox", "devbox").token, "devbox", identity.pubKey());
    const node = new NodeTailnet(`http://127.0.0.1:${server.port}`, "devbox", identity, clock());
    node.set({ suffix: "" });
    const conn = await node.dial("100.104.249.49", await echoServer());
    const sink = new PassThrough();
    const got: Buffer[] = [];
    conn.on("data", (d: Buffer) => got.push(d));
    const big = Buffer.alloc(3 << 20);
    for (let i = 0; i < big.length; i++) big[i] = i % 251;
    conn.write(big);
    await until("all back", () => got.reduce((n, b) => n + b.length, 0) >= big.length, 15_000);
    expect(Buffer.concat(got).equals(big)).toBe(true);
    conn.destroy();
    sink.destroy();
  } finally {
    await stop(server);
  }
}, 30_000);

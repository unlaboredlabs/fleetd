// A box's one link (src/node/sandbox/): the node's Box against a stand-in box, a child process running
// `fleetd sandbox-guest` on a unix socket, so it runs without KVM. The session host's lines through it (dropped and
// dialled again, nothing lost), node.sock calls that act as the box's session and no other, TCP forwards with
// backpressure, many channels at once, and a guest that goes away. One test plays the guest itself, as a box that
// tries channels it shouldn't.
import { afterAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { connect, createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import { Duplex } from "node:stream";
import { sendToNode } from "../../src/cli/agent_mcp/socket.ts";
import { LeadRelay, type LeadSocketHooks } from "../../src/node/lead/index.ts";
import { Masker } from "../../src/node/mask.ts";
import type { NodeFrame } from "../../src/node/wire.ts";
import { HostLink, marker, PROTOCOL, shutdown, stop, type RunnerEvent } from "../../src/node/runner/host.ts";
import { Box } from "../../src/node/sandbox/box.ts";
import { GUEST_PROTOCOL } from "../../src/node/sandbox/guest.ts";
import { HOST, Mux, type Target } from "../../src/node/sandbox/mux.ts";

const MAIN = join(import.meta.dir, "../../src/main.ts");
const root = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "fleetd-box-"));
const guests: { proc: Bun.Subprocess; dir: string }[] = [];
const servers: Server[] = [];
afterAll(async () => {
  for (const g of guests) {
    g.proc.kill("SIGKILL");
    // The stand-in's session hosts are processes of this machine: stop them by what they registered.
    const hosts = join(g.dir, "hosts");
    if (existsSync(hosts)) for (const name of readdirSync(hosts)) await stop(join(hosts, name));
  }
  for (const s of servers) s.close();
  rmSync(root, { recursive: true, force: true });
});

/** Says m1..m3, waits for a line on the FIFO `$1`, says m4..m6, then runs until its stdin closes. */
const TALKING_CLAUDE = `#!/bin/sh
init() { echo "{\\"type\\":\\"system\\",\\"subtype\\":\\"init\\",\\"claude_code_version\\":\\"2.1.302\\",\\"model\\":\\"m$1\\",\\"cwd\\":\\"/fake\\"}"; }
init 1; init 2; init 3
read go < "$1"
init 4; init 5; init 6
exec cat > /dev/null
`;

const within = <T>(p: Promise<T>, ms: number, what: string): Promise<T> =>
  Promise.race([p, Bun.sleep(ms).then(() => Promise.reject(new Error(`timed out: ${what}`)))]);

let made = 0;
/** A stand-in box: `fleetd sandbox-guest` in a dir of its own, its TCP forwards on 127.0.0.2 beside this node's
 * 127.0.0.1. `dial` connects to it once `gate` lets it; `links` are the streams it gave. */
async function standIn() {
  const dir = join(root, `b${++made}`);
  mkdirSync(dir);
  const sock = join(dir, "link.sock");
  const proc = Bun.spawn([process.execPath, MAIN, "sandbox-guest", "--listen", sock, "--dir", join(dir, "hosts"), "--loopback", "127.0.0.2"], {
    stdio: ["ignore", "ignore", "inherit"],
  });
  guests.push({ proc, dir });
  for (let i = 0; !existsSync(sock); i++) {
    if (i > 500) throw new Error("the guest didn't listen");
    await Bun.sleep(10);
  }
  const links: Socket[] = [];
  let gate: Promise<void> = Promise.resolve();
  const dial = async (): Promise<Duplex> => {
    await gate;
    return new Promise((resolve, reject) => {
      const s = connect(sock);
      s.once("connect", () => (links.push(s), resolve(s))).once("error", reject);
    });
  };
  return {
    dir,
    proc,
    nodeSock: join(dir, "node.sock"),
    dial,
    links,
    /** The current link swallows what the node writes to it from now on, as one that is dying. */
    blackhole(): void {
      const s = links.at(-1)!;
      s.write = ((_chunk: unknown, ...rest: unknown[]) => {
        const cb = rest.find((r) => typeof r === "function") as (() => void) | undefined;
        cb?.();
        return true;
      }) as typeof s.write;
    },
    /** Drops the current link and holds re-dials until the returned function is called. */
    drop(): () => void {
      let open!: () => void;
      gate = new Promise((r) => (open = r));
      links.at(-1)!.destroy();
      return open;
    },
  };
}

/** Hooks whose hub answers each call with the session it was made as. */
function leadHooks(): LeadSocketHooks {
  const relay = new LeadRelay();
  relay.attach((frame: NodeFrame) => {
    const f = frame as unknown as { id: string; threadId?: string; call: { op: string } };
    queueMicrotask(() => relay.resolve({ id: f.id, result: { op: f.call.op, as: f.threadId ?? null } }));
  }, []);
  return {
    relay,
    identify: () => ({ kind: "outside" }),
    maskFor: () => new Masker(),
    browser: async (session, frame) => ({ id: frame.id, result: { op: "browser", as: session } }),
  };
}

const call = (sock: string, op: string, threadId?: string) =>
  sendToNode(sock, { t: "lead_call", id: "c1", cwd: "/", call: { op }, ...(threadId ? { threadId } : {}) }, 5_000, 0);

async function program(name: string, script: string): Promise<string> {
  const path = join(root, name);
  writeFileSync(path, script);
  chmodSync(path, 0o755);
  return path;
}

/** Says m0, then one init per line on its stdin: r1, r2, … */
const ECHO_CLAUDE = `#!/bin/sh
init() { echo "{\\"type\\":\\"system\\",\\"subtype\\":\\"init\\",\\"claude_code_version\\":\\"2.1.302\\",\\"model\\":\\"$1\\",\\"cwd\\":\\"/fake\\"}"; }
init m0
n=0
while read line; do n=$((n+1)); init "r$n"; done
`;

/** Applies events as the session service does until `n` inits came; their models. */
async function applyInits(link: HostLink, n: number): Promise<string[]> {
  const models: string[] = [];
  while (models.length < n) {
    const event = (await within(link.next(), 10_000, "an event")) as Record<string, any> | undefined;
    expect(event).toBeDefined();
    if (typeof event === "object" && "Init" in event!) models.push(event.Init.model);
    link.applied++;
  }
  return models;
}

const boxRegistration = { protocol: PROTOCOL, hostPid: 0, pid: 0, marker: "", refused: null };

test("the session host's lines cross the box's link, and a link dropped and dialled again loses none", async () => {
  const b = await standIn();
  const box = await Box.open({ session: "s-lines", dial: b.dial, nodeSock: b.nodeSock, tcp: [], lead: leadHooks(), goneMs: 10_000 });
  const fifo = join(b.dir, "go");
  Bun.spawnSync(["mkfifo", fifo]);
  const claude = await program("claude-lines", TALKING_CLAUDE);
  const info = await box.start({ sessionId: "s-lines", program: claude, args: [fifo], cwd: b.dir, env: { ...process.env, FLEETD_RUNNER_SESSION: marker("box-test-lines") } });
  expect(info).toEqual({ protocol: PROTOCOL, refused: null });
  const link = await HostLink.connect("", { dial: (h) => box.dialHost(h), registration: boxRegistration });
  expect(await applyInits(link, 3)).toEqual(["m1", "m2", "m3"]);
  // The link drops; claude goes on talking while it is down; the next link carries what it said, once.
  const open = b.drop();
  await Bun.spawn(["sh", "-c", `echo go > '${fifo}'`]).exited;
  await Bun.sleep(300);
  open();
  expect(await applyInits(link, 3)).toEqual(["m4", "m5", "m6"]);
  expect(b.links.length).toBe(2);
  // The new link carries node.sock calls and commands too.
  expect(await call(b.nodeSock, "ping")).toMatchObject({ result: { op: "ping", as: "s-lines" } });
  link.send(shutdown());
  let exited = false;
  for (;;) {
    const event = await within(link.next(), 10_000, "the exit");
    if (event === undefined) break;
    if (typeof event === "object" && "Exited" in event) exited = true;
    link.applied++;
  }
  expect(exited).toBe(true);
  box.close();
  expect(await box.gone).toBe("the node let go of the box");
}, 30_000);

test("commands cross a dropped link once each: one a dying link swallowed, one sent while it was down", async () => {
  const b = await standIn();
  const box = await Box.open({ session: "s-cmd", dial: b.dial, nodeSock: b.nodeSock, tcp: [], lead: leadHooks(), goneMs: 10_000 });
  const claude = await program("claude-echo", ECHO_CLAUDE);
  await box.start({ sessionId: "s-cmd", program: claude, args: [], cwd: b.dir, env: { ...process.env, FLEETD_RUNNER_SESSION: marker("box-test-cmd") } });
  const link = await HostLink.connect("", { dial: (h) => box.dialHost(h), registration: boxRegistration });
  const send = (run: string) => link.send({ Send: { run_id: run, text: run, mode: "plain" } });
  expect(await applyInits(link, 1)).toEqual(["m0"]);
  send("run-1");
  expect(await applyInits(link, 1)).toEqual(["r1"]);
  await Bun.sleep(400);
  b.blackhole();
  send("run-2");
  await Bun.sleep(100);
  const open = b.drop();
  send("run-3");
  await Bun.sleep(200);
  open();
  expect(await applyInits(link, 2)).toEqual(["r2", "r3"]);
  // Nothing came twice: the next one is r4.
  send("run-4");
  expect(await applyInits(link, 1)).toEqual(["r4"]);
  box.close();
}, 30_000);

test("a call from a box acts as the box's session and no other", async () => {
  const [a, b] = [await standIn(), await standIn()];
  const hooks = leadHooks();
  const boxA = await Box.open({ session: "s-a", dial: a.dial, nodeSock: a.nodeSock, tcp: [], lead: hooks });
  const boxB = await Box.open({ session: "s-b", dial: b.dial, nodeSock: b.nodeSock, tcp: [], lead: hooks });
  expect(await call(a.nodeSock, "whoami")).toMatchObject({ result: { as: "s-a" } });
  expect(await call(b.nodeSock, "whoami")).toMatchObject({ result: { as: "s-b" } });
  // Naming another session is refused; naming its own is fine.
  expect(await call(a.nodeSock, "whoami", "s-b")).toMatchObject({ error: { code: "forbidden", message: "this call names session s-b but runs in session s-a" } });
  expect(await call(a.nodeSock, "whoami", "s-a")).toMatchObject({ result: { as: "s-a" } });
  // A browser call as another session, and holding the node's agents, are refused too.
  const browser = await sendToNode(a.nodeSock, { t: "browser_call", id: "b1", threadId: "s-b" }, 5_000, 0);
  expect(browser).toMatchObject({ t: "browser_result", error: { code: "forbidden" } });
  expect(await sendToNode(a.nodeSock, { t: "browser_call", id: "b2" }, 5_000, 0)).toMatchObject({ result: { as: "s-a" } });
  const hold = await sendToNode(a.nodeSock, { t: "hold" }, 5_000, 0);
  expect(hold).toMatchObject({ error: { message: "only a person's shell holds the node's agents, never a session" } });
  boxA.close();
  boxB.close();
}, 30_000);

/** A local end for a channel the test opens itself: what came in, and whether the other side ended it. */
function probe() {
  const got: Buffer[] = [];
  let ended!: () => void;
  const end = new Promise<void>((r) => (ended = r));
  const local = new Duplex({
    read() {},
    write(chunk: Buffer, _e, cb) {
      got.push(chunk);
      cb();
    },
    final(cb) {
      ended();
      cb();
    },
  });
  return { local, end, text: () => Buffer.concat(got).toString("utf8") };
}

test("a box opens channels to its node.sock and its forwards only, and none names a session", async () => {
  // The box here is the test itself, speaking the guest's side of the link.
  const dir = join(root, "rogue");
  mkdirSync(dir);
  const sock = join(dir, "link.sock");
  const nodeSock = join(dir, "node.sock");
  let mux!: Mux;
  const ready = new Promise<void>((resolve) => {
    const server = createServer((s) => {
      mux = new Mux(s, { control: (m) => mux.control({ id: m.id, ok: {} }), open: () => undefined, closed: () => {} });
      mux.control({ op: "hello", protocol: GUEST_PROTOCOL, host: null });
      resolve();
    });
    servers.push(server);
    server.listen(sock);
  });
  // A port on this machine the box wasn't given (the hub's, say), which must never see a connection from it.
  let reached = 0;
  const hub = createServer((s) => (reached++, s.destroy()));
  servers.push(hub);
  await new Promise<void>((r) => hub.listen(0, "127.0.0.1", r));
  const hubPort = (hub.address() as { port: number }).port;
  const box = await Box.open({
    session: "s-rogue",
    dial: () => new Promise((r) => { const s = connect(sock, () => r(s)); }),
    nodeSock,
    tcp: [],
    lead: leadHooks(),
  });
  await ready;
  const open = (channel: number, target: Target | Record<string, unknown>) => {
    const p = probe();
    mux.open(channel, target as Target, p.local);
    return p;
  };
  const toHub = open(2, { tcp: hubPort });
  const elsewhere = open(3, { unix: join(dir, "other.sock") });
  const asHost = open(HOST, { host: true });
  await within(Promise.all([toHub.end, elsewhere.end, asHost.end]), 5_000, "the refusals");
  // A channel to node.sock that claims another session is still the box's own.
  const claims = open(4, { unix: nodeSock, session: "s-other", box: "s-other" });
  claims.local.push(`${JSON.stringify({ t: "lead_call", id: "r1", cwd: "/", call: { op: "whoami" } })}\n`);
  await within(claims.end, 5_000, "the answer");
  expect(JSON.parse(claims.text())).toMatchObject({ t: "lead_result", id: "r1", result: { as: "s-rogue" } });
  expect(reached).toBe(0);
  box.close();
}, 30_000);

test.skipIf(process.platform !== "linux")("a TCP forward holds back a reader that doesn't read, and only its own channel", async () => {
  const total = 64 << 20;
  const chunk = Buffer.alloc(1 << 20);
  let written = 0;
  const sent = createHash("sha256");
  const source = createServer(async (s) => {
    for (let i = 0; written < total && !s.destroyed; i++) {
      chunk.fill(i % 251);
      sent.update(chunk);
      written += chunk.length;
      if (!s.write(Buffer.from(chunk))) await new Promise((r) => s.once("drain", r));
    }
    s.end();
  });
  servers.push(source);
  await new Promise<void>((r) => source.listen(0, "127.0.0.1", r));
  const port = (source.address() as { port: number }).port;
  const b = await standIn();
  const box = await Box.open({ session: "s-tcp", dial: b.dial, nodeSock: b.nodeSock, tcp: [port], lead: leadHooks() });
  // A reader in the box that doesn't read yet.
  const reader = connect({ host: "127.0.0.2", port });
  reader.pause();
  await new Promise((r) => reader.once("connect", r));
  await Bun.sleep(1_500);
  expect(written).toBeGreaterThan(0);
  expect(written).toBeLessThan(32 << 20);
  // The link still carries the box's other channels.
  expect(await call(b.nodeSock, "ping")).toMatchObject({ result: { as: "s-tcp" } });
  const got = createHash("sha256");
  let received = 0;
  reader.on("data", (c: Buffer) => (got.update(c), (received += c.length)));
  reader.resume();
  await within(new Promise((r) => reader.once("end", r)), 30_000, "all of it");
  expect(received).toBe(total);
  expect(got.digest("hex")).toBe(sent.digest("hex"));
  box.close();
}, 60_000);

test.skipIf(process.platform !== "linux")("many channels at once over one link", async () => {
  const echo = createServer((s) => s.pipe(s));
  servers.push(echo);
  await new Promise<void>((r) => echo.listen(0, "127.0.0.1", r));
  const port = (echo.address() as { port: number }).port;
  const b = await standIn();
  const box = await Box.open({ session: "s-many", dial: b.dial, nodeSock: b.nodeSock, tcp: [port], lead: leadHooks() });
  const echoOnce = (i: number) =>
    new Promise<boolean>((resolve, reject) => {
      const payload = Buffer.alloc(200 * 1024 + i, i % 256);
      const s = connect({ host: "127.0.0.2", port }, () => s.end(payload));
      const back: Buffer[] = [];
      s.on("data", (c: Buffer) => back.push(c));
      s.on("end", () => resolve(Buffer.concat(back).equals(payload)));
      s.on("error", reject);
    });
  const calls = Array.from({ length: 40 }, (_, i) => call(b.nodeSock, `op${i}`));
  const echoes = Array.from({ length: 20 }, (_, i) => echoOnce(i));
  const answers = await within(Promise.all(calls), 20_000, "the calls");
  answers.forEach((a, i) => expect(a).toMatchObject({ result: { op: `op${i}`, as: "s-many" } }));
  expect(await within(Promise.all(echoes), 20_000, "the echoes")).toEqual(Array(20).fill(true));
  box.close();
}, 60_000);

test("a guest that goes away ends the box, its session host's lines and its channels", async () => {
  const b = await standIn();
  const box = await Box.open({ session: "s-gone", dial: b.dial, nodeSock: b.nodeSock, tcp: [], lead: leadHooks(), goneMs: 500 });
  const fifo = join(b.dir, "go");
  Bun.spawnSync(["mkfifo", fifo]);
  const claude = await program("claude-gone", TALKING_CLAUDE);
  await box.start({ sessionId: "s-gone", program: claude, args: [fifo], cwd: b.dir, env: { ...process.env, FLEETD_RUNNER_SESSION: marker("box-test-gone") } });
  const link = await HostLink.connect("", { dial: (h) => box.dialHost(h), registration: boxRegistration });
  expect(await applyInits(link, 3)).toEqual(["m1", "m2", "m3"]);
  b.proc.kill("SIGKILL");
  expect(await within(box.gone, 10_000, "the box gone")).toStartWith("the box's guest is gone");
  let event: RunnerEvent | undefined;
  while ((event = await within(link.next(), 5_000, "the lines' end")) !== undefined) link.applied++;
  await expect(box.dialHost({ data() {}, drain() {}, close() {}, error() {} })).rejects.toThrow("the box is gone");
}, 30_000);

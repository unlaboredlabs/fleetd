// A shared dev server outlives the agent that shared it (decision product.share-link-outlives-agent): the workspace
// tells the machine which ports agents' open links keep (`share_kept`), the node finds each one's process group, every
// sweep that ends a session's processes spares it, and the link still serves, HTTP and hot reload, once the agent has
// ended. Revoking or letting the link expire stops the server; a process the session didn't start is never kept or
// stopped. The dev server is a real process here, in a group of its own and carrying the session's marker, as a
// background server an agent's Bash starts is.
import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import type { Server } from "bun";
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ShareLink, ShareLinkOpenOutput, SharePortOutput } from "../src/shared/contracts.ts";
import { CAP_SHARE_KEPT, keptFile, keptLinks, keptText, readKept } from "../src/shared/share_kept.ts";
import { serve, stop } from "../src/hub/http/index.ts";
import { leadCalls } from "../src/hub/lead_calls/index.ts";
import type { SocketData } from "../src/hub/http/route.ts";
import { people } from "../src/hub/people/store.ts";
import { start } from "../src/hub/share_links/loops.ts";
import { dial } from "../src/node/share/index.ts";
import { Keeper } from "../src/node/share/keep.ts";
import { endLeft, killTree, leftFile } from "../src/node/runner/host.ts";
import { sweepMarked } from "../src/node/runner/host/reaper.ts";
import { keptGroups, keptSources } from "../src/node/runner/kept.ts";
import { signal, spareGroups, statOf } from "../src/node/runner/procs.ts";
import { killOrphans } from "../src/node/sessions/proc.ts";
import { testHub } from "./people-kit.ts";
import { addMachine, agent, FakeLink } from "./screens_helpers.ts";
import { tempHome } from "./helpers.ts";

const linux = process.platform === "linux";
const MARKER = "th7.4242.1.0";

// A dev server as an agent starts one: its own process, its own group (its shell's), the session's marker and scratch
// dir in its environment. It answers a page and a hot-reload socket.
const DEV_SERVER = `
const s = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch(req, srv) {
    if (new URL(req.url).pathname === "/hmr") return srv.upgrade(req) ? undefined : new Response("no", { status: 400 });
    return new Response("<h1>kept app</h1>", { headers: { "content-type": "text/html" } });
  },
  websocket: { message: (ws, m) => ws.send("pong " + m) },
});
console.log(s.port);
setInterval(() => {}, 1000);
`;

type Dev = { child: ChildProcess; pid: number; port: number; exited: Promise<void> };
const started: Dev[] = [];

async function devServer(marker: string | undefined, tmpdir: string): Promise<Dev> {
  const env: Record<string, string> = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", TMPDIR: tmpdir };
  if (marker) env.FLEETD_RUNNER_SESSION = marker;
  const child = spawn(process.execPath, ["-e", DEV_SERVER], { env, stdio: ["ignore", "pipe", "ignore"], detached: true });
  const exited = new Promise<void>((r) => child.once("exit", () => r()));
  const port = await new Promise<number>((resolve, reject) => {
    child.stdout!.once("data", (d) => resolve(Number(String(d).trim())));
    child.once("error", reject);
  });
  const dev = { child, pid: child.pid!, port, exited };
  started.push(dev);
  return dev;
}

const alive = (d: Dev) => d.child.exitCode === null && d.child.signalCode === null;

let t: ReturnType<typeof rig>;
let server: Server<SocketData>;
let home: { dir: string; done: () => void };
let hosts: string;
let keeper: Keeper;
let syncing: Promise<void> = Promise.resolve();

function rig() {
  const k = testHub();
  const fake = k.hub.area("link", () => new FakeLink() as never) as unknown as FakeLink;
  addMachine(k.hub, "devbox");
  k.hub.db.conn.query("INSERT INTO tasks (n, machine_id, project_id, workstream_id, state, thread_id, data) VALUES (7, 'devbox', 'p1', 'W1', 'running', 'th7', '{}')").run();
  start(k.hub);
  const ownerId = people(k.hub).list(false)[0]!.personId;
  return { ...k, fake, owner: k.device(undefined, ownerId, "desk") };
}

beforeEach(() => {
  home = tempHome();
  hosts = join(home.dir, "hosts");
  mkdirSync(join(hosts, "th7"), { recursive: true });
  t = rig();
  server = serve(t.hub, t.tools, 0);
  keeper = new Keeper(hosts, { now: () => t.clock.now(), boxed: () => false });
  // The node's sweeps spare what the kept files keep, on the workspace's clock.
  spareGroups(() => keptGroups(keptSources(hosts), t.clock.now()));
  t.fake.onSend = (_machine, f) => {
    if (f.t === "preview_dial") void dial(`http://127.0.0.1:${server.port}`, String(f.token), Number(f.port), f.thread as string | undefined);
    if (f.t === "share_kept") syncing = syncing.then(() => keeper.sync(keptLinks(f.links)));
  };
  t.fake.link("devbox", [CAP_SHARE_KEPT]);
  t.hub.db.conn.query("INSERT INTO share_link_settings (key, value) VALUES ('preview_url', ?)").run(`http://localhost:${server.port}`);
});
afterEach(async () => {
  spareGroups(() => new Set());
  for (const d of started.splice(0)) {
    try {
      process.kill(-d.pid, "SIGKILL");
    } catch {}
  }
  await stop(server);
  t.hub.shutdown.abort();
  home.done();
});
afterAll(() => spareGroups(() => new Set()));

const at = (l: ShareLink, path: string, headers: Record<string, string> = {}) =>
  fetch(`http://127.0.0.1:${server.port}${path}`, { headers: { host: new URL(l.url).host, ...headers }, redirect: "manual" });

async function agentShares(port: number, minutes?: number): Promise<ShareLink> {
  const out = (await leadCalls(t.hub).handler("share_port")!(agent("devbox", "p1", "T7"), { op: "share_port", port, ...(minutes ? { minutes } : {}) })) as SharePortOutput;
  await syncing;
  return out.link;
}

async function signIn(l: ShareLink): Promise<string> {
  const { url } = await t.call<ShareLinkOpenOutput>(t.owner, "share_link_open", { name: l.name });
  const entered = await at(l, new URL(url).pathname + new URL(url).search);
  return entered.headers.get("set-cookie")!.split(";")[0]!;
}

/** What ends a task's session on this machine: claude's exit sweep by its marker, the host's kill of what is left, the
 * task's end over what its hosts recorded, and a later node's sweep of a dead node's orphans. */
async function agentEnds(dev: Dev): Promise<void> {
  const dir = join(hosts, "th7");
  signal(sweepMarked(MARKER), "SIGKILL");
  killTree({ protocol: 1, hostPid: 0, pid: 0, marker: MARKER });
  const st = statOf(dev.pid)!;
  writeFileSync(leftFile(dir), `${dev.pid} ${st.start}\n`);
  await endLeft(dir);
  await killOrphans(home.dir, { hosts: [], sessions: new Set() }, 200);
}

async function hotReload(l: ShareLink, cookie: string): Promise<string> {
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}/hmr`, { headers: { host: new URL(l.url).host, cookie } } as never);
  const got = new Promise<string>((r) => (ws.onmessage = (e) => r(String(e.data))));
  await new Promise((r, j) => ((ws.onopen = r), (ws.onerror = j)));
  ws.send("ping");
  const answer = await got;
  ws.close();
  return answer;
}

test.skipIf(!linux)("the agent ends, the link still serves its dev server, hot reload too; revoking it stops the server", async () => {
  const dev = await devServer(MARKER, join(home.dir, "tmp", "th7"));
  const link = await agentShares(dev.port);
  // The machine was told, and the node found the server's own group.
  expect(t.fake.sent("devbox").at(-1)).toEqual({ t: "share_kept", links: [{ thread: "th7", port: dev.port, untilMs: Date.parse(link.expiresAt) }] });
  const kept = readKept(readFileSync(keptFile(join(hosts, "th7")), "utf8"));
  expect(kept).toEqual([{ port: dev.port, untilMs: Date.parse(link.expiresAt), group: { pid: dev.pid, pgid: dev.pid, start: statOf(dev.pid)!.start! } }]);
  await agentEnds(dev);
  await Bun.sleep(100);
  expect(alive(dev)).toBe(true);
  const cookie = await signIn(link);
  const page = await at(link, "/", { cookie });
  expect(page.status).toBe(200);
  expect(await page.text()).toBe("<h1>kept app</h1>");
  expect(await hotReload(link, cookie)).toBe("pong ping");
  // Stopped: the machine is told it keeps nothing, and the node stops the server's group.
  await t.call(t.owner, "share_link_revoke", { name: link.name });
  await syncing;
  await dev.exited;
  expect(t.fake.sent("devbox").at(-1)).toEqual({ t: "share_kept", links: [] });
  expect(existsSync(keptFile(join(hosts, "th7")))).toBe(false);
});

test.skipIf(!linux)("a link's end stops its server; until then, and once it ends, the sweeps act as before", async () => {
  const dev = await devServer(MARKER, join(home.dir, "tmp", "th7"));
  await agentShares(dev.port, 1);
  t.clock.ms += 30_000;
  await keeper.tick();
  await agentEnds(dev);
  await Bun.sleep(100);
  expect(alive(dev)).toBe(true);
  t.clock.ms += 31_000;
  await keeper.tick();
  await dev.exited;
  expect(existsSync(keptFile(join(hosts, "th7")))).toBe(false);
});

test.skipIf(!linux)("while the session still runs, a link's end leaves the server to its own end", async () => {
  const dev = await devServer(MARKER, join(home.dir, "tmp", "th7"));
  // The session's host is alive (this process stands in for it).
  writeFileSync(join(hosts, "th7", "host.json"), JSON.stringify({ protocol: 1, hostPid: process.pid, hostStart: statOf(process.pid)!.start, pid: 0, marker: MARKER }));
  const link = await agentShares(dev.port);
  await t.call(t.owner, "share_link_revoke", { name: link.name });
  await syncing;
  await Bun.sleep(200);
  expect(alive(dev)).toBe(true);
  // No longer kept: the session's end takes it.
  await agentEnds(dev);
  await dev.exited;
});

test.skipIf(!linux)("a process the session didn't start is never kept, nor stopped", async () => {
  const theirs = await devServer("someone-else.1.2.3", join(home.dir, "elsewhere"));
  const unmarked = await devServer(undefined, join(home.dir, "elsewhere"));
  for (const dev of [theirs, unmarked]) {
    const link = await agentShares(dev.port);
    expect(readKept(readFileSync(keptFile(join(hosts, "th7")), "utf8")).find((p) => p.port === dev.port)?.group).toBeUndefined();
    expect(keptGroups(keptSources(hosts), t.clock.now()).has(dev.pid)).toBe(false);
    await t.call(t.owner, "share_link_revoke", { name: link.name });
    await syncing;
  }
  await Bun.sleep(200);
  expect([alive(theirs), alive(unmarked)]).toEqual([true, true]);
});

test.skipIf(!linux)("a session host reads its own kept file, a box's too, by the port alone", async () => {
  const dev = await devServer(MARKER, join(home.dir, "tmp", "th7"));
  // No group recorded (a box's driver writes the port only): the listener carrying the session's marker is spared.
  writeFileSync(keptFile(join(hosts, "th7")), keptText([{ port: dev.port, untilMs: t.clock.now() + 60_000 }]));
  expect(keptGroups(keptSources(hosts), t.clock.now())).toEqual(new Set([dev.pid]));
  // Another session's file spares nothing of this one's.
  writeFileSync(keptFile(join(hosts, "th7")), "");
  mkdirSync(join(hosts, "th8"));
  writeFileSync(keptFile(join(hosts, "th8")), keptText([{ port: dev.port, untilMs: t.clock.now() + 60_000 }]));
  expect(keptGroups(keptSources(hosts), t.clock.now()).size).toBe(0);
  // The cloud's box spawns carry the session id alone as their marker: kept for that session, and for no other.
  const boxed = await devServer("th7", join(home.dir, "tmp", "th7"));
  writeFileSync(keptFile(join(hosts, "th7")), keptText([{ port: boxed.port, untilMs: t.clock.now() + 60_000 }]));
  writeFileSync(keptFile(join(hosts, "th8")), keptText([{ port: boxed.port, untilMs: t.clock.now() + 60_000 }]));
  expect(keptGroups(keptSources(hosts), t.clock.now())).toEqual(new Set([boxed.pid]));
  expect(keptGroups([{ session: "th8", dir: join(hosts, "th8"), file: keptFile(join(hosts, "th8")) }], t.clock.now()).size).toBe(0);
});

test("share_kept's links and the kept file are read strictly", () => {
  expect(keptLinks([{ thread: "th7", port: 5173, untilMs: 1 }, { thread: "../x", port: 1, untilMs: 1 }, { thread: "a", port: 70000, untilMs: 1 }, null, "x"])).toEqual([
    { thread: "th7", port: 5173, untilMs: 1 },
  ]);
  expect(keptLinks("nope")).toEqual([]);
  expect(readKept(keptText([{ port: 5173, untilMs: 5, group: { pid: 10, pgid: 10, start: 3 } }]))).toEqual([{ port: 5173, untilMs: 5, group: { pid: 10, pgid: 10, start: 3 } }]);
  expect(readKept(JSON.stringify({ ports: [{ port: 5173, untilMs: 5, group: { pid: 1, pgid: 1 } }, { port: 0, untilMs: 5 }] }))).toEqual([{ port: 5173, untilMs: 5 }]);
  expect(readKept("not json")).toEqual([]);
});

test("a person's link keeps nothing, and a node that doesn't keep is told nothing", async () => {
  const out = await t.call<SharePortOutput>(t.owner, "share_port", { machineId: "devbox", port: 4999 });
  expect(t.fake.sent("devbox").at(-1)).toEqual({ t: "share_kept", links: [] });
  t.fake.link("devbox", []);
  await t.call(t.owner, "share_link_revoke", { name: out.link.name });
  expect(t.fake.sent("devbox")).toEqual([]);
});

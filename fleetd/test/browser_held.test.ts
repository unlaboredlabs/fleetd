// A node's Chrome held past the node (src/node/browser/held.ts), on a real headless Chrome where this machine has one
// and socat: an agent's browser session goes on through a node restart (an update), in the same browser, its page as
// it was, and the agent's driver reaches it at the same address. Two nodes on one home stand in for the node before
// and after the restart.
import { afterEach, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cdp, type Transport } from "../src/node/browser/cdp.ts";
import { stopAreas } from "../src/node/areas.ts";
import { findChrome } from "../src/node/browser/chrome.ts";
import { canHold, dropHeld, heldRoot, launchHeld, leftHeld, localBox, NotItsOwn, proven } from "../src/node/browser/held.ts";
import { Broker, start } from "../src/node/browser/index.ts";
import { playwrightDirs } from "./browser_rig.ts";
import { tempHome } from "./helpers.ts";
import { type TestNode, testNode } from "./node_helpers.ts";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

const chrome = process.env.FLEETD_TEST_CHROME || playwrightDirs.map(findChrome).find((c) => c !== undefined);
const THREAD = "t-held";

/** A node on `home` whose broker runs `chrome` from its pool, the hub's answers to a recording's pieces stood in. */
function nodeOn(home: string): { t: TestNode; broker: Broker } {
  const t = testNode("devbox", {}, home);
  t.link.answer = async (op, args) =>
    op === "browser_recording_part" ? { bytes: Number(args.offset) + Buffer.from(String(args.dataB64), "base64").length } : {};
  const broker = new Broker(t.node, undefined, { warm: 0 });
  broker.ready(chrome!);
  start(t.node, broker);
  return { t, broker };
}

/** The agent's agent-browser: a CDP websocket to the node's proxy, each command's answer by its id. */
async function driver(url: string) {
  const ws = new WebSocket(url);
  const got: Record<string, unknown>[] = [];
  ws.onmessage = (e) => got.push(JSON.parse(String(e.data)));
  await new Promise((r) => (ws.onopen = r));
  cleanups.push(() => ws.close());
  return async (id: number, method: string, params: Record<string, unknown> = {}, sessionId?: string) => {
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    for (const end = Date.now() + 10_000; Date.now() < end; ) {
      const answer = got.find((m) => m.id === id);
      if (answer) return answer as { result?: Record<string, unknown>; error?: { message: string } };
      await Bun.sleep(5);
    }
    throw new Error(`no answer to ${method}`);
  };
}

/** The title of the first page the driver finds. */
async function title(call: Awaited<ReturnType<typeof driver>>, from: number): Promise<string> {
  const targets = (await call(from, "Target.getTargets")).result as { targetInfos: { type: string; title: string }[] };
  return targets.targetInfos.find((t) => t.type === "page")?.title ?? "";
}

test.skipIf(!chrome || !canHold())(
  "a node restart keeps an agent's browser session: the next node takes it over, the same browser and page",
  async () => {
    const home = tempHome();
    cleanups.push(home.done);
    // Whatever a failed run left held goes with the test.
    cleanups.push(() => {
      for (const { dir } of leftHeld(home.dir)) dropHeld(dir);
    });
    const before = nodeOn(home.dir);
    const started = (await before.t.local.call("session_start", { purpose: "sign in" }, THREAD)) as { sessionId: string; cdp: string };
    const call = await driver(started.cdp);
    const targets = (await call(1, "Target.getTargets")).result as { targetInfos: { targetId: string; type: string }[] };
    const page = targets.targetInfos.find((t) => t.type === "page")!;
    const attached = (await call(2, "Target.attachToTarget", { targetId: page.targetId, flatten: true })).result as { sessionId: string };
    await call(3, "Page.navigate", { url: "data:text/html,<title>signed in</title><h1>hello</h1>" }, attached.sessionId);
    for (let id = 4, end = Date.now() + 10_000; (await title(call, id)) !== "signed in" && Date.now() < end; id++) await Bun.sleep(50);
    expect(await title(call, 100)).toBe("signed in");

    // The node stops, as an update stops it: the session isn't ended, and its Chrome waits for the next node.
    await stopAreas(before.t.node);
    expect(before.t.link.calls.filter((c) => c.op === "browser_session").map((c) => c.args.state)).toEqual(["live"]);
    // Its Chrome's folder alone: a launch that failed on the way (Chrome's sandbox refused here) left none.
    const [held, ...more] = leftHeld(home.dir);
    expect(more).toEqual([]);
    expect(held?.sealed).toBeDefined();
    // Sealed to the node's box key: the filled values a snapshot carries never lie on disk in the clear.
    expect(Buffer.from(held!.sealed!).toString()).not.toContain(THREAD);

    const after = nodeOn(home.dir);
    const reported = () => after.t.link.calls.some((c) => c.op === "browser_session");
    for (const end = Date.now() + 20_000; !reported() && Date.now() < end; ) await Bun.sleep(20);
    expect(after.broker.live(THREAD)?.id).toBe(started.sessionId);
    expect(after.t.link.calls.find((c) => c.op === "browser_session")?.args).toMatchObject({ sessionId: started.sessionId, state: "live" });
    // The agent's agent-browser, at the address it had: the same browser, on the page it left.
    const again = await driver(started.cdp);
    expect(await title(again, 1)).toBe("signed in");

    // Its own end ends it for good: its Chrome and its folder go.
    await after.t.local.call("session_end", {}, THREAD);
    expect(existsSync(held!.dir)).toBe(false);
    expect(leftHeld(home.dir)).toEqual([]);
    await stopAreas(after.t.node);
    expect(existsSync(heldRoot(home.dir))).toBe(true);
  },
  60_000,
);

/** A browser that answers SystemInfo.getProcessInfo with `pid` as its browser process, and is shut or not. */
function answering(pid: number): { cdp: Cdp; shut: () => boolean } {
  let deliver: (text: string) => void = () => {};
  let closed = false;
  const transport: Transport = {
    send(text) {
      const m = JSON.parse(text) as { id: number };
      queueMicrotask(() => deliver(JSON.stringify({ id: m.id, result: { processInfo: [{ type: "renderer", id: 1 }, { type: "browser", id: pid }] } })));
      return true;
    },
    onMessage: (fn) => (deliver = fn),
    onClose: () => {},
    close: () => void (closed = true),
  };
  return { cdp: new Cdp(transport), shut: () => closed };
}

test("only Linux holds a Chrome past the node: a Mac's runs on the node's own pipe", () => {
  expect(canHold("darwin")).toBe(false);
  expect(canHold("win32")).toBe(false);
});

test.skipIf(process.platform !== "linux")("a held Chrome's connection counts only once the Chrome proves it is its folder's own, never another's on the port", async () => {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "held-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  // Its launcher: a process session of its own, as held.ts starts one, and a process in it standing in for Chrome. Its
  // pid file appears whole (renamed into place): one read as the shell opened it, empty, named no process.
  const launcher = spawn("/bin/sh", ["-c", "sleep 30 & echo $! > child.pid.tmp; mv child.pid.tmp child.pid; wait"], { cwd: dir, detached: true, stdio: "ignore" });
  cleanups.push(() => void process.kill(-launcher.pid!, "SIGKILL"));
  writeFileSync(join(dir, "session.pid"), `${launcher.pid}\n`);
  for (const end = Date.now() + 5_000; !existsSync(join(dir, "child.pid")) && Date.now() < end; ) await Bun.sleep(10);
  const ownChrome = Number(await Bun.file(join(dir, "child.pid")).text());

  const own = answering(ownChrome);
  expect(await proven({ cdp: own.cdp }, dir)).toMatchObject({ cdp: own.cdp });
  expect(own.shut()).toBe(false);
  // Another Chrome answered on the port (another agent's, waiting for its next node; this test's own process here):
  // dropped before anything of the session's goes to it.
  const other = answering(process.pid);
  await expect(proven({ cdp: other.cdp }, dir)).rejects.toBeInstanceOf(NotItsOwn);
  expect(other.shut()).toBe(true);
  // One that won't say which process it is counts as another.
  const silent = answering(0);
  await expect(proven({ cdp: silent.cdp }, dir)).rejects.toBeInstanceOf(NotItsOwn);
});

test.skipIf(!chrome || !canHold())("a real held Chrome dialled on another held Chrome's port is refused; on its own, taken", async () => {
  const home = tempHome();
  cleanups.push(home.done);
  cleanups.push(() => {
    for (const { dir } of leftHeld(home.dir)) dropHeld(dir);
  });
  const { broker } = nodeOn(home.dir);
  const a = await launchHeld(home.dir, chrome!, false);
  const b = await launchHeld(home.dir, chrome!, false);
  // A lets go, as a node stops: its socat waits on its port for the next connection.
  a.cdp.shut();
  await expect(broker.reattach(localBox, { dir: b.handle!.dir, port: a.handle!.port }, 1_000)).rejects.toThrow("another browser answered on its port");
  const again = await broker.reattach(localBox, a.handle!, 2_000);
  expect(again.cdp.isClosed()).toBe(false);
  await again.close!();
  await b.close!();
}, 60_000);

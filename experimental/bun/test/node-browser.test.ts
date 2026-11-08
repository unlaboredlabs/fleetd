import { afterEach, expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import { Cdp, type Transport } from "../src/node/browser/cdp.ts";
import { findChrome } from "../src/node/browser/chrome.ts";
import { AGENT_BROWSER_METHODS, cssPlain, refusal, revealingSelector } from "../src/node/browser/guard.ts";
import { Broker, start } from "../src/node/browser/index.ts";
import { findFfmpeg, VideoSink } from "../src/node/browser/record.ts";
import { Proxy } from "../src/node/browser/proxy.ts";
import { PAUSED, cdpInput } from "../src/node/browser/session.ts";
import { tempHome } from "./helpers.ts";
import { testNode } from "./node_helpers.ts";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

const plain = { isOwn: () => false, isOwnTarget: () => false, sealed: () => false };

test("the proxy lets through only the commands agent-browser sends", () => {
  expect(refusal(plain, { method: "Runtime.evaluate", params: { expression: "1" } })).toBeUndefined();
  expect(refusal(plain, { method: "Input.dispatchKeyEvent" })).toBeUndefined();
  for (const method of ["Debugger.enable", "Target.exposeDevToolsProtocol", "Target.sendMessageToTarget", "Network.setRequestInterception", "HeapProfiler.takeHeapSnapshot", "Storage.getCookies", ""]) {
    expect(refusal(plain, { method })).toContain("is refused here");
  }
  expect(refusal(plain, { method: "Target.attachToTarget", params: { targetId: "x" } })).toContain("flatten: true");
  expect(refusal(plain, { method: "Target.attachToTarget", params: { targetId: "x", flatten: true } })).toBeUndefined();
  const own = { isOwn: (s: string) => s === "mine", isOwnTarget: (t: string) => t === "T", sealed: () => false };
  expect(refusal(own, { method: "Runtime.evaluate", sessionId: "mine" })).toBe("No session with given id");
  expect(refusal(own, { method: "Target.detachFromTarget", params: { sessionId: "mine" } })).toBe("No session with given id");
  expect(refusal(own, { method: "Target.detachFromTarget", params: { targetId: "T" } })).toContain("by targetId is refused");
  expect(AGENT_BROWSER_METHODS.size).toBe(78);
});

test("a session that filled a login keeps a narrower list, and its selectors may not test a field's state", () => {
  const sealed = { ...plain, sealed: () => true };
  for (const method of ["Page.printToPDF", "Fetch.enable", "Network.getResponseBody", "Page.addScriptToEvaluateOnNewDocument", "Tracing.start"]) {
    expect(refusal(sealed, { method })).toContain("is off in this browser session");
  }
  expect(refusal(sealed, { method: "Accessibility.getFullAXTree" })).toBeUndefined();
  expect(refusal(sealed, { method: "Page.navigate", params: { url: " JavaScript:alert(1)" } })).toContain("is off");
  expect(refusal(sealed, { method: "Page.navigate", params: { url: "https://example.com" } })).toBeUndefined();
  expect(refusal(sealed, { method: "Page.reload", params: { scriptToEvaluateOnLoad: "x" } })).toContain("is off");
  expect(refusal(sealed, { method: "DOM.querySelectorAll", params: { selector: "input:Inv\\61 lid" } })).toContain(":invalid");
  expect(refusal(sealed, { method: "DOM.querySelectorAll", params: { selector: "#login" } })).toBeUndefined();
  // agent-browser's own scripts run; others don't (node-shapes.test.ts has the rest).
  expect(refusal(sealed, { method: "Runtime.evaluate", params: { expression: "document.title" } })).toBeUndefined();
  expect(refusal(sealed, { method: "Runtime.evaluate", params: { expression: "document.cookie" } })).toContain("not one of agent-browser");
  expect(cssPlain("A /* c */ [Val\\75 e]")).toBe("a[value]");
  expect(revealingSelector("[data-x]")).toBeUndefined();
});

test("a person's input becomes the CDP command for it, scaled to the page", () => {
  expect(cdpInput({ kind: "mouse", action: "pressed", x: 10, y: 20, button: "left", clickCount: 1 }, 2, 2)).toEqual([
    "Input.dispatchMouseEvent",
    { type: "mousePressed", x: 20, y: 40, button: "left", clickCount: 1, deltaX: 0, deltaY: 0, modifiers: 0 },
  ]);
  expect(cdpInput({ kind: "key", action: "down", key: "Enter" }, 1, 1)).toEqual([
    "Input.dispatchKeyEvent",
    { type: "keyDown", key: "Enter", modifiers: 0, windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, text: "\r", unmodifiedText: "\r" },
  ]);
  expect(cdpInput({ kind: "text", text: "hi" }, 1, 1)).toEqual(["Input.insertText", { text: "hi" }]);
});

test("the proxy's URL is signed and survives a node restart on the same port", async () => {
  const home = tempHome();
  cleanups.push(home.done);
  const first = Proxy.start(home.dir, { live: () => undefined });
  const url = first.url("thread-1");
  first.stop();
  await Bun.sleep(20);
  const again = Proxy.start(home.dir, { live: () => undefined });
  cleanups.push(() => again.stop());
  expect(again.url("thread-1")).toBe(url);
  const token = url.slice(url.lastIndexOf("/") + 1);
  expect(again.threadOf(token)).toBe("thread-1");
  expect(again.threadOf(`thread-2.${token.split(".")[1]}`)).toBeUndefined();
  expect(again.threadOf("thread-1.zz")).toBeUndefined();
  const http = url.replace("ws://", "http://");
  expect((await fetch(http, { headers: { upgrade: "websocket" } })).status).toBe(409);
  expect((await fetch(http.replace(/\.[0-9a-f]+$/, ".00"), { headers: { upgrade: "websocket" } })).status).toBe(403);
  expect((await Bun.file(join(home.dir, "browser", "proxy.json")).stat()).mode & 0o777).toBe(0o600);
});

/** A browser that answers every command with its method, and has one page. */
function fakeBrowser(): Transport & { got: Record<string, unknown>[] } {
  let deliver: (text: string) => void = () => {};
  const got: Record<string, unknown>[] = [];
  return {
    got,
    send(text) {
      const m = JSON.parse(text) as { id: number; method: string; params: { targetId?: string } };
      got.push(m);
      const result =
        m.method === "Target.getTargets"
          ? { targetInfos: [{ targetId: "P1", type: "page", url: "about:blank" }] }
          : m.method === "Target.attachToTarget"
            ? { sessionId: m.params.targetId === "P1" && got.filter((g) => g.method === "Target.attachToTarget").length === 1 ? "broker-s" : "driver-s" }
            : { echo: m.method };
      queueMicrotask(() => deliver(JSON.stringify({ id: m.id, result })));
      return true;
    },
    onMessage: (fn) => (deliver = fn),
    onClose: () => {},
    close: () => {},
  };
}

function nodeWith(launcher: () => Promise<{ cdp: Cdp }>) {
  const t = testNode();
  // The hub's answer to a recording's piece: what it holds after it.
  t.link.answer = async (op, args) =>
    op === "browser_recording_part" ? { bytes: Number(args.offset) + Buffer.from(String(args.dataB64), "base64").length } : {};
  const broker = start(t.node, new Broker(t.node, launcher));
  cleanups.push(async () => {
    await broker.shutdown();
    t.done();
  });
  return { node: t.node, broker, link: t.link, local: t.local };
}

const driver = async (url: string) => {
  const ws = new WebSocket(url);
  const got: Record<string, unknown>[] = [];
  ws.onmessage = (e) => got.push(JSON.parse(String(e.data)));
  await new Promise((r) => (ws.onopen = r));
  const call = async (id: number, method: string, params: Record<string, unknown> = {}, sessionId?: string) => {
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    for (let i = 0; i < 200; i++) {
      const answer = got.find((m) => m.id === id);
      if (answer) return answer;
      await Bun.sleep(5);
    }
    throw new Error(`no answer to ${method}`);
  };
  return { ws, got, call };
};

test("the agent's driver reaches its browser through the proxy, and waits while a person drives", async () => {
  const browser = fakeBrowser();
  const { link, local } = nodeWith(async () => ({ cdp: new Cdp(browser) }));
  const started = (await local.call("session_start", { purpose: "look" }, "t1")) as { sessionId: string; cdp: string };
  expect(link.calls[0]).toMatchObject({ op: "browser_session", args: { threadId: "t1", state: "live", control: "agent", purpose: "look" } });
  const d = await driver(started.cdp);
  // Under the proxy's own id, answered under the driver's.
  expect(await d.call(41, "Page.navigate", { url: "https://example.com" }, "driver-s")).toEqual({ id: 41, result: { echo: "Page.navigate" } });
  expect(await d.call(42, "Debugger.enable")).toMatchObject({ id: 42, error: { code: -32000 } });
  // The broker's own session to the page is as if it didn't exist.
  expect(await d.call(43, "Runtime.evaluate", { expression: "1" }, "broker-s")).toMatchObject({ error: { message: "No session with given id" } });
  link.deliver({ t: "browser_control", sessionId: started.sessionId, control: "human", by: "human:phone" });
  expect(link.calls.at(-1)).toMatchObject({ op: "browser_session", args: { control: "human" } });
  expect(await d.call(44, "Page.reload")).toMatchObject({ error: { message: PAUSED } });
  // Handed back: the agent's next command takes control again.
  link.deliver({ t: "browser_control", sessionId: started.sessionId, control: "agent", by: "human:phone" });
  expect(link.calls.at(-1)).toMatchObject({ args: { control: "handing_back" } });
  expect(await d.call(45, "Page.reload", {}, "driver-s")).toMatchObject({ result: { echo: "Page.reload" } });
  expect(link.calls.at(-1)).toMatchObject({ args: { control: "agent" } });
  d.ws.close();
  const ended = (await local.call("session_end", {}, "t1")) as { sessionId: string; files: { file: string; bytes: number }[] };
  expect(ended.sessionId).toBe(started.sessionId);
  // Its recording goes to the hub: uploading, its action log in pieces, then recorded with what the hub holds.
  for (let i = 0; i < 100 && link.calls.at(-1)?.args.state !== "recorded"; i++) await Bun.sleep(10);
  const ops = link.calls.slice(-3).map((c) => `${c.op}:${String(c.args.state ?? c.args.file)}`);
  expect(ops).toEqual(["browser_session:uploading", "browser_recording_part:actions", "browser_session:recorded"]);
  const log = Buffer.from(String(link.calls.at(-2)!.args.dataB64), "base64").toString().trim().split("\n").map((l) => JSON.parse(l));
  expect(log.map((a: { tool: string }) => a.tool)).toEqual(["takeover", "handback"]);
  expect(link.calls.at(-1)!.args.files).toEqual([{ file: "actions", bytes: ended.files[0]!.bytes }]);
});

const chrome = findChrome(join(homedir(), ".cache", "ms-playwright"));

test.skipIf(!chrome)("a real headless Chrome: launched on its pipe, driven through the proxy, its frames to a watcher", async () => {
  const { launch } = await import("../src/node/browser/chrome.ts");
  const home = tempHome();
  cleanups.push(home.done);
  const { link, local } = nodeWith(() => launch(chrome!, join(home.dir, "profiles"), true));
  const started = (await local.call("session_start", { purpose: "a page" }, "t2")) as { sessionId: string; cdp: string };
  link.deliver({ t: "browser_watch", sessionId: started.sessionId, on: true });
  const d = await driver(started.cdp);
  const targets = (await d.call(1, "Target.getTargets")) as { result: { targetInfos: { targetId: string; type: string }[] } };
  const page = targets.result.targetInfos.find((t) => t.type === "page")!;
  const attached = (await d.call(2, "Target.attachToTarget", { targetId: page.targetId, flatten: true })) as { result: { sessionId: string } };
  const s = attached.result.sessionId;
  await d.call(3, "Page.navigate", { url: "data:text/html,<title>fleetd</title><h1 style='font-size:90px'>hello</h1>" }, s);
  await Bun.sleep(300);
  const title = (await d.call(4, "Runtime.evaluate", { expression: "document.title", returnByValue: true }, s)) as { result: { result: { value: string } } };
  expect(title.result.result.value).toBe("fleetd");
  for (let i = 0; i < 100 && !link.sent.some((f) => f.t === "browser_frame"); i++) await Bun.sleep(20);
  const frame = link.sent.find((f) => f.t === "browser_frame") as { sessionId: string; jpegB64: string; width: number; height: number };
  expect(frame).toMatchObject({ sessionId: started.sessionId });
  expect(frame.width).toBeGreaterThan(0);
  d.ws.close();
  await local.call("session_end", {}, "t2");
}, 30_000);

test("the hub's session_end ends the screen of a task that ended, and a person's input lands on the page", async () => {
  const { start: startScreens } = await import("../src/node/screens/index.ts");
  const browser = fakeBrowser();
  const { node, link, local } = nodeWith(async () => ({ cdp: new Cdp(browser) }));
  startScreens(node);
  const started = (await local.call("session_start", { purpose: "look" }, "t3")) as { sessionId: string };
  link.deliver({ t: "browser_control", sessionId: started.sessionId, control: "human", by: "human:phone" });
  link.deliver({ t: "browser_input", sessionId: started.sessionId, input: { kind: "text", text: "hi" } });
  await Bun.sleep(20);
  expect(browser.got.at(-1)).toMatchObject({ method: "Input.insertText", params: { text: "hi" }, sessionId: "broker-s" });
  // Another screen's id ends nothing; its own does.
  link.deliver({ t: "session_end", threadId: "t3", sessionId: "B-other" });
  link.deliver({ t: "session_end", threadId: "t3", sessionId: started.sessionId });
  for (let i = 0; i < 100 && link.calls.at(-1)?.args.state !== "recorded"; i++) await Bun.sleep(10);
  expect(link.calls.at(-1)).toMatchObject({ args: { sessionId: started.sessionId, state: "recorded" } });
});

test("node_action screens writes node.json, and the agents' Mac takes only its own screen", async () => {
  const { apply } = await import("../src/node/screens/index.ts");
  const home = tempHome();
  cleanups.push(home.done);
  const file = join(home.dir, "node.json");
  await Bun.write(file, JSON.stringify({ hub: "http://devbox:4790", browser: { idleMinutes: 9 } }));
  expect(apply(home.dir, { host: "browser", on: false, idleMinutes: 20 })).toStartWith("Saved.");
  expect(JSON.parse(await Bun.file(file).text())).toEqual({ hub: "http://devbox:4790", browser: { enabled: false }, screenIdleMinutes: 20 });
  expect(() => apply(home.dir, { host: "ios", on: true })).toThrow("iOS screens are gone");
  await Bun.write(file, JSON.stringify({ agentsMac: true }));
  expect(() => apply(home.dir, { idleMinutes: 3 })).toThrow("ends after 5 idle minutes");
});

test("an agent's agent-browser command is a step of its session: in its action log and the heartbeat", async () => {
  const browser = fakeBrowser();
  const t = testNode();
  const broker = start(t.node, new Broker(t.node, async () => ({ cdp: new Cdp(browser) })));
  cleanups.push(async () => {
    await broker.shutdown();
    t.done();
  });
  await t.local.call("session_start", { purpose: "look" }, "t4");
  const item = (command: string, status: string) => ({
    id: "i1",
    status,
    title: command,
    startedAt: "2026-11-08T12:00:00.000Z",
    completedAt: "2026-11-08T12:00:01.500Z",
    updatedAt: "2026-11-08T12:00:01.500Z",
    kind: { type: "command", command, output: "clicked", exitCode: 0 },
  });
  const items = t.node.area("items");
  items.ended("t4", item("agent-browser click @e3", "completed") as never);
  items.ended("t4", item("ls -la", "completed") as never);
  items.ended("t4", item("agent-browser snapshot", "running") as never);
  const hb = { steps: [] as unknown[], busy: { threads: 0, screens: 0, uploads: 0, hosted: 0 } };
  await t.node.area("hb").fill(hb as never);
  expect(hb.steps).toEqual([
    {
      sessionId: expect.stringMatching(/^B[0-9a-f]{32}$/),
      step: expect.objectContaining({ seq: 1, tool: "agent-browser", args: { command: "agent-browser click @e3" }, ok: true, result: "clicked", durationMs: 1500 }),
    },
  ]);
  expect(hb.busy.screens).toBe(1);
});

const ffmpeg = findFfmpeg(join(homedir(), ".cache", "ms-playwright"));

test.skipIf(!ffmpeg)("the screencast's frames become the session's video, through Playwright's ffmpeg", async () => {
  const home = tempHome();
  cleanups.push(home.done);
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
  const jpeg = await new Bun.Image(await new Bun.Image(png).resize(320, 200).png().bytes()).jpeg({ quality: 80 }).bytes();
  const out = join(home.dir, "video.webm");
  const video = new VideoSink(ffmpeg!, out, [320, 200]);
  for (let ms = 0; ms <= 400; ms += 40) video.frame(jpeg, ms);
  video.tick(2000);
  expect(await video.finish(2100)).toBeUndefined();
  expect((await Bun.file(out).arrayBuffer()).byteLength).toBeGreaterThan(100);
}, 30_000);

test("stopping the node ends its live sessions: reported, their browsers closed", async () => {
  const { stopAreas } = await import("../src/node/areas.ts");
  let closed = 0;
  const t = testNode();
  const broker = start(t.node, new Broker(t.node, async () => ({ cdp: new Cdp(fakeBrowser()), close: async () => void closed++ })));
  cleanups.push(t.done);
  await t.local.call("session_start", { purpose: "look" }, "t9");
  expect(broker.count()).toBe(1);
  await stopAreas(t.node);
  expect(broker.count()).toBe(0);
  expect(t.link.calls.at(-1)).toMatchObject({ op: "browser_session", args: { state: "recorded" } });
});

test("the node's hello lists what its screens answer: browsers on a node, the Mac's own on the agents' Mac", async () => {
  const { start: startMac } = await import("../src/node/mac_tool/index.ts");
  const listed = (agentsMac: boolean) => {
    const t = testNode("devbox", agentsMac ? { agentsMac: true } : {});
    const broker = start(t.node, new Broker(t.node, async () => ({ cdp: new Cdp(fakeBrowser()) })));
    startMac(t.node);
    cleanups.push(async () => {
      await broker.shutdown();
      t.done();
    });
    return t.node.area("caps").list();
  };
  expect(listed(false)).toEqual(["browser", "session_host", "session_seal", "session_end"]);
  expect(listed(true)).toEqual(["agents_mac", ...(process.platform === "darwin" ? ["mac_tool"] : [])]);
});

test("one recording has one upload at a time, however often housekeeping runs while it goes", async () => {
  const t = testNode();
  let release!: () => void;
  const slow = new Promise<void>((r) => (release = r));
  let uploads = 0;
  t.link.answer = async (op, args) => {
    if (op === "browser_session" && args.state === "uploading") uploads += 1;
    if (op === "browser_recording_part") {
      await slow;
      return { bytes: Number(args.offset) + Buffer.from(String(args.dataB64), "base64").length };
    }
    return {};
  };
  const broker = start(t.node, new Broker(t.node, async () => ({ cdp: new Cdp(fakeBrowser()) })));
  cleanups.push(async () => {
    await broker.shutdown();
    t.done();
  });
  const started = (await t.local.call("session_start", { purpose: "look" }, "t5")) as { sessionId: string };
  t.link.deliver({ t: "browser_control", sessionId: started.sessionId, control: "human", by: "human:phone" });
  await t.local.call("session_end", {}, "t5");
  // Its upload waits on the hub; housekeeping runs twice at once meanwhile.
  await Promise.all([broker.housekeep(), broker.housekeep()]);
  await broker.housekeep();
  release();
  for (let i = 0; i < 100 && t.link.calls.at(-1)?.args.state !== "recorded"; i++) await Bun.sleep(10);
  expect(uploads).toBe(1);
  expect(t.link.calls.at(-1)?.args.state).toBe("recorded");
});

test("a person's takeover and input keep a session from idling out", async () => {
  const t = testNode();
  const broker = start(t.node, new Broker(t.node, async () => ({ cdp: new Cdp(fakeBrowser()) })));
  cleanups.push(async () => {
    await broker.shutdown();
    t.done();
  });
  const started = (await t.local.call("session_start", { purpose: "look" }, "t6")) as { sessionId: string };
  const session = broker.live("t6")!;
  const long = Date.now() - 31 * 60_000;
  session.touched = long;
  t.link.deliver({ t: "browser_control", sessionId: started.sessionId, control: "human", by: "human:phone" });
  expect(session.touched).toBeGreaterThan(long);
  session.touched = long;
  t.link.deliver({ t: "browser_input", sessionId: started.sessionId, input: { kind: "text", text: "hi" } });
  await Bun.sleep(20);
  expect(session.touched).toBeGreaterThan(long);
  // Handed back after a long takeover: still live until the idle limit passes from the handback.
  t.link.deliver({ t: "browser_control", sessionId: started.sessionId, control: "agent", by: "human:phone" });
  await broker.housekeep();
  expect(broker.live("t6")).toBeDefined();
  session.touched = long;
  await broker.housekeep();
  expect(broker.live("t6")).toBeUndefined();
});


test("an agent's claude launches with agent-browser at this node's proxy, under a policy that denies other browsers", async () => {
  const t = testNode();
  const broker = start(t.node, new Broker(t.node, async () => ({ cdp: new Cdp(fakeBrowser()) })));
  cleanups.push(async () => {
    await broker.shutdown();
    t.done();
  });
  const launch = t.node.area("launch");
  const env = Object.fromEntries(launch.env("t7", "/usr/bin"));
  expect(env).toEqual({
    PATH: `${join(t.node.home, "browser", "agent-browser", "bin")}:/usr/bin`,
    AGENT_BROWSER_CDP: broker.proxy.url("t7"),
    AGENT_BROWSER_SESSION: "fleetd-t7",
    AGENT_BROWSER_ACTION_POLICY: join(t.node.home, "sessions", "t7", "agent-browser-policy.json"),
  });
  await t.local.call("session_start", { purpose: "look" }, "t7");
  expect(JSON.parse(await Bun.file(env.AGENT_BROWSER_ACTION_POLICY!).text())).toEqual({ default: "allow", deny: ["connect"] });
});

import { afterEach, expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import { Cdp, type Transport } from "../src/node/browser/cdp.ts";
import { findChrome } from "../src/node/browser/chrome.ts";
import { AGENT_BROWSER_METHODS, cssPlain, refusal, revealingSelector } from "../src/node/browser/guard.ts";
import { Broker, start } from "../src/node/browser/index.ts";
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
  // Closed, not open, until agent-browser's script shapes are pinned here.
  expect(refusal(sealed, { method: "Runtime.evaluate", params: { expression: "document.title" } })).toContain("refused");
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
  const ended = (await local.call("session_end", {}, "t1")) as { sessionId: string };
  expect(ended.sessionId).toBe(started.sessionId);
  expect(link.calls.at(-1)).toMatchObject({ args: { state: "recorded", files: [] } });
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
  await Bun.sleep(20);
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

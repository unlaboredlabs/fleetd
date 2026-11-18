// A boxed agent's browser (browser/egress.ts): its connections made by the box, local schemes and paths the box doesn't
// show refused, and a session that isn't boxed as before. The box here is `fleetd sandbox-guest` as a process beside
// the test (its "inside" is 127.0.0.2), or the test speaking a guest's side of the link; Chrome is Playwright's
// headless shell where it is installed (the real-Chrome test skips without it).
import { afterAll, afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { connect, createServer, type Server, type Socket } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { Duplex } from "node:stream";
import { AGENT_BROWSER_METHODS, BOXED_CHECKED, BOXED_PLAIN, boxedUrlRefusal, refusal } from "../../src/node/browser/guard.ts";
import { boxedArgs, boxPaths, Egress, greeting, replyFor, request } from "../../src/node/browser/egress.ts";
import { args as chromeArgs } from "../../src/node/browser/chrome.ts";
import type { LeadSocketHooks } from "../../src/node/lead/index.ts";
import { Box } from "../../src/node/sandbox/box.ts";
import { GUEST_PROTOCOL } from "../../src/node/sandbox/guest.ts";
import { Mux, NODE_CHANNELS } from "../../src/node/sandbox/mux.ts";
import { guestOwn, type View } from "../../src/node/place/view.ts";
import { Cdp, type Transport } from "../../src/node/browser/cdp.ts";
import { Broker, start } from "../../src/node/browser/index.ts";
import { Router, start as startRoute } from "../../src/node/session_route/index.ts";
import { NodeBoxKey } from "../../src/node/identity.ts";
import { chrome } from "../browser_rig.ts";
import { testNode } from "../node_helpers.ts";

const MAIN = join(import.meta.dir, "../../src/main.ts");
const tmpBase = process.env.TMPDIR ?? "/tmp";
// Not under the box's own dirs (/tmp on CI), which a boxed session's paths never are.
const root = mkdtempSync(join(guestOwn(tmpBase) ? homedir() : tmpBase, "fleetd-boxed-"));
const procs: Bun.Subprocess[] = [];
const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});
afterAll(async () => {
  for (const p of procs) p.kill("SIGKILL");
  rmSync(root, { recursive: true, force: true });
});

const noLead = {} as LeadSocketHooks;
const plain = { isOwn: () => false, isOwnTarget: () => false, sealed: () => false };

test("every command agent-browser sends is listed for boxed sessions, as taking no URL or path or with its check", () => {
  const listed = new Set([...BOXED_PLAIN, ...BOXED_CHECKED]);
  expect([...AGENT_BROWSER_METHODS].filter((m) => !listed.has(m))).toEqual([]);
  expect([...listed].filter((m) => !AGENT_BROWSER_METHODS.has(m))).toEqual([]);
  expect([...BOXED_PLAIN].filter((m) => BOXED_CHECKED.has(m))).toEqual([]);
});

test("a boxed session's pages go only to http, https, data, blob and about:blank", () => {
  for (const url of ["https://example.com", "http://localhost:5173/", "HTTP://127.0.0.1", "data:text/html,hi", "blob:https://a.test/x", "about:blank", " about:blank "]) {
    expect(boxedUrlRefusal(url)).toBeUndefined();
  }
  for (const url of ["file:///etc/passwd", "FILE:///etc/passwd", " \tfile:///home", "file://localhost/etc/passwd", "chrome://version", "chrome-untrusted://x", "view-source:file:///etc/passwd", "devtools://devtools/x", "filesystem:http://a/x", "chrome-extension://abc/x", "about:version", "javascript:location='file:///etc/passwd'", "ws://localhost:1", "example.com", ""]) {
    expect(boxedUrlRefusal(url)).toBeDefined();
  }
  expect(boxedUrlRefusal("file:///etc/passwd")).toContain("file: URLs are refused here");
});

test("a boxed session refuses local URLs, a context with its own proxy and paths its box doesn't show; a plain one doesn't", () => {
  const seen: [string, boolean][] = [];
  const boxed = { ...plain, boxed: () => (path: string, write: boolean) => (seen.push([path, write]), path.startsWith("/w/") ? undefined : `no ${path}`) };
  const cmd = (method: string, params: Record<string, unknown> = {}) => ({ id: 1, method, params });
  expect(refusal(boxed, cmd("Page.navigate", { url: "file:///etc/passwd" }))).toContain("file: URLs are refused");
  expect(refusal(boxed, cmd("Target.createTarget", { url: "chrome://settings" }))).toContain("chrome: URLs are refused");
  expect(refusal(boxed, cmd("Page.navigate", { url: "http://localhost:5173" }))).toBeUndefined();
  expect(refusal(boxed, cmd("Fetch.continueRequest", { requestId: "r", url: "file:///etc/passwd" }))).toBeDefined();
  expect(refusal(boxed, cmd("Fetch.continueRequest", { requestId: "r", url: "data:text/html,x" }))).toContain("only to http or https");
  expect(refusal(boxed, cmd("Fetch.continueRequest", { requestId: "r" }))).toBeUndefined();
  expect(refusal(boxed, cmd("Target.createBrowserContext", { proxyServer: "direct://" }))).toContain("proxyServer");
  expect(refusal(boxed, cmd("Target.createBrowserContext", { proxyBypassList: "*" }))).toContain("proxyBypassList");
  expect(refusal(boxed, cmd("Target.createBrowserContext", { disposeOnDetach: true }))).toBeUndefined();
  expect(refusal(boxed, cmd("Browser.setDownloadBehavior", { behavior: "deny" }))).toBeUndefined();
  expect(refusal(boxed, cmd("Browser.setDownloadBehavior", { behavior: "default" }))).toContain("needs a downloadPath");
  expect(refusal(boxed, cmd("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: "/h/.fleetd/node" }))).toBe("no /h/.fleetd/node");
  expect(refusal(boxed, cmd("Browser.setDownloadBehavior", { behavior: "allowAndName", downloadPath: "/w/dl" }))).toBeUndefined();
  expect(refusal(boxed, cmd("DOM.setFileInputFiles", { files: ["/w/a.png", "/h/.fleetd/node/node.json"], nodeId: 1 }))).toBe("no /h/.fleetd/node/node.json");
  expect(refusal(boxed, cmd("DOM.setFileInputFiles", { files: [7], nodeId: 1 }))).toContain("takes paths");
  expect(seen).toContainEqual(["/w/dl", true]);
  expect(seen).toContainEqual(["/w/a.png", false]);
  // Not boxed: exactly as before.
  for (const c of [cmd("Page.navigate", { url: "file:///etc/passwd" }), cmd("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: "/h/.fleetd" }), cmd("DOM.setFileInputFiles", { files: ["/h/.fleetd/x"] })]) {
    expect(refusal(plain, c)).toBeUndefined();
  }
  expect(refusal({ ...plain, boxed: () => undefined }, cmd("Page.navigate", { url: "file:///etc/passwd" }))).toBeUndefined();
});

test("a boxed session's paths: only this machine's files its box shows, links resolved, the box's own dirs and a hosted box's none", () => {
  const home = join(root, "home");
  const work = join(home, "work", "wt");
  const fleetd = join(home, ".fleetd");
  mkdirSync(join(fleetd, "node"), { recursive: true });
  mkdirSync(work, { recursive: true });
  mkdirSync(join(home, "readonly"), { recursive: true });
  writeFileSync(join(work, "a.png"), "x");
  writeFileSync(join(fleetd, "node", "node.json"), "{}");
  symlinkSync(join(fleetd, "node"), join(work, "sneaky"));
  const view: View = { home, hidden: [fleetd], shares: [{ path: work, rw: true }, { path: join(home, "readonly"), rw: false }] };
  const check = boxPaths(view);
  expect(check(join(work, "a.png"), false)).toBeUndefined();
  expect(check(join(work, "downloads", "new"), true)).toBeUndefined();
  expect(check(join(home, "elsewhere.txt"), false)).toBeUndefined();
  expect(check(join(fleetd, "node", "node.json"), false)).toContain("refused for uploads");
  expect(check(join(fleetd, "node"), true)).toContain("refused for downloads");
  expect(check(join(work, "sneaky", "node.json"), false)).toContain("refused");
  expect(check(join(work, "sneaky"), true)).toContain("refused");
  expect(check(join(work, "..", "..", ".fleetd", "node.json"), false)).toContain("refused");
  expect(check(join(home, "readonly", "f"), false)).toBeUndefined();
  expect(check(join(home, "readonly"), true)).toContain("writable");
  expect(check("/tmp/x.png", false)).toContain("the sandbox's own /tmp");
  expect(check("/etc/passwd", false)).toContain("the sandbox's own /etc");
  expect(check("a.png", false)).toContain("isn't an absolute path");
  expect(boxPaths(undefined)(join(work, "a.png"), false)).toContain("hosted sandbox");
});

test("SOCKS5: the greeting wants no authentication, a request is a CONNECT by IPv4, IPv6 or name", () => {
  expect(greeting(Buffer.from([5]))).toEqual({ more: true });
  expect(greeting(Buffer.from([5, 1, 2]))).toEqual({ refuse: true });
  expect(greeting(Buffer.from([4, 1, 0]))).toEqual({ refuse: true });
  expect(greeting(Buffer.from([5, 2, 2, 0, 9]))).toEqual({ rest: Buffer.from([9]) });
  const name = Buffer.from("localhost");
  expect(request(Buffer.concat([Buffer.from([5, 1, 0, 3, name.length]), name, Buffer.from([0x14, 0x45, 7])]))).toEqual({ host: "localhost", port: 5189, rest: Buffer.from([7]) });
  expect(request(Buffer.from([5, 1, 0, 1, 127, 0, 0, 1, 0, 80]))).toEqual({ host: "127.0.0.1", port: 80, rest: Buffer.alloc(0) });
  const v6 = Buffer.alloc(16);
  v6[15] = 1;
  expect(request(Buffer.concat([Buffer.from([5, 1, 0, 4]), v6, Buffer.from([1, 187])]))).toMatchObject({ host: "0:0:0:0:0:0:0:1", port: 443 });
  expect(request(Buffer.from([5, 2, 0, 1, 1, 2, 3, 4, 0, 80]))).toEqual({ refuse: 7 });
  expect(request(Buffer.from([5, 3, 0, 1, 1, 2, 3, 4, 0, 80]))).toEqual({ refuse: 7 });
  expect(request(Buffer.from([5, 1, 0, 9, 0, 0]))).toEqual({ refuse: 8 });
  expect(request(Buffer.from([5, 1, 0, 1, 1, 2]))).toEqual({ more: true });
  expect(replyFor("ECONNREFUSED")).toBe(5);
  expect(replyFor("ENOTFOUND")).toBe(4);
  expect(replyFor("the box's link is down")).toBe(1);
});

/** A SOCKS5 client's CONNECT to `host`:`port` through the proxy at `port0`: its socket and the reply code. */
async function socks(port0: number, host: string, port: number): Promise<{ s: Socket; code: number }> {
  const s = connect({ host: "127.0.0.1", port: port0 });
  await new Promise((r) => s.once("connect", r));
  const read = (n: number) =>
    new Promise<Buffer>((resolve) => {
      let got = Buffer.alloc(0);
      const on = (c: Buffer) => {
        got = Buffer.concat([got, c]);
        if (got.length >= n) {
          s.off("data", on);
          s.pause();
          if (got.length > n) s.unshift(got.subarray(n));
          resolve(got.subarray(0, n));
        }
      };
      s.on("data", on);
      s.resume();
    });
  s.write(Buffer.from([5, 1, 0]));
  expect([...(await read(2))]).toEqual([5, 0]);
  const name = Buffer.from(host);
  const p = Buffer.alloc(2);
  p.writeUInt16BE(port);
  s.write(Buffer.concat([Buffer.from([5, 1, 0, 3, name.length]), name, p]));
  const reply = await read(10);
  return { s, code: reply[1]! };
}

async function server(host: string, answer: string): Promise<{ port: number; hits: () => number; close: () => void }> {
  let hits = 0;
  const srv: Server = createServer((c) => {
    hits++;
    c.once("data", () => c.end(`HTTP/1.1 200 OK\r\ncontent-type: text/html\r\ncontent-length: ${answer.length}\r\nconnection: close\r\n\r\n${answer}`));
  });
  await new Promise<void>((r) => srv.listen(0, host, () => r()));
  return { port: (srv.address() as { port: number }).port, hits: () => hits, close: () => srv.close() };
}

test("the proxy makes each connection through the dial it was given, and says why one was refused", async () => {
  const inside = await server("127.0.0.2", "inside");
  cleanups.push(inside.close);
  const dialled: string[] = [];
  const egress = await Egress.start(async (host, port) => {
    dialled.push(`${host}:${port}`);
    if (host !== "localhost") throw new Error("ECONNREFUSED");
    return new Promise<Duplex>((resolve, reject) => {
      const c = connect({ host: "127.0.0.2", port: inside.port });
      c.once("connect", () => resolve(c)).once("error", reject);
    });
  });
  cleanups.push(() => egress.close());
  expect(egress.url).toBe(`socks5://127.0.0.1:${egress.port}`);
  const ok = await socks(egress.port, "localhost", 5173);
  expect(ok.code).toBe(0);
  ok.s.write("GET / HTTP/1.1\r\nhost: x\r\n\r\n");
  const parts: Buffer[] = [];
  for await (const c of ok.s) parts.push(c as Buffer);
  const body = Buffer.concat(parts).toString();
  expect(body.endsWith("inside")).toBe(true);
  const no = await socks(egress.port, "127.0.0.1", 4790);
  expect(no.code).toBe(5);
  no.s.destroy();
  expect(dialled).toEqual(["localhost:5173", "127.0.0.1:4790"]);
});

test("a box dials from inside: its own loopback answers, a closed port is refused in the guest's words", async () => {
  const dir = join(root, "g1");
  mkdirSync(dir);
  const sock = join(dir, "link.sock");
  const proc = Bun.spawn([process.execPath, MAIN, "sandbox-guest", "--listen", sock, "--dir", join(root, "hosts"), "--loopback", "127.0.0.2"], { stdio: ["ignore", "ignore", "inherit"] });
  procs.push(proc);
  for (let i = 0; !existsSync(sock); i++) {
    if (i > 500) throw new Error("the guest didn't listen");
    await Bun.sleep(10);
  }
  const dial = () => new Promise<Duplex>((resolve, reject) => {
    const s = connect(sock);
    s.once("connect", () => resolve(s)).once("error", reject);
  });
  const box = await Box.open({ session: "s-dial", dial, nodeSock: join(dir, "node.sock"), tcp: [], lead: noLead });
  cleanups.push(() => box.close());
  const inside = await server("127.0.0.2", "from the box");
  cleanups.push(inside.close);
  const far = await box.dial("127.0.0.2", inside.port);
  far.write("GET / HTTP/1.1\r\nhost: x\r\n\r\n");
  const chunks: Buffer[] = [];
  for await (const c of far) chunks.push(c as Buffer);
  expect(Buffer.concat(chunks).toString().endsWith("from the box")).toBe(true);
  const closed = await server("127.0.0.2", "");
  closed.close();
  await Bun.sleep(20);
  await expect(box.dial("127.0.0.2", closed.port)).rejects.toThrow("ECONNREFUSED");
  await expect(box.dial("", 1)).rejects.toThrow("a dial needs a host and a port");
}, 20_000);

test("a guest from before dials refuses one plainly, and a channel it opens in the node's range is refused", async () => {
  const dir = join(root, "old");
  mkdirSync(dir);
  const sock = join(dir, "link.sock");
  let guest!: Mux;
  const opened: number[] = [];
  const srv = createServer((s) => {
    guest = new Mux(s, {
      control: (m) => guest.control({ id: m.id, ok: null }),
      open: () => undefined,
      closed: () => {},
    });
    guest.control({ op: "hello", protocol: GUEST_PROTOCOL, host: null });
  });
  await new Promise<void>((r) => srv.listen(sock, () => r()));
  cleanups.push(() => void srv.close());
  const dial = () => new Promise<Duplex>((resolve, reject) => {
    const s = connect(sock);
    s.once("connect", () => resolve(s)).once("error", reject);
  });
  const box = await Box.open({ session: "s-old", dial, nodeSock: join(dir, "node.sock"), tcp: [7], lead: noLead });
  cleanups.push(() => box.close());
  await expect(box.dial("localhost", 80)).rejects.toThrow("a guest from before dials");
  // The guest's side opening a channel numbered as the node's: ended at once, never piped anywhere.
  const end = new Duplex({ read() {}, write: (_c, _e, cb) => cb(), final: (cb) => (opened.push(1), cb()) });
  guest.open(NODE_CHANNELS + 5, { tcp: 7 }, end);
  for (let i = 0; i < 100 && !opened.length; i++) await Bun.sleep(10);
  expect(opened).toEqual([1]);
});

test("a boxed session's Chrome flags send everything through the proxy, loopback too; a plain one has none", () => {
  const flags = boxedArgs("socks5://127.0.0.1:9");
  expect(flags).toContain("--proxy-server=socks5://127.0.0.1:9");
  expect(flags).toContain("--proxy-bypass-list=<-loopback>");
  expect(flags).toContain("--disable-quic");
  expect(flags).toContain("--force-webrtc-ip-handling-policy=disable_non_proxied_udp");
  const a = chromeArgs("/x/chrome-headless-shell", "/p", true, flags);
  expect(a.at(-1)).toBe("about:blank");
  expect(a).toContain("--proxy-bypass-list=<-loopback>");
  expect(chromeArgs("/x/chrome-headless-shell", "/p", true).some((f) => f.startsWith("--proxy") || f.startsWith("--host-resolver"))).toBe(false);
});

test.skipIf(!chrome)("a real Chrome from the node's own pool, for a boxed session: localhost is the box's, nothing reaches this machine around the proxy", async () => {
  // The box's dev server, at 127.0.0.2 (inside), and this machine's own service at the same port on 127.0.0.1.
  const inside = await server("127.0.0.2", "<title>box</title>box");
  const host = createServer((c) => c.destroy());
  await new Promise<void>((r) => host.listen(inside.port, "127.0.0.1", () => r()));
  let hostHits = 0;
  host.on("connection", () => hostHits++);
  cleanups.push(inside.close, () => void host.close());
  const t = testNode();
  const broker = start(t.node, new Broker(t.node, undefined, { warm: 0 }));
  cleanups.push(async () => {
    await broker.shutdown();
    t.done();
  });
  broker.ready(chrome!);
  const dialled: string[] = [];
  broker.boxed = () => ({
    dial: async (name, port) => {
      dialled.push(`${name}:${port}`);
      // The box's loopback; anything else is out of its reach here.
      if (name !== "localhost" && name !== "127.0.0.1") throw new Error("EHOSTUNREACH");
      return new Promise<Duplex>((resolve, reject) => {
        const c = connect({ host: "127.0.0.2", port });
        c.once("connect", () => resolve(c)).once("error", reject);
      });
    },
  });
  const started = (await t.local.call("session_start", { purpose: "p" }, "boxed")) as { cdp: string };
  const ws = new WebSocket(started.cdp);
  const got: Record<string, unknown>[] = [];
  ws.onmessage = (e) => got.push(JSON.parse(String(e.data)));
  await new Promise((r) => (ws.onopen = r));
  cleanups.push(() => ws.close());
  let next = 0;
  const call = async (method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<Record<string, unknown>> => {
    const id = ++next;
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    for (const until = Date.now() + 10_000; Date.now() < until; await Bun.sleep(20)) {
      const a = got.find((m) => m.id === id);
      if (a) return a;
    }
    throw new Error(`no answer to ${method}`);
  };
  const targets = (await call("Target.getTargets")) as { result: { targetInfos: { targetId: string; type: string }[] } };
  const page = targets.result.targetInfos.find((x) => x.type === "page")!;
  const s = ((await call("Target.attachToTarget", { targetId: page.targetId, flatten: true })) as { result: { sessionId: string } }).result.sessionId;
  const title = async () => ((await call("Runtime.evaluate", { expression: "document.title", returnByValue: true }, s)) as { result: { result: { value: string } } }).result.result.value;
  for (const url of [`http://localhost:${inside.port}/`, `http://127.0.0.1:${inside.port}/`]) {
    await call("Page.navigate", { url }, s);
    let seen = "";
    for (const until = Date.now() + 10_000; seen !== "box" && Date.now() < until; ) {
      seen = await title();
      if (seen !== "box") await Bun.sleep(50);
    }
    expect(seen).toBe("box");
  }
  expect(await call("Page.navigate", { url: "file:///etc/passwd" }, s)).toMatchObject({ error: { message: expect.stringContaining("file: URLs are refused") } });
  // A page's websocket and fetch go the same way.
  await call("Runtime.evaluate", { expression: `new WebSocket("ws://localhost:${inside.port}/ws"); fetch("http://10.9.8.7:81/").catch(() => {}); 1` }, s);
  for (const until = Date.now() + 5_000; !dialled.includes("10.9.8.7:81") && Date.now() < until; ) await Bun.sleep(50);
  expect(dialled).toContain("10.9.8.7:81");
  expect(dialled.filter((d) => d === `localhost:${inside.port}`).length).toBeGreaterThanOrEqual(2);
  expect(hostHits).toBe(0);
}, 60_000);

/** A browser that answers every command with its method, and has one page (node-browser.test.ts's). */
function fakeBrowser(): Transport {
  let deliver: (text: string) => void = () => {};
  let attaches = 0;
  return {
    send(text) {
      const m = JSON.parse(text) as { id: number; method: string };
      const result =
        m.method === "Target.getTargets"
          ? { targetInfos: [{ targetId: "P1", type: "page", url: "about:blank" }] }
          : m.method === "Target.attachToTarget"
            ? { sessionId: ++attaches === 1 ? "broker-s" : "driver-s" }
            : { echo: m.method };
      queueMicrotask(() => deliver(JSON.stringify({ id: m.id, result })));
      return true;
    },
    onMessage: (fn) => (deliver = fn),
    onClose: () => {},
    close: () => {},
  };
}

test("a boxed agent's session starts on a fresh Chrome through its box, refuses local URLs, and its proxy ends with it", async () => {
  const t = testNode();
  const launches: (string[] | undefined)[] = [];
  const broker = start(t.node, new Broker(t.node, async (_kept, extra) => (launches.push(extra), { cdp: new Cdp(fakeBrowser()) })));
  cleanups.push(async () => {
    await broker.shutdown();
    t.done();
  });
  const dialled: string[] = [];
  broker.boxed = (thread) =>
    thread === "boxed"
      ? { dial: async (host, port) => (dialled.push(`${host}:${port}`), Promise.reject(new Error("ECONNREFUSED"))), view: { home: "/h", hidden: [], shares: [] } }
      : thread === "booting"
        ? "starting"
        : undefined;
  await expect(t.local.call("session_start", { purpose: "p" }, "booting")).rejects.toThrow("still starting");
  // Not boxed: the pool's browser, no flags, no checks of its own.
  const plainStart = (await t.local.call("session_start", { purpose: "p" }, "plain")) as { cdp: string };
  expect(launches).toEqual([undefined]);
  const started = (await t.local.call("session_start", { purpose: "p" }, "boxed")) as { cdp: string };
  const flags = launches.at(-1)!;
  expect(flags).toContain("--proxy-bypass-list=<-loopback>");
  const proxyPort = Number(/127\.0\.0\.1:(\d+)$/u.exec(flags.find((f) => f.startsWith("--proxy-server="))!)![1]);
  const ask = async (url: string, method: string, params: Record<string, unknown>) => {
    const ws = new WebSocket(url);
    await new Promise((r) => (ws.onopen = r));
    const answer = new Promise<Record<string, unknown>>((r) => (ws.onmessage = (e) => r(JSON.parse(String(e.data)))));
    ws.send(JSON.stringify({ id: 1, method, params }));
    const got = await answer;
    ws.close();
    return got;
  };
  expect(await ask(started.cdp, "Page.navigate", { url: "file:///etc/passwd" })).toMatchObject({ error: { message: expect.stringContaining("file: URLs are refused") } });
  expect(await ask(started.cdp, "DOM.setFileInputFiles", { files: ["/tmp/x"], nodeId: 1 })).toMatchObject({ error: { message: expect.stringContaining("/tmp") } });
  expect(await ask(started.cdp, "Page.navigate", { url: "http://localhost:5173/" })).toMatchObject({ result: { echo: "Page.navigate" } });
  expect(await ask(plainStart.cdp, "Page.navigate", { url: "file:///etc/passwd" })).toMatchObject({ result: { echo: "Page.navigate" } });
  // Its proxy goes through the box's dial while the session lives, and is gone once it ends.
  const through = await socks(proxyPort, "localhost", 5173);
  expect(through.code).toBe(5);
  through.s.destroy();
  expect(dialled).toEqual(["localhost:5173"]);
  await t.local.call("session_end", {}, "boxed");
  const after = connect({ host: "127.0.0.1", port: proxyPort });
  expect(await new Promise((r) => after.once("connect", () => r("open")).once("error", () => r("closed")))).toBe("closed");
  after.destroy();
});

test("a boxed agent's browser stays on its own node, which alone reaches its box, wherever the hub would place it", async () => {
  const t = testNode();
  const routes: Record<string, unknown>[] = [];
  t.link.answer = async (op, args) => {
    if (op === "session_route") routes.push(args);
    return op === "session_route" ? { runner: "box2", here: false, sealTo: "AAAA" } : {};
  };
  const broker = start(t.node, new Broker(t.node, async () => ({ cdp: new Cdp(fakeBrowser()) })));
  startRoute(t.node, new Router(t.node, broker, new NodeBoxKey(crypto.getRandomValues(new Uint8Array(32)))));
  cleanups.push(async () => {
    await broker.shutdown();
    t.done();
  });
  broker.boxed = (thread) => (thread === "boxed" ? { dial: async () => Promise.reject(new Error("ECONNREFUSED")) } : undefined);
  const started = (await t.local.call("session_start", { purpose: "p" }, "boxed")) as { sessionId: string };
  expect(broker.live("boxed")?.id).toBe(started.sessionId);
  expect(routes).toEqual([]);
  // Another agent's goes where the hub says.
  await t.local.call("session_start", { purpose: "p" }, "plain").catch(() => {});
  expect(routes.length).toBeGreaterThan(0);
  expect(broker.live("plain")).toBeUndefined();
});

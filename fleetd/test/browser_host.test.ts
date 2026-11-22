// The browser broker with no node around it (src/node/browser/broker.ts): what it needs comes in as a BrokerHost (the
// hub's calls, a recording store, the proxy's key, the box), as fleetd cloud gives it. Its Chrome runs in a box: here
// a stand-in Chrome on a port of this machine, which the stand-in box's dial reaches, and which outlives a dropped
// connection as a box's does (src/node/place/box_chrome.ts). The driver reaches it only through the broker's proxy, as
// an agent's agent-browser does. The last test runs the box's real launcher (sh, socat) on a real Chrome, where this
// machine has both.
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { connect, createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import type { Duplex } from "node:stream";
import { createHmac } from "node:crypto";
import { type BrokerHost, BrowserBroker, type BrowserSnapshot } from "../src/node/browser/broker.ts";
import { Proxy } from "../src/node/browser/cdp_proxy.ts";
import { seal } from "../src/node/browser/credentials.ts";
import type { Meta, Recording, RecordingStore } from "../src/node/browser/recording.ts";
import type { Scrub } from "../src/node/mask.ts";
import { boxChrome, reattachChrome, type ScreenBox, timing } from "../src/node/place/box_chrome.ts";
import { pluginFiles } from "../src/node/browser/agent_browser_plugin.ts";
import { chrome as realChrome } from "./browser_rig.ts";

const THREAD = "t-cloud";
const SECRET = "hunter2-correct-horse";
const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

/** A Chrome on a port of this machine: one connection at a time, its pages and sessions kept across connections, as a
 * box's Chrome keeps them behind its FIFOs; and like them, what a connection left of a frame waits for the next. A
 * frame that isn't JSON (an empty one, or one cut short with another's start) is answered by no command. */
async function standInChrome() {
  let current: Socket | undefined;
  let nextSession = 1;
  const seen: { conn: number; id: number; method: string }[] = [];
  const unread: string[] = [];
  const typed: string[] = [];
  let conns = 0;
  let buffered = Buffer.alloc(0);
  const server: Server = createServer((socket) => {
    current?.destroy();
    current = socket;
    const conn = ++conns;
    socket.on("error", () => {});
    socket.on("data", (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      for (let at = buffered.indexOf(0); at >= 0; at = buffered.indexOf(0)) {
        const text = buffered.subarray(0, at).toString();
        buffered = buffered.subarray(at + 1);
        let m: { id: number; method: string; sessionId?: string; params?: { text?: string } };
        try {
          m = JSON.parse(text) as typeof m;
        } catch {
          unread.push(text);
          continue;
        }
        seen.push({ conn, id: m.id, method: m.method });
        if (m.method === "Input.insertText") typed.push(String(m.params?.text));
        const page = "https://shop.test/login";
        // A login page with one text field, `#pw`, for a secure input to type into.
        const field: Record<string, unknown> = {
          "Target.getTargetInfo": { targetInfo: { targetId: "P1", type: "page", url: page } },
          "Page.getFrameTree": { frameTree: { frame: { id: "F1", url: page } } },
          "Page.createIsolatedWorld": { executionContextId: 3 },
          "Runtime.evaluate": { result: { type: "object", objectId: "O1" } },
          "Runtime.callFunctionOn": { result: { type: "object", value: { field: true, url: page } } },
          "DOM.describeNode": { node: { backendNodeId: 42 } },
        };
        const result =
          m.method in field
            ? field[m.method]
            : m.method === "Target.getTargets"
            ? { targetInfos: [{ targetId: "P1", type: "page", url: "https://shop.test/login" }] }
            : m.method === "Target.attachToTarget"
              ? { sessionId: `S${nextSession++}` }
              : m.method === "Page.printToPDF"
                ? { data: Buffer.from(SECRET).toString("base64") }
                : m.method === "Browser.getVersion"
                  ? { product: "StandIn/1" }
                  : {};
        socket.write(`${JSON.stringify({ id: m.id, result, ...(m.sessionId ? { sessionId: m.sessionId } : {}) })}\0`);
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as { port: number }).port;
  cleanups.push(() => {
    current?.destroy();
    server.close();
  });
  return {
    port,
    seen,
    unread,
    /** What the broker typed into the page (Input.insertText). */
    typed,
    connections: () => conns,
    /** The connection drops, as when the box's link redials or the instance driving it goes. */
    drop: () => current?.destroy(),
    /** Chrome goes for good: no new connection is taken. */
    gone: () => {
      current?.destroy();
      server.close();
    },
  };
}

/** A box whose dial reaches this machine's loopback, and which runs nothing. */
function standInBox(): ScreenBox & { dials: number[] } {
  const dials: number[] = [];
  return {
    dials,
    run: async () => ({ exitCode: 0, outputTail: "", timedOut: false }),
    write: async () => {},
    dial: (_host, port) =>
      new Promise<Duplex>((resolve, reject) => {
        dials.push(port);
        const s = connect(port, "127.0.0.1");
        s.once("connect", () => resolve(s)).once("error", reject);
      }),
  };
}

/** A recording store that keeps everything in memory: each recording's lines, and how it ended. */
function memoryStore() {
  const recordings: { meta: Meta; lines: [string, string][]; ended?: { note?: string; scrubbed: string[] } }[] = [];
  const store: RecordingStore = {
    open: async (meta) => {
      const r: (typeof recordings)[number] = { meta, lines: [] };
      recordings.push(r);
      const rec: Recording = {
        key: meta.sessionId,
        note: "no video here",
        append: (file, line) => void r.lines.push([file, line]),
        filled: () => {},
        end: async (ended, scrub: Scrub) => {
          r.ended = { ...(ended.note ? { note: ended.note } : {}), scrubbed: r.lines.map(([, l]) => scrub.text(l)) };
          return { files: [{ file: "actions", bytes: r.lines.length }], note: ended.note ?? "no video here" };
        },
      };
      return rec;
    },
  };
  return { store, recordings };
}

const KEY = "5e".repeat(32);

/** A broker as a service with no node runs one: every session's Chrome in its box, everything else given. */
function cloudBroker(
  box: ScreenBox | undefined,
  chromePort: number,
  store: RecordingStore,
  proxyKey: string | undefined = KEY,
  answers: Record<string, Record<string, unknown>> = {},
) {
  const calls: { op: string; args: Record<string, unknown> }[] = [];
  const policies: [string, string][] = [];
  const changed: string[] = [];
  const host: BrokerHost = {
    call: async (op, args) => {
      calls.push({ op, args });
      return answers[op] ?? {};
    },
    send: () => {},
    secrets: () => [],
    boxKey: () => ({ open: () => null }),
    recordings: store,
    policy: async (thread, text) => void policies.push([thread, text]),
    ...(proxyKey ? { proxyKey } : {}),
    boxed: (thread) => (thread === THREAD && box ? { box } : undefined),
    changed: (thread) => void changed.push(thread),
  };
  const broker = new BrowserBroker(host);
  broker.inBox = async (b) => {
    const launched = await reattachChrome(b, { dir: "/tmp/fleetd-browser-standin", port: chromePort }, 1);
    return { ...launched, close: async () => launched.cdp.shut() };
  };
  cleanups.push(() => broker.shutdown());
  return { broker, calls, policies, changed };
}

/** The agent's agent-browser: a CDP websocket to the broker's proxy, each command's answer by its id. */
async function driver(url: string) {
  const ws = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error("the proxy refused the driver"));
  });
  const answers = new Map<number, (m: Record<string, unknown>) => void>();
  ws.onmessage = (e) => {
    const m = JSON.parse(String(e.data)) as { id?: number };
    if (typeof m.id === "number") answers.get(m.id)?.(m as Record<string, unknown>);
  };
  let next = 1;
  cleanups.push(() => ws.close());
  return {
    send: (method: string, params: Record<string, unknown> = {}, sessionId?: string) =>
      new Promise<Record<string, unknown>>((resolve) => {
        const id = next++;
        answers.set(id, resolve);
        ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      }),
  };
}

const errorOf = (m: Record<string, unknown>) => (m.error as { message?: string } | undefined)?.message;

async function until(ok: () => boolean, what: string, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(10);
  }
}

test("a broker with no node home: its policy, its recording and its reports go where its host says, nothing to the hub's pieces", async () => {
  const chrome = await standInChrome();
  const { store, recordings } = memoryStore();
  const { broker, calls, policies } = cloudBroker(standInBox(), chrome.port, store);
  const started = (await broker.call(THREAD, { id: "1", cwd: "/", call: { op: "session_start", purpose: "sign in" } as never })) as unknown as { sessionId: string; cdp: string };
  expect(started.cdp).toBe(broker.proxy.url(THREAD));
  // The box's port the agent reaches the proxy at, where it isn't the proxy's own.
  expect(broker.proxy.url(THREAD, 9222)).toStartWith("ws://127.0.0.1:9222/devtools/browser/t-cloud.");
  expect(policies).toEqual([[THREAD, `${JSON.stringify({ default: "allow", deny: ["connect"] })}\n`]]);
  const session = broker.live(THREAD)!;
  seal(broker, session, "password", SECRET);
  broker.filledMeta(session);
  session.stepAt("fill_credential", { typed: SECRET }, true, undefined, 0);
  broker.item(THREAD, {
    id: "i1",
    kind: { type: "command", command: "agent-browser click @e1", output: "done", exitCode: 0 },
    status: "completed",
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
  } as never);
  const ended = (await broker.call(THREAD, { id: "2", cwd: "/", call: { op: "session_end" } as never })) as unknown as { files: unknown[]; note?: string };
  expect(ended.files).toEqual([{ file: "actions", bytes: 2 }]);
  expect(ended.note).toBe("no video here");
  const [r] = recordings;
  expect(r!.meta).toMatchObject({ sessionId: started.sessionId, kind: "browser", threadId: THREAD });
  // The store gets each line scrubbed as it comes, and the whole once more at the end.
  expect(r!.lines.map(([f]) => f)).toContain("actions");
  expect(r!.ended!.scrubbed.join("\n")).not.toContain(SECRET);
  expect(policies.at(-1)![1]).toContain("evaluate");
  const ops = calls.map((c) => c.op);
  expect(ops).toContain("browser_session");
  expect(ops).not.toContain("browser_recording_part");
  expect(calls.find((c) => c.op === "browser_session")!.args).toMatchObject({ state: "live", sessionId: started.sessionId });
});

test("a session survives a dropped and re-made connection to its box's Chrome, its read-back refusal still in force", async () => {
  const chrome = await standInChrome();
  const { store, recordings } = memoryStore();
  const { broker, calls } = cloudBroker(standInBox(), chrome.port, store);
  const started = (await broker.call(THREAD, { id: "1", cwd: "/", call: { op: "session_start" } as never })) as unknown as { sessionId: string; cdp: string };
  const session = broker.live(THREAD)!;
  seal(broker, session, "password", SECRET);
  const agent = await driver(started.cdp);
  expect(errorOf(await agent.send("Page.printToPDF"))).toContain("is off in this browser session");

  chrome.drop();
  await until(() => chrome.connections() === 2 && chrome.seen.some((s) => s.conn === 2 && s.method === "Page.startScreencast"), "the redial");
  // The same session, sealed as before, on the new connection: a read-back is still refused, a click still goes.
  expect(broker.live(THREAD)).toBe(session);
  expect(session.id).toBe(started.sessionId);
  expect(errorOf(await agent.send("Page.printToPDF"))).toContain("is off in this browser session");
  expect(errorOf(await agent.send("Runtime.evaluate", { expression: "document.querySelector('input').value" }))).toContain("This script is refused");
  expect(await agent.send("Input.dispatchMouseEvent", { type: "mousePressed", x: 1, y: 1 })).toMatchObject({ result: {} });
  expect(chrome.seen.filter((s) => s.method === "Page.printToPDF")).toEqual([]);
  // The broker's own session on the page stays its own: the driver may not name it.
  expect(errorOf(await agent.send("Page.enable", {}, "S1"))).toBe("No session with given id");
  // The new connection's ids never meet an answer the old one left in flight.
  expect(Math.min(...chrome.seen.filter((s) => s.conn === 2).map((s) => s.id))).toBeGreaterThan(200_000_000);
  // Nothing ended: one recording, still open, and no report but live.
  expect(recordings.length).toBe(1);
  expect(recordings[0]!.ended).toBeUndefined();
  expect(calls.filter((c) => c.op === "browser_session").map((c) => c.args.state)).toEqual(["live"]);
});

test("a Chrome that takes no new connection within its grace: the session ends with a plain note and its recording", async () => {
  const was = timing.graceMs;
  timing.graceMs = 300;
  cleanups.push(() => void (timing.graceMs = was));
  const chrome = await standInChrome();
  const { store, recordings } = memoryStore();
  const { broker } = cloudBroker(standInBox(), chrome.port, store);
  await broker.call(THREAD, { id: "1", cwd: "/", call: { op: "session_start" } as never });
  chrome.gone();
  await until(() => recordings[0]?.ended !== undefined, "the session's end");
  expect(broker.live(THREAD)).toBeUndefined();
  expect(recordings[0]!.ended!.note).toStartWith("the browser in the box went: ");
});

test("a session_start while the agent session's browser is being taken over is refused, and no second browser opens", async () => {
  const chrome = await standInChrome();
  const box = standInBox();
  const first = cloudBroker(box, chrome.port, memoryStore().store);
  const started = (await first.broker.call(THREAD, { id: "1", cwd: "/", call: { op: "session_start", purpose: "pay" } as never })) as unknown as { sessionId: string };
  const snapshot = JSON.parse(JSON.stringify(first.broker.snapshot(THREAD))) as BrowserSnapshot;
  first.broker.letGo();
  const b = memoryStore();
  const second = cloudBroker(box, chrome.port, b.store);
  let launched = 0;
  const inBox = second.broker.inBox;
  second.broker.inBox = async (given, profile) => {
    launched++;
    return inBox(given, profile);
  };
  let reached!: () => void;
  const gate = new Promise<void>((r) => (reached = r));
  second.broker.reattach = async (given, handle, firstId, ms) => {
    await gate;
    return reattachChrome(given, handle, firstId, ms);
  };
  const adopting = second.broker.adopt(THREAD, snapshot);
  await expect(second.broker.call(THREAD, { id: "2", cwd: "/", call: { op: "session_start", purpose: "another" } as never })).rejects.toThrow(
    "Your browser session is starting already.",
  );
  await expect(second.broker.adopt(THREAD, snapshot)).rejects.toThrow("being taken over here already");
  reached();
  expect(await adopting).toEqual({ adopted: true, sessionId: started.sessionId });
  expect(launched).toBe(0);
  expect(second.broker.live(THREAD)!.id).toBe(started.sessionId);
  expect(b.recordings.length).toBe(1);
});

test("another holder adopts a session from its snapshot: the same session, sealed, recording on; one whose Chrome went ends plainly", async () => {
  const chrome = await standInChrome();
  const box = standInBox();
  const a = memoryStore();
  const first = cloudBroker(box, chrome.port, a.store);
  const started = (await first.broker.call(THREAD, { id: "1", cwd: "/", call: { op: "session_start", purpose: "pay" } as never })) as unknown as { sessionId: string };
  const session = first.broker.live(THREAD)!;
  seal(first.broker, session, "password", SECRET);
  const snapshot = JSON.parse(JSON.stringify(first.broker.snapshot(THREAD))) as BrowserSnapshot;
  expect(snapshot.session.credentialsFilled).toBe(1);
  // The holder stops: its connection drops, nothing is ended or reported.
  const reportsBefore = first.calls.length;
  first.broker.letGo();
  expect(first.calls.length).toBe(reportsBefore);
  expect(a.recordings[0]!.ended).toBeUndefined();

  const b = memoryStore();
  const second = cloudBroker(box, chrome.port, b.store);
  expect(await second.broker.adopt(THREAD, snapshot)).toEqual({ adopted: true, sessionId: started.sessionId });
  expect(b.recordings[0]!.meta).toMatchObject({ sessionId: started.sessionId, resumed: true });
  // The proxy signs with the key the host gives: the agent's URL is the one it had.
  const agent = await driver(second.broker.proxy.url(THREAD));
  expect(errorOf(await agent.send("Page.printToPDF"))).toContain("is off in this browser session");
  expect(errorOf(await agent.send("Page.enable", {}, "S1"))).toBe("No session with given id");
  expect(second.broker.live(THREAD)!.scrub().text(`typed ${SECRET}`)).not.toContain(SECRET);
  expect(second.calls.filter((c) => c.op === "browser_session").map((c) => c.args.state)).toEqual(["live"]);

  // A third holder finds Chrome gone: the session ends, recorded with a note, and nobody is left holding control.
  const again = JSON.parse(JSON.stringify(second.broker.snapshot(THREAD))) as BrowserSnapshot;
  second.broker.letGo();
  chrome.gone();
  const c = memoryStore();
  const third = cloudBroker(box, chrome.port, c.store);
  const was = timing.upMs;
  timing.upMs = 300;
  cleanups.push(() => void (timing.upMs = was));
  const lost = await third.broker.adopt(THREAD, again);
  expect(lost.adopted).toBe(false);
  expect(c.recordings[0]!.ended!.note).toContain("while it moved to another server");
  expect(c.recordings[0]!.ended!.scrubbed.join("\n")).not.toContain(SECRET);
  expect(third.broker.live(THREAD)).toBeUndefined();
});

// The box's own launcher, on this machine as its "box": sh runs the scripts, dial reaches its loopback.
const hasSocat = Bun.which("socat") !== null && Bun.which("mkfifo") !== null;
test.skipIf(!realChrome || !hasSocat)("a box's Chrome outlives its dropped connection within its grace, and goes after it", async () => {
  const was = timing.graceMs;
  timing.graceMs = 2_000;
  cleanups.push(() => void (timing.graceMs = was));
  const root = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "fleetd-boxchrome-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const here: ScreenBox = {
    run: async (r) => {
      const p = Bun.spawn(r.argv, { cwd: root, env: { ...process.env, ...r.env }, stdout: "pipe", stderr: "pipe" });
      const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
      return { exitCode: await p.exited, outputTail: `${out}${err}`, timedOut: false };
    },
    write: async (path, bytes, mode) => {
      await Bun.write(path, bytes);
      Bun.spawnSync(["chmod", (mode ?? 0o600).toString(8), path]);
    },
    dial: (_h, port) =>
      new Promise<Duplex>((resolve, reject) => {
        const s = connect(port, "127.0.0.1");
        s.once("connect", () => resolve(s)).once("error", reject);
      }),
  };
  const first = await boxChrome(here, [], { chrome: realChrome!, dir: join(root, "chrome") });
  const handle = first.handle!;
  cleanups.push(() => first.close?.());
  const { targetInfos } = (await first.cdp.call(undefined, "Target.getTargets")) as { targetInfos: { targetId: string }[] };
  first.cdp.shut();
  const second = await reattachChrome(here, handle, 200_000_001);
  const after = (await second.cdp.call(undefined, "Target.getTargets")) as { targetInfos: { targetId: string }[] };
  expect(after.targetInfos.map((t) => t.targetId)).toEqual(targetInfos.map((t) => t.targetId));
  second.cdp.shut();
  const letGo = Date.now();
  // No connection within its grace: its launcher's whole session goes, Chrome with it. Waited for, however long a loaded
  // machine takes to get there, never before the grace is out.
  const launcher = Number(readFileSync(join(handle.dir, "session.pid"), "utf8"));
  const alive = () => {
    try {
      process.kill(launcher, 0);
      return true;
    } catch {
      return false;
    }
  };
  for (const end = Date.now() + 10 * timing.graceMs; alive() && Date.now() < end; ) await Bun.sleep(50);
  expect(alive()).toBe(false);
  expect(Date.now() - letGo).toBeGreaterThanOrEqual(timing.graceMs);
  await expect(reattachChrome(here, handle, 400_000_001, 500)).rejects.toThrow();
}, 30_000);

test("the proxy signs with a key nobody can guess: a host's own, else a random one, and never an empty or short one", async () => {
  expect(() => Proxy.serve("", { live: () => undefined })).toThrow("64 hex characters");
  expect(() => Proxy.serve("ab", { live: () => undefined })).toThrow("64 hex characters");
  const chrome = await standInChrome();
  const { store } = memoryStore();
  const { broker } = cloudBroker(standInBox(), chrome.port, store);
  expect(broker.proxy.url(THREAD)).toEndWith(`${THREAD}.${createHmac("sha256", KEY).update(THREAD).digest("hex")}`);
  const keyless = cloudBroker(standInBox(), chrome.port, store, undefined).broker;
  await keyless.call(THREAD, { id: "1", cwd: "/", call: { op: "session_start" } as never });
  // The token an agent could compute without the key is refused; the broker's own is let through.
  const forged = `ws://127.0.0.1:${keyless.proxy.port}/devtools/browser/${THREAD}.${createHmac("sha256", "").update(THREAD).digest("hex")}`;
  const refused = await fetch(forged.replace("ws://", "http://"), { headers: { upgrade: "websocket" } });
  expect(refused.status).toBe(403);
  expect(keyless.proxy.url(THREAD)).not.toBe(forged);
  await driver(keyless.proxy.url(THREAD));
});

test("a connection that dropped mid-frame doesn't swallow the next one's first command: the box's Chrome is reached again", async () => {
  const was = timing.upMs;
  timing.upMs = 500;
  cleanups.push(() => void (timing.upMs = was));
  const chrome = await standInChrome();
  const box = standInBox();
  // The last connection's command, cut short by the drop: its start waits in the pipe.
  const cut = await box.dial("127.0.0.1", chrome.port);
  await new Promise<void>((resolve) => cut.end('{"id":7,"method":"Input.dispatchMou', () => resolve()));
  await new Promise((resolve) => cut.once("close", resolve));
  expect(chrome.connections()).toBe(1);
  const again = await reattachChrome(box, { dir: "/tmp/fleetd-browser-standin", port: chrome.port }, 200_000_001);
  cleanups.push(() => again.cdp.shut());
  expect(chrome.unread).toEqual(['{"id":7,"method":"Input.dispatchMou']);
  expect(chrome.seen.map((s) => s.method)).toEqual(["Browser.getVersion"]);
});

test("a secure input a person was asked for survives a takeover: the new holder types it in once, and nobody sees it", async () => {
  const chrome = await standInChrome();
  const box = standInBox();
  const asked = { secure_input_open: { requestId: "R1", state: "open" } };
  const a = memoryStore();
  const first = cloudBroker(box, chrome.port, a.store, KEY, asked);
  // A bot's lead asks for a secure input (only a lead may).
  first.broker.lead(THREAD, "assistant", "bot-1");
  const started = (await first.broker.call(THREAD, { id: "1", cwd: "/", call: { op: "session_start" } as never })) as unknown as { sessionId: string };
  await first.broker.call(THREAD, { id: "2", cwd: "/", call: { op: "request_secure_input", site: { domain: "shop.test" }, target: "#pw", label: "the password" } as never });
  const waiting = JSON.parse(JSON.stringify(first.broker.snapshot(THREAD))) as BrowserSnapshot;
  // The request alone, where it types: no value is in a snapshot taken while it waits.
  expect(waiting.waiting).toEqual([{ requestId: "R1", domain: "shop.test", target: "#pw", label: "the password" }]);
  first.broker.letGo();

  const b = memoryStore();
  const second = cloudBroker(box, chrome.port, b.store, KEY, asked);
  second.broker.lead(THREAD, "assistant", "bot-1");
  expect(await second.broker.adopt(THREAD, waiting)).toMatchObject({ adopted: true });
  const frame = { id: "d1", sink: `fill:devbox:${started.sessionId}`, sealed: Buffer.from("sealed").toString("base64"), requestId: "R1" } as never;
  const key = { open: () => new TextEncoder().encode(SECRET) };
  expect(await second.broker.deliver(frame, key, "devbox")).toMatchObject({ id: "d1", fingerprint: expect.stringMatching(/^[0-9a-f]{8}$/) });
  expect(chrome.typed).toEqual([SECRET]);
  // Once: a second delivery finds nothing waiting.
  expect((await second.broker.deliver(frame, key, "devbox")).error).toContain("nothing waits for R1");
  expect(chrome.typed).toEqual([SECRET]);
  // The session is sealed now, and the value is kept only to scrub it with.
  const session = second.broker.live(THREAD)!;
  expect(session.sealed()).toBe(true);
  const after = second.broker.snapshot(THREAD)!;
  expect(after.waiting).toEqual([]);
  const where = (o: unknown, path: string[] = []): string[] =>
    typeof o === "string"
      ? o.includes(SECRET)
        ? [path.join(".")]
        : []
      : o && typeof o === "object"
        ? Object.entries(o).flatMap(([k, v]) => where(v, [...path, k]))
        : [];
  expect(where(after).map((p) => p.replace(/\.\d+(\.\d+)?$/, ""))).toEqual(["session.secrets", "filled"]);
  // The agent never hears it, and the recording keeps none of it.
  const agent = await driver(second.broker.proxy.url(THREAD));
  expect(errorOf(await agent.send("Page.printToPDF"))).toContain("is off in this browser session");
  await second.broker.call(THREAD, { id: "3", cwd: "/", call: { op: "session_end" } as never });
  expect(b.recordings[0]!.ended!.scrubbed.join("\n")).not.toContain(SECRET);
  expect(JSON.stringify(b.recordings[0]!.lines)).not.toContain(SECRET);
});

test("agent-browser's skill as a plugin's files, for a box's claude", () => {
  expect(pluginFiles("# agent-browser\n")).toEqual([
    { path: ".claude-plugin/plugin.json", text: `${JSON.stringify({ name: "agent-browser", description: "agent-browser's skill, for the browser session fleetd opens with session_start." })}\n` },
    { path: "skills/agent-browser/SKILL.md", text: "# agent-browser\n" },
  ]);
});

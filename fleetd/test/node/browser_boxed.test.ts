// A hosted agent's browser and its box's dial (src/node/sandbox/box.ts `dial`): connections the guest makes from inside
// the box, and the browser of an agent in a hosted box kept on its own node, which alone reaches the box. The box here is
// `fleetd sandbox-guest` as a process beside the test (its "inside" is 127.0.0.2), or the test speaking a guest's side of
// the link.
import { afterAll, afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { connect, createServer, type Server } from "node:net";
import { join } from "node:path";
import { Duplex } from "node:stream";
import { leadChannel, type LeadSocketHooks } from "../../src/node/lead/index.ts";
import { Box } from "../../src/node/sandbox/box.ts";
import { GUEST_PROTOCOL } from "../../src/node/sandbox/guest.ts";
import { Mux, NODE_CHANNELS } from "../../src/node/sandbox/mux.ts";
import type { ScreenBox } from "../../src/node/place/box_screens.ts";
import { Cdp, type Transport } from "../../src/node/browser/cdp.ts";
import { Broker, start } from "../../src/node/browser/index.ts";
import { Router, start as startRoute } from "../../src/node/session_route/index.ts";
import { NodeBoxKey } from "../../src/node/identity.ts";
import { testNode } from "../node_helpers.ts";

const MAIN = join(import.meta.dir, "../../src/main.ts");
const root = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "fleetd-boxed-"));
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

async function server(host: string, answer: string): Promise<{ port: number; hits: () => number; close: () => void }> {
  let hits = 0;
  const srv: Server = createServer((c) => {
    hits++;
    c.once("data", () => c.end(`HTTP/1.1 200 OK\r\ncontent-type: text/html\r\ncontent-length: ${answer.length}\r\nconnection: close\r\n\r\n${answer}`));
  });
  await new Promise<void>((r) => srv.listen(0, host, () => r()));
  return { port: (srv.address() as { port: number }).port, hits: () => hits, close: () => srv.close() };
}

async function dialGuest(sock: string): Promise<Duplex> {
  for (let i = 0; ; i++) {
    try {
      return await new Promise<Duplex>((resolve, reject) => {
        const s = connect(sock);
        s.once("connect", () => resolve(s)).once("error", reject);
      });
    } catch (e) {
      if ((e as { code?: string }).code !== "ECONNREFUSED" || i > 100) throw e;
      await Bun.sleep(10);
    }
  }
}

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
  const dial = () => dialGuest(sock);
  const box = await Box.open({ session: "s-dial", dial, nodeSock: join(dir, "node.sock"), tcp: [], lead: (s) => leadChannel(s, noLead) });
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
  const dial = () => dialGuest(sock);
  const box = await Box.open({ session: "s-old", dial, nodeSock: join(dir, "node.sock"), tcp: [7], lead: (s) => leadChannel(s, noLead) });
  cleanups.push(() => box.close());
  await expect(box.dial("localhost", 80)).rejects.toThrow("a guest from before dials");
  // The guest's side opening a channel numbered as the node's: ended at once, never piped anywhere.
  const end = new Duplex({ read() {}, write: (_c, _e, cb) => cb(), final: (cb) => (opened.push(1), cb()) });
  guest.open(NODE_CHANNELS + 5, { tcp: 7 }, end);
  for (let i = 0; i < 100 && !opened.length; i++) await Bun.sleep(10);
  expect(opened).toEqual([1]);
});


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

test("a hosted agent's browser runs in its box and stays on its own node, which alone reaches the box, wherever the hub would place it", async () => {
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
  const box: ScreenBox = { run: async () => ({ exitCode: 0, outputTail: "", timedOut: false }), write: async () => {}, dial: async () => Promise.reject(new Error("ECONNREFUSED")) };
  broker.boxed = (thread) => (thread === "boxed" ? { box } : undefined);
  broker.inBox = async () => ({ cdp: new Cdp(fakeBrowser()) });
  const started = (await t.local.call("session_start", { purpose: "p" }, "boxed")) as { sessionId: string };
  expect(broker.live("boxed")?.id).toBe(started.sessionId);
  expect(routes).toEqual([]);
  // Another agent's goes where the hub says.
  await t.local.call("session_start", { purpose: "p" }, "plain").catch(() => {});
  expect(routes.length).toBeGreaterThan(0);
  expect(broker.live("plain")).toBeUndefined();
});

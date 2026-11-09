import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { start as startBrowser } from "../src/hub/browser/loops.ts";
import { serve, stop } from "../src/hub/http/index.ts";
import { leadCalls } from "../src/hub/lead_calls/index.ts";
import { start as startRoles } from "../src/hub/machine_roles/loops.ts";
import { relays } from "../src/hub/machine_roles/relay.ts";
import { Cdp, type Transport } from "../src/node/browser/cdp.ts";
import { Broker, start as startNodeBrowser } from "../src/node/browser/index.ts";
import { Channel } from "../src/node/session_route/relay.ts";
import { Router, start as startRoute } from "../src/node/session_route/index.ts";
import { publicKeyOf } from "../src/shared/sealed_box.ts";
import { ToolError } from "../src/shared/errors.ts";
import { addMachine, addProject, agent, callLead, testHub } from "./screens_helpers.ts";
import { NodeBoxKey } from "../src/node/identity.ts";
import { Masker } from "../src/node/mask.ts";
import { type TestNode, testNode } from "./node_helpers.ts";
import { tempHome } from "./helpers.ts";
import { Desktops, start as startDesktop } from "../src/node/desktop/index.ts";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

test("a relay channel's messages open only at the other end, in order, once", () => {
  const key = crypto.getRandomValues(new Uint8Array(32));
  const [a, r] = [crypto.getRandomValues(new Uint8Array(16)), crypto.getRandomValues(new Uint8Array(16))];
  const agentEnd = new Channel(key, "agent", a, r);
  const runnerEnd = new Channel(key, "runner", r, a);
  const typed = '{"method":"Input.insertText","text":"hunter2"}';
  const sealed = agentEnd.seal(typed);
  expect(Buffer.from(sealed).includes("hunter2")).toBe(false);
  expect(runnerEnd.open(sealed)).toBe(typed);
  // Replayed, or reflected back to its sender, it opens nowhere; nor does a plain message from the hub.
  expect(runnerEnd.open(sealed)).toBeUndefined();
  expect(agentEnd.open(agentEnd.seal("x"))).toBeUndefined();
  expect(runnerEnd.open("hi")).toBeUndefined();
  expect(agentEnd.open(runnerEnd.seal(new Uint8Array([1, 2])))).toEqual(new Uint8Array([1, 2]));
});

/** A browser that answers every command with its method, and has one page. */
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

/**
 * Two nodes and a real hub between them (its HTTP server, its relay), each node answering its lead calls through the
 * hub as the link would: devbox runs the agent, box2 hosts its screens. `secrets` are the agent session's own.
 */
async function fleet(opts: { secrets?: [string, string][]; box2Hosts?: { host: string; ready: boolean; detail: string }[]; box2Config?: Record<string, unknown> } = {}) {
  const t = testHub();
  cleanups.push(t.done);
  startBrowser(t.hub);
  startRoles(t.hub);
  const server = serve(t.hub, t.tools, 0);
  cleanups.push(() => stop(server));
  const runnerSecret = crypto.getRandomValues(new Uint8Array(32));
  addMachine(t.hub, "devbox", { boxPubKey: Buffer.from(publicKeyOf(crypto.getRandomValues(new Uint8Array(32)))).toString("base64") });
  addMachine(t.hub, "box2", { boxPubKey: Buffer.from(publicKeyOf(runnerSecret)).toString("base64") });
  addProject(t.hub, "devbox", "p1");
  t.hub.db.conn.query("INSERT INTO machine_roles (machine_id, agents, sessions) VALUES ('devbox', 1, 0)").run();
  t.link.link("devbox", ["browser", "session_seal", "session_host"]);
  t.link.link("box2", ["browser", "session_seal", "session_host"]);
  const hosts = opts.box2Hosts ?? [{ host: "browser", ready: true, detail: "Chrome" }];
  t.link.deliver("box2", { t: "hb", load: { cpus: 8, load1: 0, memTotalBytes: 16 * 2 ** 30, hosts } });

  const hubUrl = `http://127.0.0.1:${server.port}`;
  const nodes = new Map<string, { node: TestNode["node"]; router: Router; link: TestNode["link"]; local: TestNode["local"] }>();
  for (const [machine, secret] of [["devbox", crypto.getRandomValues(new Uint8Array(32))], ["box2", runnerSecret]] as const) {
    const tn = testNode(machine, { hub: hubUrl, ...(machine === "box2" ? opts.box2Config : {}) });
    const node = tn.node;
    if (machine === "devbox" && opts.secrets) {
      const secrets = opts.secrets;
      node.area("sessions", () => ({ maskFor: () => new Masker(secrets), secretsFor: () => secrets, sessionCwd: () => undefined }));
    }
    const broker = startNodeBrowser(node, new Broker(node, async () => ({ cdp: new Cdp(fakeBrowser()) })));
    const router = startRoute(node, new Router(node, broker, new NodeBoxKey(secret)));
    const link = tn.link;
    link.answer = async (op, args, threadId) => {
      const thread = typeof args.threadId === "string" ? args.threadId : threadId;
      const caller =
        thread && leadCalls(t.hub).hosted(machine, thread)
          ? { ...leadCalls(t.hub).hosted(machine, thread)!, by: "lead:devbox/p1" }
          : agent(machine, "p1", "T5");
      const call = caller.threadId !== args.threadId && op === "browser_session" ? { ...args, threadId: caller.threadId } : args;
      const answer = await callLead(t.hub, caller, { op, ...call });
      if (answer.error) throw new ToolError(answer.error.code, answer.error.message, answer.error.fix);
      return answer.result as Record<string, unknown>;
    };
    nodes.set(machine, { node, router, link, local: tn.local });
    cleanups.push(async () => {
      await broker.shutdown();
      tn.done();
    });
  }
  const runner = nodes.get("box2")!;
  // The hub's frames to the runner's node, and its requests answered there.
  t.link.answer = async (machine, frame) => {
    if (machine !== "box2" || frame.t !== "session_host") throw new Error("not linked");
    const f = frame as unknown as Parameters<Router["host"]>[0] & { id?: string };
    return { id: f.id ?? "x", frame: await runner.router.host(f) };
  };
  t.link.onSend = (machine, frame) => {
    if (machine === "box2") runner.link.deliver(frame);
  };
  const piped: string[] = [];
  relays(t.hub).tap = (m) => piped.push(Buffer.from(m as Uint8Array).toString("latin1"));
  return { t, runner, agentNode: nodes.get("devbox")!, piped };
}

test("a session the hub places on another machine: sealed to it, started there, driven through the relay", async () => {
  const { t, runner, agentNode, piped } = await fleet({ secrets: [["DEPLOY_TOKEN", "tok-hunter2-secret"], ["OP_SERVICE_ACCOUNT_TOKEN", "ops_fake-token-0123"]] });
  const itemFns = new Map([["devbox", agentNode.node]]);
  const started = (await agentNode.local.call("session_start", { purpose: "look" }, "t1")) as { sessionId: string; cdp: string };
  // The agent's own address, on its own node: never the runner's.
  expect(started.cdp).toBe((await import("../src/node/browser/index.ts")).broker(agentNode.node).proxy.url("t1"));
  expect(runner.router.hosted.size).toBe(1);
  const row = t.hub.db.all<{ runner_id: string; session_id: string }>("SELECT runner_id, session_id FROM session_places")[0];
  expect(row).toEqual({ runner_id: "box2", session_id: started.sessionId });

  const ws = new WebSocket(started.cdp);
  const got: Record<string, unknown>[] = [];
  ws.onmessage = (e) => got.push(JSON.parse(String(e.data)));
  await new Promise((r) => (ws.onopen = r));
  ws.send(JSON.stringify({ id: 7, method: "Page.navigate", params: { url: "https://example.com/hunter2" }, sessionId: "driver-s" }));
  for (let i = 0; i < 200 && got.length === 0; i++) await Bun.sleep(10);
  expect(got[0]).toEqual({ id: 7, result: { echo: "Page.navigate" } });
  // The hub carried ciphertext alone.
  expect(piped.length).toBeGreaterThan(2);
  expect(piped.some((p) => p.includes("hunter2") || p.includes("Page.navigate"))).toBe(false);
  // The agent's command that drove it goes to the runner's recording, under its host key.
  {
    itemFns.get("devbox")!.area("items").ended("t1", {
      id: "i9",
      status: "completed",
      title: "open",
      startedAt: "2026-11-08T12:00:00.000Z",
      completedAt: "2026-11-08T12:00:00.200Z",
      updatedAt: "2026-11-08T12:00:00.200Z",
      kind: { type: "command", command: "agent-browser open https://example.com", exitCode: 0, output: "typed tok-hunter2-secret" },
    } as never);
  }
  const { broker: brokerOf } = await import("../src/node/browser/index.ts");
  for (let i = 0; i < 100 && brokerOf(runner.node).steps().length === 0; i++) await Bun.sleep(10);
  expect(brokerOf(runner.node).steps()).toEqual([
    { sessionId: started.sessionId, step: expect.objectContaining({ tool: "agent-browser", args: { command: "agent-browser open https://example.com" } }) },
  ]);
  // Masked on the agent's node before it left, and scrubbed again by the runner with what was sealed to it.
  expect(JSON.stringify(brokerOf(runner.node).steps())).toContain("***DEPLOY_TOKEN***");
  expect(JSON.stringify(brokerOf(runner.node).steps())).not.toContain("hunter2");
  // A fill: read on the agent's node with its token, the value sealed to the runner alone, and filled there under the
  // same check of the item's site (the fake browser's page is on no website).
  const asked: string[] = [];
  brokerOf(agentNode.node).credentials.vaultFor = (token) => {
    expect(token).toBe("ops_fake-token-0123");
    return { resolve: async (ref) => (asked.push(ref), { value: "Hunter2-Sekr3t", urls: ["https://shop.devbox.test/"] }) };
  };
  brokerOf(runner.node).credentials.vaultFor = () => {
    throw new Error("the runner read 1Password");
  };
  const filled = await agentNode.local.call("fill_credential", { ref: "op://Team/Shop/password", target: "#pw" }, "t1").catch((e: Error) => e);
  expect((filled as Error).message).toBe("op://Team/Shop/password is for shop.devbox.test; this page is on no website.");
  expect(asked).toEqual(["op://Team/Shop/password"]);
  expect(brokerOf(agentNode.node).credentials.filledSince("t1", 0)).toEqual([["op://Team/Shop/password", "Hunter2-Sekr3t"]]);
  expect(JSON.stringify(t.link.linked.get("box2")!.out)).not.toContain("Hunter2-Sekr3t");
  ws.close();
  await agentNode.local.call("session_end", {}, "t1");
  expect(agentNode.router.remotes.size).toBe(0);
  expect(runner.router.hosted.size).toBe(0);

  // An agent's claude that exits takes its session on the other machine with it, not at the session's idle timeout.
  await agentNode.local.call("session_start", { purpose: "look again" }, "t2");
  expect([agentNode.router.remotes.size, runner.router.hosted.size]).toEqual([1, 1]);
  agentNode.node.area("launch").ended("t2");
  for (let i = 0; i < 200 && runner.router.hosted.size > 0; i++) await Bun.sleep(10);
  expect([agentNode.router.remotes.size, runner.router.hosted.size]).toEqual([0, 0]);
});

test("an agent's claude that exits ends its screen on its own machine", async () => {
  const tn = testNode("devbox");
  const broker = startNodeBrowser(tn.node, new Broker(tn.node, async () => ({ cdp: new Cdp(fakeBrowser()) })));
  startRoute(tn.node, new Router(tn.node, broker, new NodeBoxKey(crypto.getRandomValues(new Uint8Array(32)))));
  cleanups.push(async () => {
    await broker.shutdown();
    tn.done();
  });
  await broker.open("t1", "look");
  await broker.open("t2", "look too");
  tn.node.area("launch").ended("t1");
  for (let i = 0; i < 200 && broker.live("t1"); i++) await Bun.sleep(10);
  expect(broker.live("t1")).toBeUndefined();
  expect(broker.live("t2")).toBeDefined();
});

test("a hosted start's sealed secrets reach its broker, which scrubs its recording of them", async () => {
  const { seal } = await import("../src/shared/sealed_box.ts");
  const tn = testNode("box2");
  const secret = crypto.getRandomValues(new Uint8Array(32));
  const broker = startNodeBrowser(tn.node, new Broker(tn.node, async () => ({ cdp: new Cdp(fakeBrowser()) })));
  const router = startRoute(tn.node, new Router(tn.node, broker, new NodeBoxKey(secret)));
  cleanups.push(async () => {
    await broker.shutdown();
    tn.done();
  });
  const plain = { secrets: [["TOKEN", "hunter2-value"]], relayKey: Buffer.alloc(32, 7).toString("base64") };
  const sealed = Buffer.from(seal(publicKeyOf(secret), new TextEncoder().encode(JSON.stringify(plain)))).toString("base64");
  const key = `H${"ab".repeat(16)}`;
  const answer = await router.host({ hostKey: key, frame: { id: "1", cwd: "/", call: { op: "session_start", purpose: "look" } }, sealed } as never);
  expect(answer.error).toBeUndefined();
  expect(broker.live(key)?.scrub().text("typed hunter2-value")).toBe("typed ***TOKEN***");
  // Read at the start: they leave the node's memory, while the relay key stays until the session ends.
  expect(router.hosted.get(key)?.secrets).toBeUndefined();
  expect(router.hosted.get(key)?.relayKey.length).toBe(32);
  // However it ends here (idle, a person, the app), its report makes the node forget the relay key too.
  await broker.end(key);
  expect(router.hosted.has(key)).toBe(false);
});

test("a desktop the hub places on another machine: the agent's secrets sealed to it, its recording scrubbed of them and uploaded", async () => {
  if (process.platform !== "linux") return;
  const dir = tempHome();
  cleanups.push(dir.done);
  const xvfb = join(dir.dir, "Xvfb");
  writeFileSync(xvfb, `#!/bin/sh\nexec "${process.execPath}" "${join(import.meta.dir, "fake_x.ts")}" "$@"\n`);
  chmodSync(xvfb, 0o755);
  const [x11, locks] = [join(dir.dir, "x11"), join(dir.dir, "locks")];
  mkdirSync(x11);
  mkdirSync(locks);
  process.env.FAKE_X11_DIR = x11;
  process.env.FAKE_X_LOCK_DIR = locks;
  const { t, runner, agentNode } = await fleet({
    secrets: [["DEPLOY_TOKEN", "tok-hunter2-secret"], ["OP_SERVICE_ACCOUNT_TOKEN", "ops_never_sealed"]],
    box2Hosts: [{ host: "desktop", ready: true, detail: "Xvfb" }],
    box2Config: { desktop: { backend: "xvfb", xvfb, x11Dir: x11, lockDir: locks, windowManagers: [], pool: 0 } },
  });
  // The agent's machine runs no desktops of its own: the hub places it on box2.
  const own = startDesktop(agentNode.node, new Desktops(agentNode.node, { enabled: false }));
  const there = startDesktop(runner.node);
  cleanups.push(() => own.shutdown());
  cleanups.push(() => there.shutdown());
  const started = (await agentNode.local.call("session_start", { kind: "linux_desktop", purpose: "check the app" }, "t1")) as { sessionId: string };
  expect(started.sessionId).toMatch(/^B[0-9a-f]{32}$/);
  const key = [...runner.router.hosted.keys()][0]!;
  expect(there.live(key)).toEqual({ id: started.sessionId, kind: "linux_desktop" });
  // Its secrets were read at the start, then left the runner's memory.
  expect(runner.router.hosted.get(key)?.secrets).toBeUndefined();
  // The agent's desktop actions go there through the hub; the runner's answers come back masked.
  const typed = (await agentNode.local.call("desktop", { action: "type", text: "tok-hunter2-secret" }, "t1")) as { message: string };
  expect(typed.message).toBe("Typed 18 characters.");
  await agentNode.local.call("desktop", { action: "type", text: "ops_never_sealed" }, "t1");
  const ended = (await agentNode.local.call("session_end", {}, "t1")) as { files: { file: string }[] };
  expect(ended.files.map((f) => f.file)).toEqual(["actions"]);
  expect(runner.router.hosted.size).toBe(0);
  // Uploaded to the hub: scrubbed of the agent's secret, which only the seal brought to box2. The 1Password token was
  // never sealed, so it is not the runner's to scrub.
  const stored = join(t.hub.config.home, "browser", started.sessionId, "actions.jsonl");
  for (let i = 0; i < 300 && !existsSync(stored); i++) await Bun.sleep(10);
  const log = readFileSync(stored, "utf8");
  expect(log).toContain("***DEPLOY_TOKEN***");
  expect(log).not.toContain("hunter2");
  expect(log).toContain("ops_never_sealed");
  expect(existsSync(join(runner.node.home, "desktop", "recordings", started.sessionId))).toBe(false);
}, 30_000);

/** A node whose hub places the session on `runner`, sealed to `pub`: the two `session_route` calls it made. */
function placedElsewhere(secrets: [string, string][], relayOnly: boolean) {
  const tn = testNode("devbox");
  cleanups.push(tn.done);
  tn.node.area("sessions", () => ({ maskFor: () => new Masker(secrets), secretsFor: () => secrets, sessionCwd: () => undefined }));
  const secret = crypto.getRandomValues(new Uint8Array(32));
  const routes: Record<string, unknown>[] = [];
  tn.link.answer = async (op, args) => {
    if (op !== "session_route") return {};
    routes.push(args);
    if (!args.sealed) return { runner: "box2", here: false, sealTo: Buffer.from(publicKeyOf(secret)).toString("base64"), ...(relayOnly ? { relayOnly: true } : {}) };
    return { runner: "box2", here: false, answer: { id: "1", result: { op: "session_start", sessionId: `B${"0".repeat(32)}` } } };
  };
  const broker = startNodeBrowser(tn.node, new Broker(tn.node, async () => ({ cdp: new Cdp(fakeBrowser()) })));
  cleanups.push(() => broker.shutdown());
  startRoute(tn.node, new Router(tn.node, broker, new NodeBoxKey(crypto.getRandomValues(new Uint8Array(32)))));
  const opened = () => {
    const sealed = (routes[1]?.sealed as { dataB64: string } | undefined)?.dataB64;
    const plain = sealed ? new NodeBoxKey(secret).open(Buffer.from(sealed, "base64")) : null;
    return plain ? (JSON.parse(new TextDecoder().decode(plain)) as { secrets: [string, string][]; relayKey: string }) : undefined;
  };
  return { tn, routes, opened };
}

test("an agent's node seals its session's secrets to the runner, never its 1Password token, and none to the agents' Mac", async () => {
  const secrets: [string, string][] = [["DEPLOY_TOKEN", "tok-hunter2-secret"], ["OP_SERVICE_ACCOUNT_TOKEN", "ops_token"]];
  const browser = placedElsewhere(secrets, false);
  await browser.tn.local.call("session_start", { purpose: "look" }, "t1");
  expect(browser.opened()?.secrets).toEqual([["DEPLOY_TOKEN", "tok-hunter2-secret"]]);
  expect(Buffer.from(browser.opened()!.relayKey, "base64").length).toBe(32);

  const mac = placedElsewhere(secrets, true);
  await mac.tn.local.call("session_start", { purpose: "look", kind: "mac" }, "t1");
  expect(mac.routes[0]).toMatchObject({ host: "mac" });
  expect(mac.opened()?.secrets).toEqual([]);
});

test("an Android screen the hub would place on another machine is refused before anything is sealed to it", async () => {
  const android = placedElsewhere([["DEPLOY_TOKEN", "tok-hunter2-secret"]], false);
  await expect(android.tn.local.call("session_start", { purpose: "Settings", kind: "android" }, "t1")).rejects.toThrow("can't drive an emulator there");
  expect(android.routes.length).toBe(1);
  // And an iOS start isn't even asked of the hub.
  await expect(android.tn.local.call("session_start", { purpose: "Settings", kind: "ios" }, "t1")).rejects.toThrow("mac sim start");
  expect(android.routes.length).toBe(1);
});

test("a browser start refused before the broker opens it leaves none of the session's secrets in memory", async () => {
  const { seal } = await import("../src/shared/sealed_box.ts");
  const { router: screens } = await import("../src/node/device/router.ts");
  const tn = testNode("box2");
  cleanups.push(tn.done);
  const secrets: [string, string][] = [["DEPLOY_TOKEN", "tok-hunter2-secret"]];
  tn.node.area("sessions", () => ({ maskFor: () => new Masker(secrets), secretsFor: () => secrets, sessionCwd: () => undefined }));
  tn.link.answer = async (op) => (op === "session_route" ? { runner: "box2", here: true } : {});
  const secret = crypto.getRandomValues(new Uint8Array(32));
  const broker = startNodeBrowser(tn.node, new Broker(tn.node, async () => ({ cdp: new Cdp(fakeBrowser()) })));
  const router = startRoute(tn.node, new Router(tn.node, broker, new NodeBoxKey(secret)));
  cleanups.push(() => broker.shutdown());
  const key = `H${"ef".repeat(16)}`;
  // A desktop is open for this agent session and for the hosted key: a browser start is refused before the broker.
  const open = new Set(["t1", key]);
  screens(tn.node).desktops = {
    handle: async () => ({ op: "noop" }),
    live: (thread) => (open.has(thread) ? { id: `B${"1".repeat(32)}`, kind: "linux_desktop" } : undefined),
    count: () => open.size,
    endScreen: () => false,
    ended: () => {},
    shutdown: async () => {},
  };
  const pending = () => (broker as unknown as { pendingSecrets: Map<string, unknown> }).pendingSecrets;

  await expect(tn.local.call("session_start", { purpose: "look" }, "t1")).rejects.toThrow("Desktop session");
  expect(pending().has("t1")).toBe(false);

  const plain = { secrets, relayKey: Buffer.alloc(32, 7).toString("base64") };
  const sealed = Buffer.from(seal(publicKeyOf(secret), new TextEncoder().encode(JSON.stringify(plain)))).toString("base64");
  const answer = await router.host({ hostKey: key, frame: { id: "1", cwd: "/", call: { op: "session_start", purpose: "look" } }, sealed } as never);
  expect(answer.error?.message).toContain("Desktop session");
  expect(pending().has(key)).toBe(false);
  expect(router.hosted.has(key)).toBe(false);

  // A start that opens takes them, and leaves none behind either.
  open.clear();
  await tn.local.call("session_start", { purpose: "look" }, "t1");
  expect(broker.live("t1")?.scrub().text("tok-hunter2-secret")).toBe("***DEPLOY_TOKEN***");
  expect(pending().size).toBe(0);
});

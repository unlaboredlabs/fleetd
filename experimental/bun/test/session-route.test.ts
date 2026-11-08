import { afterEach, expect, test } from "bun:test";
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
import { type TestNode, testNode } from "./node_helpers.ts";

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

test("a session the hub places on another machine: sealed to it, started there, driven through the relay", async () => {
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
  t.link.deliver("box2", { t: "hb", load: { cpus: 8, load1: 0, memTotalBytes: 16 * 2 ** 30, hosts: [{ host: "browser", ready: true, detail: "Chrome" }] } });

  // Two nodes, each answering its lead calls through the hub as the link would.
  const hubUrl = `http://127.0.0.1:${server.port}`;
  const itemFns = new Map<string, TestNode["node"]>();
  const nodes = new Map<string, { node: TestNode["node"]; router: Router; link: TestNode["link"]; local: TestNode["local"] }>();
  for (const [machine, secret] of [["devbox", crypto.getRandomValues(new Uint8Array(32))], ["box2", runnerSecret]] as const) {
    const tn = testNode(machine, { hub: hubUrl });
    const node = tn.node;
    itemFns.set(machine, node);
    const broker = startNodeBrowser(node, new Broker(node, async () => ({ cdp: new Cdp(fakeBrowser()) })));
    const router = startRoute(node, new Router(node, broker, new NodeBoxKey(secret)));
    const link = tn.link;
    link.answer = async (op, args) => {
      const caller =
        typeof args.threadId === "string" && leadCalls(t.hub).hosted(machine, args.threadId)
          ? { ...leadCalls(t.hub).hosted(machine, args.threadId)!, by: "lead:devbox/p1" }
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

  const agentNode = nodes.get("devbox")!;
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
      kind: { type: "command", command: "agent-browser open https://example.com", exitCode: 0 },
    } as never);
  }
  const { broker: brokerOf } = await import("../src/node/browser/index.ts");
  for (let i = 0; i < 100 && brokerOf(runner.node).steps().length === 0; i++) await Bun.sleep(10);
  expect(brokerOf(runner.node).steps()).toEqual([
    { sessionId: started.sessionId, step: expect.objectContaining({ tool: "agent-browser", args: { command: "agent-browser open https://example.com" } }) },
  ]);
  ws.close();
  await agentNode.local.call("session_end", {}, "t1");
  expect(agentNode.router.remotes.size).toBe(0);
  expect(runner.router.hosted.size).toBe(0);
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
  const answer = await router.host({ hostKey: "host-k1", frame: { id: "1", cwd: "/", call: { op: "session_start", purpose: "look" } }, sealed } as never);
  expect(answer.error).toBeUndefined();
  expect(broker.live("host-k1")?.recording?.scrub.text("typed hunter2-value")).toBe("typed ***TOKEN***");
});

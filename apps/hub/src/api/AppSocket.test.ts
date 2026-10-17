import type { MachineId } from "@fleetd/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import { HttpServer } from "effect/http";
import { afterEach, describe, expect, it } from "vitest";
import * as AppSocket from "./AppSocket.ts";
import * as FleetApi from "./FleetApi.ts";
import * as HttpApp from "./HttpApp.ts";
import { machine, makeTestHub, project, thread } from "./testHub.ts";

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

type Frame = { t: string; id?: string; [k: string]: unknown };

/** The real HTTP server, app socket, FleetApi, store, auth and event log; fake executors. Two machines, one project each. */
const fleet = async () => {
  const hub = makeTestHub();
  const services = AppSocket.layer.pipe(Layer.provideMerge(FleetApi.layer), Layer.provideMerge(hub.layer));
  const scope = Effect.runSync(Scope.make());
  const context = await Effect.runPromise(
    Layer.buildWithScope(HttpApp.layer({ host: "127.0.0.1", port: 0 }).pipe(Layer.provideMerge(services)), scope),
  );
  closers.push(() => Effect.runPromise(Scope.close(scope, Exit.void)));
  hub.bind(context);
  const address = Context.get(context, HttpServer.HttpServer).address;
  if (address._tag === "UnixPathAddress") throw new Error("expected a TCP address");
  for (const id of ["lab-a", "lab-b"]) {
    await hub.addMachine(machine(id));
    hub.connected.add(id);
    await hub.addProjects(id, [project(id, `p-${id}`)]);
  }
  return { hub, url: `ws://127.0.0.1:${address.port}/app` };
};

/** An /app connection whose frames are read by call id, so concurrent answers can arrive in any order. */
const open = async (url: string) => {
  const socket = new WebSocket(url);
  const frames: Array<Frame> = [];
  const waiters: Array<() => void> = [];
  socket.addEventListener("message", (m) => {
    frames.push(JSON.parse(String(m.data)));
    for (const w of waiters.splice(0)) w();
  });
  closers.unshift(async () => socket.close());
  await new Promise((r) => socket.addEventListener("open", r));
  const take = async (match: (f: Frame) => boolean) => {
    for (;;) {
      const ix = frames.findIndex(match);
      if (ix >= 0) return frames.splice(ix, 1)[0]!;
      await new Promise<void>((r) => waiters.push(r));
    }
  };
  const send = (m: object) => socket.send(JSON.stringify(m));
  return {
    send,
    take,
    auth: async (key: string) => {
      send({ t: "auth", key });
      return take((f) => f.t === "ready" || f.t === "error");
    },
    call: async (id: string, tool: string, input: unknown) => {
      send({ t: "call", id, tool, input });
      return take((f) => f.id === id);
    },
  };
};

describe("app call frame", () => {
  it("runs a tool with the session's key and answers with the call id", async () => {
    const { hub, url } = await fleet();
    const { key } = await hub.addKey("reader", [{ role: "read", machines: "*" }]);
    const app = await open(url);
    await app.auth(key);
    const got = await app.call("c1", "project_get", { machineId: "lab-a", projectId: "p-lab-a" });
    expect(got).toMatchObject({ t: "result", id: "c1", output: { project: { projectId: "p-lab-a" }, stale: false } });
  });

  it("enforces the key's roles and machine grants like /mcp", async () => {
    const { hub, url } = await fleet();
    await hub.addThread(thread("lab-a", "p-lab-a", "t1"));
    const { key } = await hub.addKey("a-reader", [{ role: "read", machines: ["lab-a" as MachineId] }]);
    const app = await open(url);
    await app.auth(key);
    expect(await app.call("w", "thread_send", { machineId: "lab-a", threadId: "t1", message: "hi", clientRequestId: "r1" })).toEqual({
      t: "error",
      id: "w",
      code: "forbidden",
      message: "This key lacks the operate role.",
      fix: expect.stringContaining("fleetd hub key create"),
    });
    expect(await app.call("b", "project_get", { machineId: "lab-b", projectId: "p-lab-b" })).toMatchObject({
      t: "error",
      id: "b",
      code: "forbidden",
      message: "This key has no read grant on machine lab-b.",
    });
    expect(hub.calls).toEqual([]);
  });

  it("maps unknown tools, bad input and tool errors to error frames with the id", async () => {
    const { hub, url } = await fleet();
    const { key } = await hub.addKey("admin", [{ role: "admin", machines: "*" }]);
    const app = await open(url);
    await app.auth(key);
    expect(await app.call("u", "rm_rf", {})).toMatchObject({ t: "error", id: "u", code: "not_found", message: "No tool rm_rf." });
    expect(await app.call("i", "project_get", { machineId: "Not A Slug" })).toMatchObject({
      t: "error",
      id: "i",
      code: "invalid",
      message: expect.stringMatching(/^Invalid project_get input: /u),
    });
    expect(await app.call("n", "project_get", { machineId: "lab-a", projectId: "nope" })).toMatchObject({
      t: "error",
      id: "n",
      code: "not_found",
      message: "No project nope on lab-a.",
    });
  });

  it("refuses calls before auth and stops a revoked key at its next call", async () => {
    const { hub, url } = await fleet();
    const { key, keyId } = await hub.addKey("reader", [{ role: "read", machines: "*" }]);
    const app = await open(url);
    expect(await app.call("early", "fleetd_status", {})).toMatchObject({ t: "error", id: "early", code: "forbidden", message: "Not authenticated." });
    await app.auth(key);
    expect(await app.call("ok", "fleetd_status", {})).toMatchObject({ t: "result", id: "ok" });
    await hub.revoke(keyId);
    expect(await app.call("late", "fleetd_status", {})).toMatchObject({ t: "error", id: "late", code: "forbidden" });
  });

  it("records answers given with a human key as the human's, and an agent key's as the agent's", async () => {
    const { hub, url } = await fleet();
    await hub.fileAsk("lab-a", "p-lab-a", "api.health.path", "/healthz");
    await hub.fileAsk("lab-a", "p-lab-a", "db.engine", "sqlite");
    const human = await open(url);
    await human.auth((await hub.addKey("wynn-laptop", [{ role: "operate", machines: "*" }], "human")).key);
    const agent = await open(url);
    await agent.auth((await hub.addKey("script", [{ role: "operate", machines: "*" }])).key);

    expect(await human.call("h", "inbox_reply", { raw: "1 go" })).toMatchObject({
      t: "result",
      output: { parsed: true, applied: [{ number: 1, source: "human", by: "human:wynn-laptop" }] },
    });
    expect(await agent.call("a", "inbox_reply", { raw: "2 go" })).toMatchObject({
      output: { parsed: true, applied: [{ number: 2, source: "agent", by: "script" }] },
    });
    const scope = { kind: "project", projectRef: { machineId: "lab-a", projectId: "p-lab-a" } };
    expect(await human.call("d", "decisions_record", { key: "ui.theme", value: "dark", scope })).toMatchObject({
      output: { decision: { source: "human", by: "human:wynn-laptop" } },
    });
  });

  it("answers a quick call while a long-poll call is still waiting", async () => {
    const { hub, url } = await fleet();
    const { key } = await hub.addKey("reader", [{ role: "read", machines: "*" }]);
    const app = await open(url);
    await app.auth(key);
    app.send({ t: "call", id: "slow", tool: "events_wait", input: { timeoutSec: 50 } });
    await hub.waitCalls(1);
    expect(await app.call("fast", "projects_list", {})).toMatchObject({ t: "result", id: "fast", output: { projects: [{}, {}] } });
  });
});

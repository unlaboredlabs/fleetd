import type { HubEventType, MachineId, ThreadId } from "@fleetd/contracts";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import { HttpServer } from "effect/http";
import { afterEach, describe, expect, it } from "vitest";
import * as AppSocket from "../api/AppSocket.ts";
import { AT, machine, makeTestHub, project, thread } from "../api/testHub.ts";
import * as FleetApi from "../api/FleetApi.ts";
import * as HttpApp from "../api/HttpApp.ts";

type TestHub = ReturnType<typeof makeTestHub>;
const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

/** The real HTTP server, MCP endpoint, app socket, store, auth and event log on an ephemeral port; fake executors. */
const startHub = async (hub: TestHub) => {
  const services = AppSocket.layer.pipe(Layer.provideMerge(FleetApi.layer), Layer.provideMerge(hub.layer));
  const scope = Effect.runSync(Scope.make());
  const context = await Effect.runPromise(
    Layer.buildWithScope(HttpApp.layer({ host: "127.0.0.1", port: 0 }).pipe(Layer.provideMerge(services)), scope),
  );
  closers.push(() => Effect.runPromise(Scope.close(scope, Exit.void)));
  hub.bind(context);
  const address = Context.get(context, HttpServer.HttpServer).address;
  if (address._tag === "UnixPathAddress") throw new Error("expected a TCP address");
  return `http://127.0.0.1:${address.port}`;
};

const connect = async (url: string, key: string) => {
  const client = new Client({ name: "test", version: "0" });
  const transport = new StreamableHTTPClientTransport(new URL(`${url}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${key}` } },
  });
  // The SDK's own types disagree under exactOptionalPropertyTypes (sessionId?: string vs string | undefined).
  await client.connect(transport as Transport);
  closers.unshift(() => client.close());
  return client;
};

const call = async (client: Client, name: string, args: Record<string, unknown> = {}) => {
  const result = await client.callTool({ name, arguments: args });
  const content = result.content as Array<{ type: string; text: string }>;
  return { isError: result.isError === true, body: JSON.parse(content[0]!.text) };
};

/** A started hub with two online machines, lab-a and lab-b, one project each, and three keys. */
const fleet = async () => {
  const hub = makeTestHub();
  const url = await startHub(hub);
  for (const id of ["lab-a", "lab-b"]) {
    await hub.addMachine(machine(id));
    hub.connected.add(id);
    await hub.addProjects(id, [project(id, `p-${id}`)]);
  }
  const keys = {
    admin: await hub.addKey("admin", [{ role: "admin", machines: "*" }]),
    reader: await hub.addKey("reader", [{ role: "read", machines: "*" }]),
    aOnly: await hub.addKey("a-only", [{ role: "operate", machines: ["lab-a" as MachineId] }]),
  };
  return { hub, url, keys, as: (who: keyof typeof keys) => connect(url, keys[who].key) };
};

const launch = { projectId: "p-lab-a", prompt: "reply OK", model: "claude-haiku-5-5", effort: "low", clientRequestId: "r1" };

describe("MCP endpoint auth", () => {
  it("refuses requests without a valid bearer with 401 and a fix", async () => {
    const { url } = await fleet();
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    const headers = { "content-type": "application/json", accept: "application/json, text/event-stream" };
    const none = await fetch(`${url}/mcp`, { method: "POST", headers, body });
    expect(none.status).toBe(401);
    expect(await none.json()).toMatchObject({ code: "forbidden", fix: expect.stringContaining("Bearer fld_") });
    const bad = await fetch(`${url}/mcp`, { method: "POST", headers: { ...headers, authorization: `Bearer fld_${"a".repeat(52)}` }, body });
    expect(bad.status).toBe(401);
  });

  it("stops serving a key as soon as it is revoked", async () => {
    const { hub, keys, as } = await fleet();
    const client = await as("admin");
    expect((await call(client, "fleetd_status")).isError).toBe(false);
    await hub.revoke(keys.admin.keyId);
    await expect(call(client, "fleetd_status")).rejects.toThrow(/401|revoked/);
  });

  it("lists the nine tools with object input schemas", async () => {
    const { tools } = await (await (await fleet()).as("reader")).listTools();
    expect(tools.map((t) => t.name).toSorted()).toEqual(
      ["actions_list", "events_wait", "fleetd_status", "project_get", "projects_list", "thread_interrupt", "thread_launch", "thread_send", "thread_tail"],
    );
    for (const tool of tools) expect(tool.inputSchema.type).toBe("object");
    expect(tools.find((t) => t.name === "thread_tail")!.inputSchema.required).toEqual(["machineId", "threadId"]);
  });
});

describe("scope and grant checks", () => {
  it("refuses operate tools to a read key", async () => {
    const { hub, as } = await fleet();
    const result = await call(await as("reader"), "thread_launch", { machineId: "lab-a", ...launch });
    expect(result).toEqual({
      isError: true,
      body: { code: "forbidden", message: "This key lacks the operate role.", fix: expect.stringContaining("fleetd hub key create") },
    });
    expect(hub.calls).toEqual([]);
  });

  it("limits a machine-scoped key to its machines, in reads and writes", async () => {
    const { hub, as } = await fleet();
    const client = await as("aOnly");
    const status = await call(client, "fleetd_status");
    expect(status.body.machines.map((m: { machineId: string }) => m.machineId)).toEqual(["lab-a"]);
    expect(status.body.projects.map((p: { machineId: string }) => p.machineId)).toEqual(["lab-a"]);
    const listed = await call(client, "projects_list");
    expect(listed.body.projects.map((p: { machineId: string }) => p.machineId)).toEqual(["lab-a"]);
    const read = await call(client, "project_get", { machineId: "lab-b", projectId: "p-lab-b" });
    expect(read.body).toMatchObject({ code: "forbidden", message: "This key has no read grant on machine lab-b." });
    const write = await call(client, "thread_launch", { machineId: "lab-b", ...launch, projectId: "p-lab-b" });
    expect(write.body.code).toBe("forbidden");
    expect((await call(client, "thread_launch", { machineId: "lab-a", ...launch })).body.threadId).toBe("t-new");
    expect(hub.calls).toEqual([{ op: "launch", args: { machineId: "lab-a", input: { machineId: "lab-a", ...launch, runtimeMode: "full-access" } } }]);
  });
});

describe("errors", () => {
  it("refuses writes to an offline machine with machine_offline and a fix", async () => {
    const { hub, as } = await fleet();
    hub.connected.delete("lab-a");
    const client = await as("admin");
    for (const [tool, args] of [
      ["thread_launch", { machineId: "lab-a", ...launch }],
      ["thread_send", { machineId: "lab-a", threadId: "t1", message: "hi", clientRequestId: "r2" }],
      ["thread_interrupt", { machineId: "lab-a", threadId: "t1", clientRequestId: "r3" }],
    ] as const) {
      expect(await call(client, tool, args)).toEqual({
        isError: true,
        body: { code: "machine_offline", message: "Machine lab-a is offline.", fix: "Start the node on lab-a or check its network, then retry." },
      });
    }
    expect(hub.calls).toEqual([]);
  });

  it("reports invalid input and unknown ids with a fix", async () => {
    const client = await (await fleet()).as("admin");
    const invalid = await call(client, "thread_tail", { machineId: "Lab A", threadId: "t1" });
    expect(invalid.body).toMatchObject({ code: "invalid", fix: expect.any(String) });
    expect((await call(client, "thread_tail", { machineId: "lab-a", threadId: "t1", n: 51 })).body.code).toBe("invalid");
    const missing = await call(client, "project_get", { machineId: "lab-a", projectId: "nope" });
    expect(missing.body).toEqual({ code: "not_found", message: "No project nope on lab-a.", fix: "Call projects_list with machineId lab-a." });
    const gone = await call(client, "project_get", { machineId: "lab-z", projectId: "p" });
    expect(gone.body).toMatchObject({ code: "not_found", fix: "Call fleetd_status to list machines." });
  });
});

describe("reads", () => {
  it("serves an offline machine's outcome from cache, marked stale as of its last contact", async () => {
    const { hub, as } = await fleet();
    const lastSeenAt = "2026-10-17T09:00:00.000Z";
    await hub.addMachine(machine("lab-a", "offline", lastSeenAt));
    await hub.addThread({ ...thread("lab-a", "p-lab-a", "t1", { latestMessageTail: "done" }), lastSequence: 7 });
    const client = await as("admin");
    const outcome = (await call(client, "project_get", { machineId: "lab-a", projectId: "p-lab-a" })).body;
    expect(outcome).toMatchObject({ stale: true, asOf: lastSeenAt, threads: [{ threadId: "t1", stale: true, asOf: lastSeenAt }] });
    const tail = (await call(client, "thread_tail", { machineId: "lab-a", threadId: "t1" })).body;
    expect(tail.items).toEqual([{ kind: "message", at: AT, role: "assistant", text: "done" }]);
    expect(tail.thread).toEqual({ ...thread("lab-a", "p-lab-a", "t1", { latestMessageTail: "done" }), stale: true, asOf: lastSeenAt });
    expect((await call(client, "actions_list", { machineId: "lab-a", threadId: "t1" })).body.code).toBe("machine_offline");
  });

  it("trims outputs to their limits and says so", async () => {
    const { hub, as } = await fleet();
    await hub.addProjects(
      "lab-a",
      Array.from({ length: 60 }, (_, i) => project("lab-a", `x${i}`, `2026-10-17T11:${String(i).padStart(2, "0")}:00.000Z`)),
    );
    for (let i = 0; i < 25; i++) await hub.addThread(thread("lab-a", "p-lab-a", `t${i}`));
    hub.setTail({ items: [{ kind: "message", at: AT, role: "assistant", text: "y".repeat(3000) }], thread: thread("lab-a", "p-lab-a", "t1") });
    const client = await as("admin");
    const status = (await call(client, "fleetd_status")).body;
    expect(status.projects).toHaveLength(50);
    expect(status.truncated).toBe(true);
    expect(status.projects[0].projectId).toBe("x59");
    const outcome = (await call(client, "project_get", { machineId: "lab-a", projectId: "p-lab-a" })).body;
    expect(outcome.threads).toHaveLength(20);
    expect(outcome.truncated).toBe(true);
    const tail = (await call(client, "thread_tail", { machineId: "lab-a", threadId: "t1" })).body;
    expect(tail.items[0].text).toHaveLength(2000);
    expect((await call(client, "projects_list", { machineId: "lab-b" })).body).toEqual({ projects: [project("lab-b", "p-lab-b")] });
  });
});

describe("events_wait", () => {
  const event = (machineId: string, type: HubEventType = "thread.completed") => ({
    at: AT,
    type,
    machineId: machineId as MachineId,
    threadId: "t1" as ThreadId,
    summary: `${type} on ${machineId}`,
  });

  it("returns at once when events after the cursor exist, and starts at the end without one", async () => {
    const { hub, as } = await fleet();
    await hub.append(event("lab-a"));
    await hub.append(event("lab-b", "thread.failed"));
    const client = await as("admin");
    expect((await call(client, "events_wait", { cursor: 0 })).body).toMatchObject({ cursor: 2, more: false, events: [{ seq: 1 }, { seq: 2 }] });
    const failed = (await call(client, "events_wait", { cursor: 0, types: ["thread.failed"] })).body;
    expect(failed.events.map((e: { seq: number }) => e.seq)).toEqual([2]);
    expect((await call(client, "events_wait", { timeoutSec: 0 })).body).toMatchObject({ events: [], cursor: 2 });
  });

  it("long-polls until an event the key may see arrives, skipping other machines' events", async () => {
    const { hub, as } = await fleet();
    const waiting = call(await as("aOnly"), "events_wait", { cursor: 0 });
    await hub.waitCalls(1);
    await hub.append(event("lab-b"));
    await hub.waitCalls(2);
    await hub.append(event("lab-a"));
    expect((await waiting).body).toMatchObject({ cursor: 2, more: false, events: [{ seq: 2, machineId: "lab-a" }] });
  });

  it("puts the latest attention events in fleetd_status", async () => {
    const { hub, as } = await fleet();
    for (let i = 0; i < 12; i++) await hub.append(event("lab-a", "thread.failed"));
    await hub.append(event("lab-a", "thread.completed"));
    const status = (await call(await as("admin"), "fleetd_status")).body;
    expect(status.cursor).toBe(13);
    expect(status.attention.map((e: { seq: number }) => e.seq)).toEqual([3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  });
});

describe("app WebSocket", () => {
  const open = async (url: string) => {
    const socket = new WebSocket(`${url.replace("http", "ws")}/app`);
    const inbox: Array<{ t: string; [k: string]: unknown }> = [];
    const waiters: Array<() => void> = [];
    socket.addEventListener("message", (m) => {
      inbox.push(JSON.parse(String(m.data)));
      for (const w of waiters.splice(0)) w();
    });
    closers.unshift(async () => socket.close());
    await new Promise((r) => socket.addEventListener("open", r));
    const next = async () => {
      while (inbox.length === 0) await new Promise<void>((r) => waiters.push(r));
      return inbox.shift()!;
    };
    return { socket, next, send: (m: object) => socket.send(JSON.stringify(m)) };
  };

  it("authenticates, answers snapshot and streams events after a cursor", async () => {
    const { hub, url, keys } = await fleet();
    const app = await open(url);
    app.send({ t: "snapshot" });
    expect(await app.next()).toMatchObject({ t: "error", code: "forbidden" });
    app.send({ t: "auth", key: keys.reader.key });
    expect(await app.next()).toEqual({ t: "ready", protocol: 1 });
    app.send({ t: "snapshot" });
    expect(await app.next()).toMatchObject({ t: "snapshot", cursor: 0, machines: [{ machineId: "lab-a" }, { machineId: "lab-b" }] });
    app.send({ t: "events", cursor: 0 });
    await hub.waitCalls(1);
    await hub.append({ at: AT, type: "machine.offline", machineId: "lab-b" as MachineId, summary: "lab-b went offline" });
    expect(await app.next()).toMatchObject({ t: "event", seq: 1, type: "machine.offline" });
  });

  it("closes a connection whose key is refused", async () => {
    const app = await open((await fleet()).url);
    const closed = new Promise<number>((r) => app.socket.addEventListener("close", (e) => r(e.code)));
    app.send({ t: "auth", key: `fld_${"a".repeat(52)}` });
    expect(await app.next()).toMatchObject({ t: "error", code: "forbidden" });
    expect(await closed).toBe(AppSocket.CLOSE_UNAUTHORIZED);
  });
});

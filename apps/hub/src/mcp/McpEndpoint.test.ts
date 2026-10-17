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

  it("lists the implemented tools with object input schemas", async () => {
    const { tools } = await (await (await fleet()).as("reader")).listTools();
    expect(tools.map((t) => t.name).toSorted()).toEqual([...FleetApi.IMPLEMENTED_TOOLS].toSorted());
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
  it("refuses launches and interrupts to an offline machine with machine_offline and a fix", async () => {
    const { hub, as } = await fleet();
    hub.connected.delete("lab-a");
    const client = await as("admin");
    for (const [tool, args] of [
      ["thread_launch", { machineId: "lab-a", ...launch }],
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

describe("merge train tools", () => {
  it("shows trains within the key's grants, freezes and resumes one by its decision, and flags PRs sent back", async () => {
    const { hub, as } = await fleet();
    await hub.addTrain("wynn-dev/testbed", "lab-a", "p-lab-a");
    await hub.addTrain("wynn-dev/other", "lab-b", "p-lab-b");
    const aOnly = await as("aOnly");

    expect((await call(aOnly, "train_get", { repo: "Wynn-Dev/Testbed" })).body).toMatchObject({ train: { repo: "wynn-dev/testbed", frozen: false, queue: [] } });
    const hidden = (await call(aOnly, "train_get", { repo: "wynn-dev/other" })).body;
    expect(hidden).toMatchObject({ code: "not_found", fix: expect.stringContaining("policy.freeze.wynn-dev.other = true") });
    expect((await call(aOnly, "project_get", { machineId: "lab-a", projectId: "p-lab-a" })).body.trains).toEqual([{ repo: "wynn-dev/testbed", frozen: false, queue: [] }]);
    expect((await call(aOnly, "changes_list")).body.changes).toEqual([]);

    expect((await call(await as("reader"), "train_freeze", { repo: "wynn-dev/testbed", frozen: true })).body.code).toBe("forbidden");
    const frozen = (await call(aOnly, "train_freeze", { repo: "wynn-dev/testbed", frozen: true, reason: "release week" })).body;
    expect(frozen).toMatchObject({ train: { frozen: true }, next: expect.stringContaining("train.frozen") });
    const found = (await call(aOnly, "decisions_search", { query: "freeze" })).body.decisions;
    expect(found).toMatchObject([{ key: "policy.freeze.wynn-dev.testbed", value: "true", why: "release week", scope: { kind: "project" } }]);
    expect((await call(aOnly, "train_freeze", { repo: "wynn-dev/testbed", frozen: false })).body.train.frozen).toBe(false);
    expect((await call(aOnly, "decisions_search", { query: "freeze" })).body.decisions).toEqual([]);

    for (const type of ["change.needs_rebase", "change.queued"] as const) await hub.append({ at: AT, type, machineId: "lab-a" as MachineId, summary: type });
    const attention = (await call(aOnly, "fleetd_status")).body.attention.map((e: { type: string }) => e.type);
    expect(attention).toContain("change.needs_rebase");
    expect(attention).not.toContain("change.queued");
  });
});

describe("webhook subscriptions", () => {
  it("returns the secret once, refuses non-http URLs, and delivers from a subscription made over MCP", async () => {
    const { hub, as } = await fleet();
    const client = await as("aOnly");
    const refused = await call(client, "subscription_set", { url: "file:///etc/passwd", clientRequestId: "s0" });
    expect(refused).toMatchObject({ isError: true, body: { code: "invalid" } });
    expect((await call(client, "subscription_set", { url: "https://x.test/h", machines: ["lab-b"], clientRequestId: "s1" })).body).toMatchObject({
      code: "forbidden",
    });

    const set = await call(client, "subscription_set", { url: "https://x.test/h", types: ["machine.offline"], clientRequestId: "s2" });
    expect(set.body).toMatchObject({ subscriptionId: expect.stringMatching(/^sub_/u), secret: expect.stringMatching(/^whsec_/u) });
    const listed = (await call(client, "subscription_list")).body;
    expect(listed.subscriptions).toEqual([
      { subscriptionId: set.body.subscriptionId, kind: "webhook", url: "https://x.test/h", types: ["machine.offline"], machines: "*", createdBy: expect.any(String), state: "active", lastDeliveredSeq: 0 },
    ]);
    expect(JSON.stringify(listed)).not.toContain(set.body.secret);

    await hub.append({ at: AT, type: "machine.offline", machineId: "lab-a" as MachineId, summary: "lab-a went offline" });
    await hub.posted(1);
    expect(JSON.parse(hub.posts[0]!.body)).toMatchObject({ seq: 1, type: "machine.offline" });

    expect((await call(client, "subscription_delete", { subscriptionId: set.body.subscriptionId })).body).toEqual({ ok: true });
    expect((await call(client, "subscription_delete", { subscriptionId: set.body.subscriptionId })).body).toMatchObject({ code: "not_found" });
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

describe("queued writes and wakes", () => {
  it("queues thread_send to an offline machine and delivers it when the machine is back", async () => {
    const { hub, as } = await fleet();
    hub.connected.delete("lab-a");
    await hub.addThread(thread("lab-a", "p-lab-a", "t1"));
    const client = await as("admin");
    const sent = await call(client, "thread_send", { machineId: "lab-a", threadId: "t1", message: "hi", clientRequestId: "r2" });
    expect(sent).toMatchObject({ isError: false, body: { queued: true, queuedUntil: expect.any(String), next: expect.stringContaining("write.delivered") } });
    const unknown = await call(client, "thread_send", { machineId: "lab-a", threadId: "nope", message: "hi", clientRequestId: "r3" });
    expect(unknown.body.code).toBe("not_found");
    expect(hub.calls).toEqual([]);
    hub.goLive("lab-a");
    const page = (await call(client, "events_wait", { cursor: 0, types: ["write.delivered"], timeoutSec: 5 })).body;
    expect(page.events).toMatchObject([{ type: "write.delivered", machineId: "lab-a", threadId: "t1", data: { clientRequestId: "r2", runId: "r1" } }]);
    expect(hub.calls).toEqual([{ op: "send", args: { ref: { machineId: "lab-a", threadId: "t1" }, message: "hi", clientRequestId: "r2" } }]);
  });

  it("sets, lists and cancels wakes within the key's grants", async () => {
    const { hub, as } = await fleet();
    await hub.addThread(thread("lab-a", "p-lab-a", "t1"));
    await hub.addThread(thread("lab-b", "p-lab-b", "t2"));
    const wake = (machineId: string, threadId: string, clientRequestId: string) => ({
      target: { machineId, threadId },
      schedule: { kind: "cron", cron: "0 9 * * 1-5", tz: "Europe/London" },
      message: "morning check",
      clientRequestId,
    });
    const aOnly = await as("aOnly");
    const set = await call(aOnly, "wake_set", wake("lab-a", "t1", "w1"));
    expect(set.body).toMatchObject({ wakeId: expect.stringMatching(/^wk_/u), nextRunAt: expect.any(String) });
    expect((await call(aOnly, "wake_set", wake("lab-a", "t1", "w1"))).body.wakeId).toBe(set.body.wakeId);
    expect((await call(aOnly, "wake_set", wake("lab-b", "t2", "w2"))).body.code).toBe("forbidden");
    const bad = await call(aOnly, "wake_set", { ...wake("lab-a", "t1", "w3"), schedule: { kind: "cron", cron: "0 25 * * *", tz: "UTC" } });
    expect(bad.body).toMatchObject({ code: "invalid", message: expect.stringContaining("hour 25") });
    const past = await call(aOnly, "wake_set", { ...wake("lab-a", "t1", "w4"), schedule: { kind: "at", at: "2020-01-01T00:00:00Z", tz: "UTC" } });
    expect(past.body).toMatchObject({ code: "invalid", message: expect.stringContaining("in the past") });

    const admin = await as("admin");
    const other = (await call(admin, "wake_set", wake("lab-b", "t2", "w5"))).body.wakeId;
    expect((await call(aOnly, "wake_list")).body.wakes.map((w: { wakeId: string }) => w.wakeId)).toEqual([set.body.wakeId]);
    expect((await call(admin, "wake_list", { machineId: "lab-b" })).body.wakes).toMatchObject([
      { wakeId: other, state: "active", once: true, catchUp: "fire_once" },
    ]);
    expect((await call(aOnly, "wake_cancel", { wakeId: other })).body.code).toBe("not_found");
    expect((await call(await as("reader"), "wake_cancel", { wakeId: set.body.wakeId })).body.code).toBe("forbidden");
    expect((await call(aOnly, "wake_cancel", { wakeId: set.body.wakeId })).body).toEqual({ ok: true });
    expect((await call(aOnly, "wake_list", { state: "cancelled" })).body.wakes).toMatchObject([{ wakeId: set.body.wakeId, state: "cancelled" }]);
  });
});

describe("M3 tools", () => {
  it("starts a lead with per-project model and effort and shows it with open workstreams in project_get", async () => {
    const { hub, as } = await fleet();
    const client = await as("aOnly");
    const ref = { machineId: "lab-a", projectId: "p-lab-a" };
    const started = await call(client, "lead_start", { ...ref, model: "claude-haiku-5-5", effort: "low" });
    expect(started.body).toMatchObject({ threadId: "t-new", state: "starting", sessionGeneration: 0 });
    expect(hub.calls[0]).toMatchObject({ op: "launch", args: { input: { model: "claude-haiku-5-5", effort: "low", projectId: "p-lab-a" } } });
    expect((await call(client, "lead_start", { machineId: "lab-b", projectId: "p-lab-b" })).body.code).toBe("forbidden");

    const intake = await call(client, "intake_submit", { ...ref, text: "add a /health endpoint", clientRequestId: "i1" });
    expect(intake.body).toMatchObject({ workstreamId: "W1", echo: { projectRef: ref, template: "feature" } });
    const outcome = (await call(client, "project_get", ref)).body;
    expect(outcome.lead).toMatchObject({ threadId: "t-new" });
    expect(outcome.workstreams).toMatchObject([{ workstreamId: "W1", state: "draft", source: { channel: "mcp", text: "add a /health endpoint" } }]);
    expect((await call(client, "workstream_get", { workstreamId: "W1" })).body).toMatchObject({ workstream: { state: "draft" }, asks: [], decisions: [] });
    // No project: @<name> picks one of the key's projects; otherwise the router (none in tests) leaves an unrouted ask.
    expect((await call(client, "intake_submit", { text: "@p-lab-a fix: typo", clientRequestId: "i2" })).body).toMatchObject({
      workstreamId: "W2",
      echo: { projectRef: ref, template: "bugfix" },
    });
    expect((await call(client, "intake_submit", { text: "@p-lab-b fix: typo", clientRequestId: "i3" })).body.code).toBe("not_found");
    expect((await call(client, "intake_submit", { text: "tidy the docs", clientRequestId: "i4" })).body).toMatchObject({ askId: "A1" });
    expect((await call(client, "asks_list")).body.asks).toMatchObject([{ askId: "A1", key: expect.stringMatching(/^intake\.route\./u), options: ["p-lab-a on lab-a"] }]);
  });

  it("shows and answers only asks on the key's machines, recording the key as the decision's author", async () => {
    const { hub, as } = await fleet();
    await hub.fileAsk("lab-a", "p-lab-a", "api.health.path", "/healthz");
    await hub.fileAsk("lab-b", "p-lab-b", "db.engine", "sqlite");
    const aOnly = await as("aOnly");

    const listed = (await call(aOnly, "asks_list")).body;
    expect(listed.asks.map((a: { askId: string }) => a.askId)).toEqual(["A1"]);
    expect(listed.batches).toMatchObject([{ batchId: "B1", items: [{ number: 1, askId: "A1" }] }]);

    const refused = (await call(aOnly, "inbox_reply", { raw: "recs fine" })).body;
    expect(refused).toMatchObject({ parsed: false, applied: [], hint: expect.stringContaining("Item 2 is about lab-b/p-lab-b") });
    expect((await call(aOnly, "inbox_reply", { raw: "pref: short answers" })).body.parsed).toBe(false);

    const answered = (await call(aOnly, "inbox_reply", { raw: "1 go" })).body;
    expect(answered).toMatchObject({ parsed: true, echo: "Logged: 1 → /healthz (D1)", applied: [{ source: "agent", by: "a-only" }] });

    const global = { key: "policy.tz", value: "UTC", scope: { kind: "global" } };
    expect((await call(aOnly, "decisions_record", global)).body.code).toBe("forbidden");
    expect((await call(await as("admin"), "decisions_record", global)).body.decision).toMatchObject({ source: "agent", by: "admin" });
    await call(await as("admin"), "decisions_record", {
      key: "db.engine",
      value: "postgres",
      scope: { kind: "project", projectRef: { machineId: "lab-b", projectId: "p-lab-b" } },
    });
    const search = async (who: "aOnly" | "reader", query: string) =>
      (await call(who === "aOnly" ? aOnly : await as("reader"), "decisions_search", { query })).body.decisions.map((d: { key: string }) => d.key);
    expect(await search("aOnly", "healthz postgres utc")).toEqual(expect.arrayContaining(["api.health.path", "policy.tz"]));
    expect(await search("aOnly", "postgres")).toEqual([]);
    expect(await search("reader", "postgres")).toEqual(["db.engine"]);

    const digest = (await call(aOnly, "digest_get")).body.text as string;
    expect(digest).toContain("fleetd digest");
    expect(digest).not.toContain("p-lab-b");
    expect((await call(await as("reader"), "digest_get")).body.text).toContain("p-lab-b");
  });
});

describe("M5 tools", () => {
  const task = (machineId: string, projectId: string, over: Record<string, unknown> = {}) =>
    ({
      projectRef: { machineId, projectId },
      workstreamId: "W1",
      title: "add file",
      kind: "write",
      prompt: "create docs/x.md",
      areas: ["docs"],
      model: "claude-haiku-5-5",
      effort: "low",
      state: "running",
      attempt: 1,
      createdAt: AT,
      ...over,
    }) as never;

  it("shows tasks as counts and a list in project_get, never in its threads, and lists them within the key's grants", async () => {
    const { hub, as } = await fleet();
    await hub.addThread(thread("lab-a", "p-lab-a", "t-lead"));
    await hub.addThread(thread("lab-a", "p-lab-a", "t-task"));
    await hub.addTask(task("lab-a", "p-lab-a", { threadRef: { machineId: "lab-a", threadId: "t-task" }, branch: "fleetd/T1-add-file" }));
    // Not "queued": the live task service would pick that up and start it.
    await hub.addTask(task("lab-a", "p-lab-a", { title: "second", state: "failed" }));
    await hub.addTask(task("lab-b", "p-lab-b", { state: "done" }));
    const aOnly = await as("aOnly");

    const outcome = (await call(aOnly, "project_get", { machineId: "lab-a", projectId: "p-lab-a" })).body;
    expect(outcome.threads.map((t: { threadId: string }) => t.threadId)).toEqual(["t-lead"]);
    expect(outcome.taskCounts).toEqual({ queued: 0, running: 1, idle: 0, done: 0, failed: 1, cancelled: 0 });
    expect(outcome.tasks.map((t: { taskId: string }) => t.taskId)).toEqual(["T2", "T1"]);

    expect((await call(aOnly, "tasks_list")).body.tasks.map((t: { taskId: string }) => t.taskId)).toEqual(["T2", "T1"]);
    expect((await call(aOnly, "tasks_list", { state: "failed" })).body.tasks).toMatchObject([{ taskId: "T2", title: "second" }]);
    expect((await call(aOnly, "tasks_list", { projectRef: { machineId: "lab-b", projectId: "p-lab-b" } })).body.code).toBe("forbidden");
    expect((await call(aOnly, "task_get", { taskId: "T1" })).body).toMatchObject({ task: { branch: "fleetd/T1-add-file" }, next: expect.stringContaining("t-task") });
    expect((await call(aOnly, "task_get", { taskId: "T3" })).body.code).toBe("not_found");
    expect((await call(await as("reader"), "task_get", { taskId: "T3" })).body.task.state).toBe("done");
  });

  it("sets the cap and a project's share for admins only, and shows the board in fleetd_status", async () => {
    const { as } = await fleet();
    expect((await call(await as("aOnly"), "cap_set", { cap: 1 })).body.code).toBe("forbidden");
    const admin = await as("admin");
    const set = (await call(admin, "cap_set", { cap: 10, share: { projectRef: { machineId: "lab-a", projectId: "p-lab-a" }, share: 3 } })).body;
    expect(set.slots).toMatchObject({ cap: 10, used: 0, queued: 0, reservedBand: 1, perProject: [{ projectRef: { projectId: "p-lab-a" }, share: 3 }] });
    expect((await call(admin, "cap_set", { share: { projectRef: { machineId: "lab-a", projectId: "nope" }, share: 1 } })).body.code).toBe("not_found");
    expect((await call(admin, "cap_set", {})).isError).toBe(true);
    expect((await call(await as("reader"), "fleetd_status")).body.slots).toMatchObject({ cap: 10, used: 0 });
  });
});

describe("usage tools", () => {
  it("usage_status shows each readable machine's login, breaker and probe counter; usage_resume needs operate there", async () => {
    const { hub, as } = await fleet();
    const reader = await as("reader");
    const quiet = await call(reader, "usage_status");
    expect(quiet.isError).toBe(false);
    expect(quiet.body.machines.map((m: { machineId: string }) => m.machineId).toSorted()).toEqual(["lab-a", "lab-b"]);
    expect(quiet.body.machines[0]).toMatchObject({ login: "subscription", breaker: { state: "closed" }, parked: { leads: 0, tasks: 0 }, probes: { observable: false } });

    // The executor's event for a proxy 400 on a thread no lead or task owns: the breaker opens all the same.
    await hub.append({
      at: AT,
      type: "thread.usage_limited",
      machineId: "lab-a" as MachineId,
      threadId: "x1" as ThreadId,
      summary: '"x1" on lab-a hit the usage limit: your proxy has no account available for claude-opus-5-5',
      data: { status: "failed", usageClass: "pool_exhausted", model: "claude-opus-5-5" },
    });
    const paused = await call(reader, "usage_status", { machineId: "lab-a" });
    expect(paused.body.machines).toHaveLength(1);
    expect(paused.body.machines[0].breaker).toMatchObject({ state: "open", class: "pool_exhausted" });
    expect(paused.body.next).toContain("Paused: lab-a");
    expect((await call(reader, "fleetd_status")).body.attention.map((e: { type: string }) => e.type)).toContain("usage.breaker");

    expect((await call(reader, "usage_resume", { machineId: "lab-a" })).body.code).toBe("forbidden");
    const aOnly = await as("aOnly");
    expect((await call(aOnly, "usage_resume", { machineId: "lab-b" })).body.code).toBe("forbidden");
    const resumed = await call(aOnly, "usage_resume", { machineId: "lab-a" });
    expect(resumed.isError).toBe(false);
    expect(resumed.body).toMatchObject({ resumed: 0, status: { breaker: { state: "closed" } } });
  });

  it("refuses thread_launch on a paused machine with the pause and a fix, and launches again after usage_resume", async () => {
    const { hub, as } = await fleet();
    const admin = await as("admin");
    await hub.append({
      at: AT,
      type: "thread.usage_limited",
      machineId: "lab-a" as MachineId,
      threadId: "x1" as ThreadId,
      summary: '"x1" on lab-a hit the usage limit: your proxy has no account available for claude-opus-5-5',
      data: { status: "failed", usageClass: "pool_exhausted", model: "claude-opus-5-5" },
    });
    // usage_status drains the usage layer, so the breaker is open before the launch.
    expect((await call(admin, "usage_status", { machineId: "lab-a" })).body.machines[0].breaker.state).toBe("open");
    expect(await call(admin, "thread_launch", { machineId: "lab-a", ...launch })).toEqual({
      isError: true,
      body: {
        code: "invalid",
        message: "Not launched: usage: paused until usage_resume (your proxy has no account for claude-opus-5-5).",
        fix: "Wait for the reset (usage_status shows it), or run usage_resume with machineId lab-a once the login has capacity again.",
      },
    });
    expect(hub.calls).toEqual([]);
    // Only lab-a's login is paused.
    expect((await call(admin, "thread_launch", { machineId: "lab-b", ...launch, projectId: "p-lab-b" })).isError).toBe(false);

    await call(admin, "usage_resume", { machineId: "lab-a" });
    expect((await call(admin, "thread_launch", { machineId: "lab-a", ...launch, clientRequestId: "r2" })).body.threadId).toBe("t-new");
  });
});

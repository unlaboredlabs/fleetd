import { expect, test } from "bun:test";
import { registerAll } from "../src/hub/serve/areas.ts";
import { Hub } from "../src/hub/api/hub.ts";
import { type Caller, Registry } from "../src/hub/api/registry.ts";
import { channel, hubStep } from "../src/hub/info/index.ts";
import { leads } from "../src/hub/leads/index.ts";
import { HubDb } from "../src/hub/store/db.ts";
import { events } from "../src/hub/store/events.ts";
import { store } from "../src/hub/store/hub_store.ts";
import { TaskRecords } from "../src/hub/tasks/records.ts";
import { fingerprintOf, platformUuid } from "../src/shared/fingerprint.ts";
import type { Grant, HubInfoOutput } from "../src/shared/contracts.ts";

const AT = "2026-10-19T10:00:00.000Z";

function setup(url?: string) {
  const hub = new Hub({ home: "", listen: { host: "127.0.0.1", port: 4790 }, ...(url ? { url } : {}) }, HubDb.memory(), { now: () => Date.parse(AT) });
  store(hub).projectsUpsertMany("devbox", [
    { machineId: "devbox", projectId: "p1", title: "storefront", workspaceRoot: "/w", lastActivityAt: AT } as never,
  ]);
  const tools = new Registry();
  registerAll(tools);
  const call = async (grants: Grant[], input: unknown = {}) => {
    const caller: Caller = { keyId: "k", name: "k", prefix: "fld_x", grants, createdAt: AT };
    const out = await tools.call(hub, caller, "hub_info", input);
    if (!("output" in out)) throw new Error(JSON.stringify(out));
    return out.output as HubInfoOutput;
  };
  return { hub, call };
}

const putThread = (hub: Hub, id: string, status: string) =>
  store(hub).threadUpsert({
    thread: { machineId: "devbox", threadId: id, projectId: "p1", title: id, status, headline: "", latestMessageTail: "", lastProgressAt: AT, stale: false, asOf: AT } as never,
  });

test("a build follows the channel its version names", () => {
  expect(channel("0.5.0-edge.20261019.abc1234", true)).toBe("edge");
  expect(channel("0.5.0-nightly.20261019.abc1234", false)).toBe("edge");
  expect(channel("0.4.1", true)).toBe("stable");
  expect(channel("0.0.0", false)).toBeUndefined();
});

test("an idle hub reports its version and nothing busy; admin only for a key with admin everywhere", async () => {
  const { hub, call } = setup("https://hub.example.com/");
  leads(hub).records.leadPut({ projectRef: { machineId: "devbox", projectId: "p1" }, threadId: "lead-thread", startedAt: AT, sessionGeneration: 1 } as never);
  putThread(hub, "lead-thread", "idle");
  const out = await call([{ role: "read", machines: "*" }]);
  expect(out.version).toBe("0.0.0");
  expect(out.busy).toEqual([]);
  expect(out.admin).toBe(false);
  expect(out.next).toBe("Nothing runs: restarting the hub now interrupts nothing.");
  expect(out.url).toBe("https://hub.example.com");
  expect(out.people).toBe(0);
  expect((await call([{ role: "admin", machines: "*" }])).admin).toBe(true);
  expect((await call([{ role: "admin", machines: ["devbox"] }])).admin).toBe(false);
  // Loopback is no address another hub reaches.
  expect((await setup().call([{ role: "read", machines: "*" }])).url).toBeUndefined();
});

test("a working lead, running agents and a clone are busy; a node's restart cuts off only its own", async () => {
  const { hub, call } = setup();
  leads(hub).records.leadPut({ projectRef: { machineId: "devbox", projectId: "p1" }, threadId: "lead-thread", startedAt: AT, sessionGeneration: 1 } as never);
  putThread(hub, "lead-thread", "running");
  TaskRecords.create(hub.db.conn, {
    taskId: "T1", projectRef: { machineId: "devbox", projectId: "p1" }, workstreamId: "W1", title: "the checkout page", kind: "read",
    prompt: "do it", model: "claude-opus-5-5", effort: "high", state: "running", attempt: 1, createdAt: AT, startedAt: AT,
    threadRef: { machineId: "devbox", threadId: "t1" },
  } as never);
  events(hub).append({
    at: AT, type: "project.clone_progress", machineId: "buildbox", summary: "cloning",
    data: { addId: "a1", repo: "acme/shop", path: "/src/shop", phase: "receiving" },
  });
  const out = await call([{ role: "read", machines: "*" }]);
  expect(out.busy.map((i) => [i.kind, i.text])).toEqual([
    ["lead", "the storefront lead is working"],
    ["agent", "T1 in storefront: the checkout page"],
    ["clone", "cloning acme/shop on buildbox"],
  ]);
  expect(out.busy[1]?.since).toBe(AT);
  const on = await call([{ role: "read", machines: "*" }], { machineId: "buildbox" });
  expect(on.busy.map((i) => i.kind)).toEqual(["clone"]);
  // Once the clone ends, it is no longer busy.
  events(hub).append({ at: AT, type: "project.added", machineId: "buildbox", summary: "added", data: { addId: "a1" } });
  expect((await call([{ role: "read", machines: "*" }], { machineId: "buildbox" })).busy).toEqual([]);
});

test("a merge counts only while the hub rebases or merges it", () => {
  const change = (state: string) => ({ prNumber: 251, repo: "acme/shop", state }) as never;
  expect(hubStep(change("rebasing"))).toBe("updating PR #251 in acme/shop before it merges");
  expect(hubStep(change("merging"))).toBe("merging PR #251 into acme/shop");
  expect(hubStep(change("ci"))).toBeUndefined();
  expect(hubStep(change("ready"))).toBeUndefined();
});

test("the machine fingerprint is a hash of the OS id, never the id", () => {
  expect(fingerprintOf(" abc\n")).toBe(fingerprintOf("abc"));
  expect(fingerprintOf("abc")).toMatch(/^[0-9a-f]{64}$/);
  expect(platformUuid('    "IOPlatformUUID" = "1234-ABCD"\n')).toBe("1234-ABCD");
});

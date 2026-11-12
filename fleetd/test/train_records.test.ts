// The train's records and `changes_list`: Changes numbered per hub and lined
// up per repo, drafts at the back, the newest open one per PR, and the list filtered by grant.
import { expect, test } from "bun:test";
import { registerAll } from "../src/hub/serve/areas.ts";
import { Hub } from "../src/hub/api/hub.ts";
import { Registry, type Caller } from "../src/hub/api/registry.ts";
import { HubDb } from "../src/hub/store/db.ts";
import { ChangeRecords, DRAFT, encode } from "../src/hub/train/records.ts";
import type { Change } from "../src/shared/contracts.ts";

const AT = "2026-10-22T10:00:00.000Z";
const SHA = "a".repeat(40);

function change(project: string, n: number, extra: Partial<Change> = {}): Change {
  return {
    changeId: "X0",
    projectRef: { machineId: "devbox", projectId: project },
    repo: "Acme/Web",
    prNumber: n,
    prUrl: `https://github.com/acme/web/pull/${n}`,
    branch: `fleetd/T${n}-x`,
    workstreamId: "W1",
    headSha: SHA,
    state: "queued",
    reviews: [],
    createdAt: AT,
    updatedAt: AT,
    ...extra,
  };
}

function lab() {
  const hub = new Hub({ home: "/nonexistent", listen: { host: "127.0.0.1", port: 0 } }, HubDb.memory(), { now: () => Date.parse(AT) });
  const tools = new Registry();
  registerAll(tools);
  return { hub, tools, records: new ChangeRecords(hub.db) };
}

test("Changes are numbered, lined up per repo with drafts at the back, and stored as the Rust hub stores them", () => {
  const { records } = lab();
  const a = records.create(change("web", 7));
  const b = records.create(change("web", 8, { lastError: DRAFT }));
  const c = records.create(change("web", 9, { state: "ready" }));
  expect([a.changeId, b.changeId, c.changeId, a.repo]).toEqual(["X1", "X2", "X3", "acme/web"]);
  expect(records.trainState("ACME/web")).toEqual({ repo: "acme/web", queue: ["X1", "X3", "X2"] });
  expect(records.positioned([records.get("X3")!])[0]!.position).toBe(1);
  expect(Object.keys(JSON.parse(encode(a)))).toEqual([
    "changeId", "projectRef", "repo", "prNumber", "prUrl", "branch", "workstreamId", "headSha", "state", "reviews", "createdAt", "updatedAt",
  ]);
  records.put({ ...a, state: "merged" });
  expect(records.openFor("acme/web", 7)).toBeUndefined();
  expect(records.latestFor("acme/web", 7)!.state).toBe("merged");
  expect(records.anyMerged({ machineId: "devbox", projectId: "web" }, "W1")).toBe(true);
  expect(records.unlanded({ machineId: "devbox", projectId: "web" }, "W1").map((x) => x.changeId)).toEqual(["X2", "X3"]);
  records.note("X3", "x".repeat(3000));
  expect(records.get("X3")!.lastError!.length).toBe(2000);
});

test("changes_list filters by grant, and lists a project that was another person's Only me one (D491)", async () => {
  const { hub, tools, records } = lab();
  records.create(change("web", 7));
  records.create(change("inbox", 8));
  hub.db.conn.query("INSERT INTO people (person_id, name, role, created_ms) VALUES ('P1', 'Owner', 'owner', 1), ('P2', 'Sam', 'member', 2)").run();
  hub.db.conn.query("INSERT INTO project_settings (machine_id, project_id, only_me, owner_person) VALUES ('devbox', 'inbox', 1, 'P2')").run();
  const owner: Caller = { keyId: "k", name: "k", prefix: "fld_aaaaaa", grants: [{ role: "read", machines: "*" }], createdAt: AT };
  const out = await tools.call(hub, owner, "changes_list", {});
  expect("output" in out && (out.output as any).changes.map((c: Change) => c.changeId).sort()).toEqual(["X1", "X2"]);
  const sam: Caller = { ...owner, kind: "human", person: { personId: "P2", name: "Sam" } };
  const theirs = await tools.call(hub, sam, "changes_list", { limit: 1 });
  expect("output" in theirs && (theirs.output as any)).toMatchObject({ changes: [{}], truncated: true });
  const elsewhere: Caller = { ...owner, grants: [{ role: "read", machines: ["other"] }] };
  const none = await tools.call(hub, elsewhere, "changes_list", { projectRef: { machineId: "devbox", projectId: "web" } });
  expect("error" in none && none.error.kind === "tool" && none.error.error.code).toBe("forbidden");
  const bad = await tools.call(hub, owner, "changes_list", { limit: 500 });
  expect("error" in bad && bad.error.kind).toBe("invalid");
});

test("other areas read the train through trainChanges and trainOf", async () => {
  const { trainChanges, trainOf } = await import("../src/hub/train/index.ts");
  const { hub, records } = lab();
  records.ensureTrain("acme/web", { machineId: "devbox", projectId: "web" }, 5);
  records.create(change("web", 7));
  records.create(change("other", 8));
  expect(trainChanges(hub, { projectRef: { machineId: "devbox", projectId: "web" }, limit: 10 }).map((c) => [c.changeId, c.position])).toEqual([["X1", 0]]);
  expect(trainOf(hub, "ACME/web")).toEqual({ repo: "acme/web", projectRef: { machineId: "devbox", projectId: "web" }, watchSinceMs: 5 });
  expect(trainOf(hub, "acme/none")).toBeUndefined();
});

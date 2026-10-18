// Writes ts-hub.sqlite and ts-hub.json next to this file with the TS hub's own HubDb, HubStore, EventLog and Auth,
// so the Rust store's tests prove it opens and reads a TS hub's database unchanged. Run from a TS checkout:
//   node crates/fleetd/src/hub/store/fixtures/make-ts-hub.ts <fleetd checkout from before the Rust cutover, with node_modules>
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ts = path.resolve(process.argv[2] ?? ".");
const hub = (p: string) => import(path.join(ts, "apps/hub/src", p));
const fx = (p: string) => import(path.join(ts, "apps/hub/node_modules/effect/dist", `${p}.js`));
const [Effect, Layer, { TestClock }, HubDb, HubStore, EventLog, Auth] = await Promise.all([
  fx("Effect"),
  fx("Layer"),
  fx("testing/index"),
  hub("store/HubDb.ts"),
  hub("store/HubStore.ts"),
  hub("store/EventLog.ts"),
  hub("auth/Auth.ts"),
]);

const AT = Date.UTC(2026, 9, 17, 10, 0);
const iso = new Date(AT).toISOString();
const out = path.dirname(new URL(import.meta.url).pathname);
const home = fs.mkdtempSync(path.join(os.tmpdir(), "fleetd-ts-hub-"));

const program = Effect.gen(function* () {
  yield* TestClock.setTime(AT);
  const store = yield* HubStore.HubStore;
  const log = yield* EventLog.EventLog;
  const auth = yield* Auth.Auth;
  yield* store.machines.upsert({
    machineId: "lab-a", name: "Lab A", tags: ["lab"], status: "degraded", lastSeenAt: iso,
    t3: { version: "0.0.30", protocol: 1 }, nodeVersion: "0.1.0", degradedReason: "T3 is restarting", pubKey: "node-pub-a",
  });
  yield* store.projects.upsertMany("lab-a", [{
    machineId: "lab-a", projectId: "p1", title: "Fleetd Hub", workspaceRoot: "/src/fleetd",
    threads: { running: 1, waiting: 0, idle: 0, failed: 0 }, lastActivityAt: iso,
  }]);
  yield* store.threads.upsert({
    machineId: "lab-a", threadId: "t1", projectId: "p1", title: "t1", status: "running", headline: "working",
    latestMessageTail: "tail", lastProgressAt: iso, stale: false, asOf: iso, model: "claude-haiku-5-5",
    lastSequence: 7, lastRunId: "run-1", lastRunStatus: "running",
  });
  yield* store.cursors.set("lab-a", 42);
  yield* log.append({ at: iso, type: "machine.online", machineId: "lab-a", summary: "lab-a online" });
  yield* log.append({ at: iso, type: "thread.started", machineId: "lab-a", projectId: "p1", threadId: "t1", summary: "t1 started", data: { runId: "run-1" } });
  yield* log.append({ at: iso, type: "thread.completed", machineId: "lab-a", threadId: "t1", summary: "x".repeat(300), data: { blob: "y".repeat(3000) } });
  const agent = yield* auth.createKey("ci", [{ role: "operate", machines: ["lab-a"] }]);
  const human = yield* auth.createKey("desk", [{ role: "operate", machines: "*" }], "human");
  const revoked = yield* auth.createKey("old", [{ role: "read", machines: "*" }]);
  yield* auth.revoke(revoked.info.keyId);
  const enroll = yield* auth.createEnrollToken("lab-b");
  return { at: AT, agentKey: agent.key, humanKey: human.key, revokedKey: revoked.key, enrollToken: enroll.token };
});

const live = HubStore.layer.pipe(
  Layer.provideMerge(EventLog.layer),
  Layer.provideMerge(Auth.layer),
  Layer.provideMerge(HubDb.layer(home)),
  Layer.provideMerge(TestClock.layer()),
);
const secrets = await Effect.runPromise(Effect.scoped(Effect.provide(program, live)));
fs.copyFileSync(path.join(home, "hub.sqlite"), path.join(out, "ts-hub.sqlite"));
fs.writeFileSync(path.join(out, "ts-hub.json"), `${JSON.stringify(secrets, null, 2)}\n`);
fs.rmSync(home, { recursive: true });

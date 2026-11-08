// The hub's one-off turns and stopping a session, against a fake node (crates/fleetd/src/hub/executor/turn.rs,
// mod.rs `stop`): a turn launches, is recorded as its owner's, waits for its end, reads its last reply and stops it.
import { expect, test } from "bun:test";
import { executors, type HubToNodeSession } from "../src/hub/executor/index.ts";
import type { LaunchInput, LaunchOptions } from "../src/hub/executor/sessions.ts";
import { stop } from "../src/hub/executor/stop.ts";
import { ExecutorTurn, limitMs, Owner, turn } from "../src/hub/executor/turn.ts";
import { store } from "../src/hub/store/hub_store.ts";
import type { SessionLaunch, SessionOutput, SessionSummary } from "../src/shared/sessions.ts";
import { AT, kit } from "./work-kit.ts";

const settle = () => Bun.sleep(5);

async function node() {
  const k = kit();
  store(k.hub).machineUpsert({ machineId: "devbox", name: "devbox", nodeVersion: "1", status: "online", lastSeenAt: AT });
  const ex = executors(k.hub);
  const calls: HubToNodeSession[] = [];
  ex.attach("devbox", { linkId: 1, send: (f) => void calls.push(f) });
  const reply = (frame: HubToNodeSession, ok: SessionOutput) => ex.handleFrame("devbox", { t: "session_reply", id: frame.id, result: { ok } });
  const fail = (frame: HubToNodeSession, message: string) =>
    ex.handleFrame("devbox", { t: "session_reply", id: frame.id, result: { err: { code: "internal", message } } });
  await settle();
  reply(calls.shift()!, { kind: "done" });
  await ex.awaitLive("devbox");
  ex.handleFrame("devbox", { t: "machine_event", seq: 1, at: AT, event: { type: "snapshot", projects: [{ projectId: "p1", title: "P1", workspaceRoot: "/w", updatedAt: AT }], sessions: [] } });
  await settle();
  ex.rememberRunner("devbox", { runner: "claude", supported: ">=2", versionOk: true, login: "logged_in" });
  /** The next call of `op`. */
  const take = async (op: string) => {
    for (let i = 0; i < 50; i++) {
      const at = calls.findIndex((c) => c.call.op === op);
      if (at >= 0) return calls.splice(at, 1)[0]!;
      await settle();
    }
    throw new Error(`no ${op} call came`);
  };
  let seq = 1;
  const updated = (s: SessionSummary) => ex.handleFrame("devbox", { t: "machine_event", seq: ++seq, at: AT, event: { type: "session_updated", ...s } });
  return { ...k, ex, calls, reply, fail, take, updated };
}

const summary = (id: string, extra: Partial<SessionSummary> = {}): SessionSummary => ({
  sessionId: id,
  projectId: "p1",
  title: "fleetd approval check",
  status: "idle",
  model: "claude-haiku-5-5",
  effort: "low",
  runtimeMode: "approval-required",
  createdAt: AT,
  updatedAt: AT,
  ...extra,
});

const input = (req: string): LaunchInput => ({
  projectId: "p1",
  prompt: "the review",
  systemPrompt: "judge it",
  profile: "high",
  runtimeMode: "approval-required",
  title: "fleetd approval check",
  clientRequestId: req,
});
const options: LaunchOptions = { role: "plain", mcp: { userServers: false, servers: [] }, onlyTools: [], isolated: true };
const r = { machineId: "devbox", projectId: "p1" };

/** Launches the turn's session and starts its run; the run id and session id. */
async function launched(n: Awaited<ReturnType<typeof node>>) {
  const call = await n.take("launch");
  const l = call.call as { op: "launch" } & SessionLaunch;
  expect([l.allowedTools, l.allowedOnly, l.isolated, l.systemPrompt]).toEqual([[], true, true, "judge it"]);
  n.reply(call, { kind: "launched", summary: summary(l.sessionId) });
  await settle();
  n.updated(summary(l.sessionId, { status: "running", activeRunId: l.runId, latestRun: { id: l.runId, status: "running", ordinal: 1 } }));
  await settle();
  return { runId: l.runId, sessionId: l.sessionId };
}

test("a turn is recorded as its owner's, waits for its end, answers its last reply and is stopped", async () => {
  const n = await node();
  const answer = turn(n.hub, Owner.ApprovalCheck).run(r, "person-1", input("check-1"), options);
  const { runId, sessionId } = await launched(n);
  const row = n.hub.db.conn.query("SELECT project_id, person_id FROM approval_checks WHERE machine_id = 'devbox' AND thread_id = ?").get(sessionId);
  expect(row).toEqual({ project_id: "p1", person_id: "person-1" });
  // The active run's follow brings the reply.
  const follow = await n.take("follow");
  n.reply(follow, { kind: "done" });
  n.ex.handleFrame("devbox", {
    t: "thread_event",
    sessionId,
    at: AT,
    event: {
      type: "snapshot",
      summary: summary(sessionId),
      truncated: false,
      runs: [{ id: runId, status: "completed", ordinal: 1 }],
      messages: [
        { id: "m1", runId, role: "assistant", text: "thinking", createdAt: "2026-10-17T10:01:00.000Z" },
        { id: "m2", runId, role: "assistant", text: '{"verdict":"go"}', createdAt: "2026-10-17T10:02:00.000Z" },
        { id: "m3", runId, role: "assistant", text: "  ", createdAt: "2026-10-17T10:03:00.000Z" },
      ],
      items: [],
    },
  });
  n.updated(summary(sessionId, { status: "idle", latestRun: { id: runId, status: "completed", ordinal: 1 } }));
  const stopped = await n.take("stop");
  expect(stopped.call).toEqual({ op: "stop", sessionId, removeWorktree: false });
  n.reply(stopped, { kind: "done" });
  expect(await answer).toBe('{"verdict":"go"}');
});

test("a failed turn says it stopped before it answered; a memory import is recorded as one", async () => {
  const n = await node();
  const answer = turn(n.hub, Owner.MemoryImport).run(r, undefined, input("import-1"), options);
  const { runId, sessionId } = await launched(n);
  expect(n.hub.db.conn.query("SELECT person_id FROM memory_imports WHERE thread_id = ?").get(sessionId)).toEqual({ person_id: null });
  n.updated(summary(sessionId, { status: "failed", latestRun: { id: runId, status: "failed", ordinal: 1 } }));
  // A stop the node fails only warns: the turn's own answer stands.
  n.fail(await n.take("stop"), "no such process");
  let why = "";
  await answer.catch((e: Error) => (why = e.message));
  expect(why).toBe("it stopped before it answered");
});

test("a turn past its time is stopped and fails; the owners' limits are Rust's", async () => {
  const n = await node();
  const answer = new ExecutorTurn(n.hub, Owner.ApprovalCheck, 50).run(r, undefined, input("check-2"), options);
  const { sessionId } = await launched(n);
  const stopped = await n.take("stop");
  expect(stopped.call).toEqual({ op: "stop", sessionId, removeWorktree: false });
  n.reply(stopped, { kind: "done" });
  let why = "";
  await answer.catch((e: Error) => (why = e.message));
  expect(why).toBe("it ran past its time");
  expect([limitMs(Owner.MemoryImport), limitMs(Owner.ApprovalCheck)]).toEqual([240_000, 120_000]);
});

test("a refused launch fails the turn and records nothing", async () => {
  const n = await node();
  n.ex.rememberRunner("devbox", { runner: "claude", supported: ">=2", versionOk: true, login: "logged_out" });
  let why = "";
  await turn(n.hub, Owner.ApprovalCheck)
    .run(r, undefined, input("check-3"), options)
    .catch((e: Error) => (why = e.message));
  expect(why).toContain("Claude Code is not logged in on this machine");
  expect(n.hub.db.conn.query("SELECT count(*) AS n FROM approval_checks").get()).toEqual({ n: 0 });
});

test("stop sends the node's stop, removing the worktree when asked", async () => {
  const n = await node();
  const t = { machineId: "devbox", threadId: "s9" };
  const stopping = stop(n.hub, t, true);
  const call = await n.take("stop");
  expect(call.call).toEqual({ op: "stop", sessionId: "s9", removeWorktree: true });
  n.reply(call, { kind: "done" });
  await stopping;
  const unknown = stop(n.hub, { machineId: "devbox", threadId: "nope" });
  n.ex.handleFrame("devbox", { t: "session_reply", id: (await n.take("stop")).id, result: { err: { code: "not_found", message: "no session nope" } } });
  let why = "";
  await unknown.catch((e: Error) => (why = e.message));
  expect(why).toBe("thread nope is not known on machine devbox");
});

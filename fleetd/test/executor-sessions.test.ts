// The executor's session calls against a fake node (crates/fleetd/src/hub/executor/fake_node_tests.rs's
// launch_send_interrupt_and_a_permission_answer test): a launch, its retry, a send, a prompt, an interrupt.
import { expect, test } from "bun:test";
import { executors, type HubToNodeSession } from "../src/hub/executor/index.ts";
import { answer, found, interrupt, latestRun, launch, send, startedRun, withdraw } from "../src/hub/executor/sessions.ts";
import { profiles } from "../src/hub/projects/profiles.ts";
import { events } from "../src/hub/store/events.ts";
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
  const fail = (frame: HubToNodeSession, code: "not_found", message: string) =>
    ex.handleFrame("devbox", { t: "session_reply", id: frame.id, result: { err: { code, message } } });
  await settle();
  reply(calls.shift()!, { kind: "done" });
  await ex.awaitLive("devbox");
  ex.handleFrame("devbox", { t: "machine_event", seq: 1, at: AT, event: { type: "snapshot", projects: [{ projectId: "p1", title: "P1", workspaceRoot: "/w", updatedAt: AT }], sessions: [] } });
  await settle();
  // The runner is known, so a launch doesn't ask the node about it first.
  ex.rememberRunner("devbox", { runner: "claude", supported: ">=2", versionOk: true, login: "logged_in" });
  /** The next call, skipping the follows active sessions bring. */
  const next = async () => {
    for (let i = 0; i < 50; i++) {
      const at = calls.findIndex((c) => c.call.op !== "follow");
      if (at >= 0) return calls.splice(at, 1)[0]!;
      await settle();
    }
    throw new Error("no call came");
  };
  return { ...k, ex, calls, reply, fail, next };
}

const summary = (id: string, extra: Partial<SessionSummary> = {}): SessionSummary => ({
  sessionId: id,
  projectId: "p1",
  title: "say OK",
  status: "idle",
  model: "claude-haiku-5-5",
  effort: "low",
  runtimeMode: "approval-required",
  createdAt: AT,
  updatedAt: AT,
  ...extra,
});

const input = (req: string) => ({ projectId: "p1", prompt: "reply with the word OK", profile: "medium", runtimeMode: "approval-required" as const, clientRequestId: req });

test("launch, send, a permission prompt and an interrupt go out as session calls", async () => {
  const { hub, ex, reply, fail, next } = await node();
  found.toolRules = async () => ({ allow: ["Bash(npm test:*)"], deny: ["WebFetch"] });
  const launched = launch(hub, "devbox", input("req-1"));
  const call = await next();
  const l = call.call as { op: "launch" } & SessionLaunch;
  const medium = profiles(hub).byName("medium")!;
  expect([l.op, l.profile, l.model, l.effort, l.fast]).toEqual(["launch", "medium", medium.model, medium.effort, undefined]);
  expect(l.helperModel).toBe(profiles(hub).defaultProfile().model);
  expect([l.prompt, l.title, l.workspace, l.runtimeMode]).toEqual(["reply with the word OK", "reply with the word OK", { type: "root" }, "approval-required"]);
  expect([l.allowedTools, l.disallowedTools]).toEqual([["Bash(npm test:*)"], ["WebFetch"]]);
  reply(call, { kind: "launched", summary: summary(l.sessionId) });
  expect((await launched).threadId).toBe(l.sessionId);
  // A retry lands on the same session and run.
  const again = launch(hub, "devbox", input("req-1"));
  const retry = await next();
  expect([(retry.call as SessionLaunch).sessionId, (retry.call as SessionLaunch).runId]).toEqual([l.sessionId, l.runId]);
  reply(retry, { kind: "launched", summary: summary(l.sessionId) });
  await again;
  delete found.toolRules;

  // The run starts.
  const r = { machineId: "devbox", threadId: l.sessionId };
  ex.handleFrame("devbox", {
    t: "machine_event",
    seq: 2,
    at: AT,
    event: { type: "session_updated", ...summary(l.sessionId, { status: "running", activeRunId: l.runId, latestRun: { id: l.runId, status: "running", ordinal: 1 } }) },
  });
  await settle();
  expect(events(hub).page(0).events.map((e) => e.type)).toEqual(["thread.started"]);
  expect(latestRun(hub, r)).toEqual({ runId: l.runId, running: true });
  expect(startedRun(hub, r)).toBe(l.runId);

  // A send while the run is active waits behind it; it carries the project's MCP servers once.
  const sent = send(hub, r, "and then?", "req-2");
  const s = await next();
  expect(s.call).toMatchObject({ op: "send", sessionId: l.sessionId, text: "and then?" });
  const nextRun = (s.call as { runId: string }).runId;
  reply(s, { kind: "sent", runId: nextRun, queued: true });
  expect(await sent).toEqual({ runId: nextRun, queued: true });

  // A permission prompt, its answer, and an interrupt that names the active run.
  const answered = answer(hub, r, "q1", { behavior: "allow" });
  const a = await next();
  expect(a.call).toEqual({ op: "answer", sessionId: l.sessionId, requestId: "q1", decision: { behavior: "allow" } });
  reply(a, { kind: "done" });
  await answered;
  const interrupted = interrupt(hub, r);
  const i = await next();
  expect(i.call).toEqual({ op: "interrupt", sessionId: l.sessionId, runId: l.runId, reason: "interrupted through fleetd" });
  reply(i, { kind: "done" });
  await interrupted;
  const withdrawn = withdraw(hub, r, nextRun);
  const w = await next();
  reply(w, { kind: "withdrawn", cancelled: true });
  expect(await withdrawn).toBe(true);

  // A send to a session the node doesn't know is an unknown thread.
  const unknown = send(hub, { machineId: "devbox", threadId: "nope" }, "hi", "req-4");
  fail(await next(), "not_found", "no session nope");
  await expect(unknown).rejects.toThrow("thread nope is not known on machine devbox");
});

test("a logged-out runner refuses a launch; an archived project's lead takes no turn", async () => {
  const { hub, ex } = await node();
  ex.rememberRunner("devbox", { runner: "claude", supported: ">=2", versionOk: true, login: "logged_out" });
  await expect(launch(hub, "devbox", input("req-9"))).rejects.toThrow("Claude Code is not logged in on this machine");
  // The lead of p1, whose directory another project holds as a repo.
  hub.db.conn.run("INSERT INTO leads (machine_id, project_id, thread_id, started_at, session_generation) VALUES ('devbox', 'p1', 'lead-1', 'x', 1)");
  hub.db.conn.run("INSERT INTO repos (machine_id, project_id, name, checkout_machine_id, checkout_project_id) VALUES ('devbox', 'big', 'p1', 'devbox', 'p1')");
  await expect(send(hub, { machineId: "devbox", threadId: "lead-1" }, "hi", "req-5")).rejects.toThrow("This project is archived: its directory is repo p1 of project big on devbox.");
});

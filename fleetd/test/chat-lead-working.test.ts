// The chat's working state (chat.waiting's leadWorking) through a lead's whole turn, against a fake node: the real
// executor maps the node's machine stream to thread events, and the chat flow follows them.
import { expect, test } from "bun:test";
import { executors, type HubToNodeSession } from "../src/hub/executor/index.ts";
import { run } from "../src/hub/chat/flow.ts";
import { leads } from "../src/hub/leads/index.ts";
import { events } from "../src/hub/store/events.ts";
import { store } from "../src/hub/store/hub_store.ts";
import type { ProjectChatState } from "../src/shared/contracts.ts";
import type { SessionSummary } from "../src/shared/sessions.ts";
import { AT, kit } from "./work-kit.ts";

const settle = () => Bun.sleep(5);
const r = { machineId: "devbox", projectId: "p1" };

const lead = (extra: Partial<SessionSummary> = {}): SessionSummary => ({
  sessionId: "lead-1",
  projectId: "p1",
  title: "fleetd lead: p1",
  status: "idle",
  model: "claude-opus-5-5",
  effort: "high",
  runtimeMode: "approval-required",
  createdAt: AT,
  updatedAt: AT,
  ...extra,
});

async function node() {
  const k = kit();
  store(k.hub).machineUpsert({ machineId: "devbox", name: "devbox", nodeVersion: "1", status: "online", lastSeenAt: AT });
  const ex = executors(k.hub);
  const calls: HubToNodeSession[] = [];
  ex.attach("devbox", { linkId: 1, send: (f) => void calls.push(f) });
  await settle();
  ex.handleFrame("devbox", { t: "session_reply", id: calls.shift()!.id, result: { ok: { kind: "done" } } });
  await ex.awaitLive("devbox");
  ex.handleFrame("devbox", { t: "machine_event", seq: 1, at: AT, event: { type: "snapshot", projects: [{ projectId: "p1", title: "P1", workspaceRoot: "/w", updatedAt: AT }], sessions: [] } });
  await settle();
  leads(k.hub).records.leadPut({ projectRef: r, threadId: "lead-1", startedAt: AT, sessionGeneration: 1 });
  let latest = lead();
  // The node answers each call; a follow gets the lead's thread as it stands, with nothing said yet.
  const answer = setInterval(() => {
    for (const c of calls.splice(0)) {
      ex.handleFrame("devbox", { t: "session_reply", id: c.id, result: { ok: { kind: "done" } } });
      if (c.call.op !== "follow") continue;
      const runs = latest.latestRun ? [latest.latestRun] : [];
      ex.handleFrame("devbox", { t: "thread_event", sessionId: "lead-1", at: AT, event: { type: "snapshot", summary: latest, truncated: false, runs, messages: [], items: [] } });
    }
  }, 2);
  let seq = 1;
  const updated = async (s: SessionSummary) => {
    latest = s;
    ex.handleFrame("devbox", { t: "machine_event", seq: ++seq, at: AT, event: { type: "session_updated", ...s } });
    for (let i = 0; i < 20; i++) await settle();
  };
  /** What the apps were last told of the project's chat. */
  const told = () =>
    events(k.hub)
      .page(0)
      .events.filter((e) => e.type === "chat.waiting")
      .map((e) => (e.data as ProjectChatState).leadWorking)
      .at(-1);
  const done = () => {
    clearInterval(answer);
    k.hub.shutdown.abort();
  };
  return { ...k, updated, told, done };
}

test("a lead's turn shows working while a permission prompt holds it, and on after the prompt is answered", async () => {
  const n = await node();
  void run(n.hub);
  await settle();
  const turn = { activeRunId: "run-1", latestRun: { id: "run-1", status: "running" as const, ordinal: 1 } };
  await n.updated(lead({ status: "running", ...turn }));
  expect(n.told()).toBe(true);
  // Its first Bash call raises a prompt, which the hub's policy answers at once (2026-11-11, 09:46:53 UTC): the turn
  // never stopped, so the chat never says idle.
  await n.updated(
    lead({
      status: "waiting",
      activeRunId: "run-1",
      latestRun: { id: "run-1", status: "waiting", ordinal: 1 },
      pendingPermission: { requestId: "perm-1", toolName: "Bash", summary: "git ls-tree origin/main" },
    }),
  );
  expect(n.told()).toBe(true);
  await n.updated(lead({ status: "running", ...turn }));
  expect(n.told()).toBe(true);
  await n.updated(lead({ status: "idle", latestRun: { id: "run-1", status: "completed", ordinal: 1 } }));
  expect(n.told()).toBe(false);
  n.done();
});

// The stall watchdog through the hub's own watch (`hubWatch`): the real executor and its followed sessions, a stand-in
// node and the kit's clock. A run with no frame past its threshold is failed as stalled and interrupted once; a run that
// is slow, waiting on a person, between turns, or on a machine that came back is left alone.
import { expect, test } from "bun:test";
import { executors, type HubToNodeSession } from "../src/hub/executor/index.ts";
import { store } from "../src/hub/store/hub_store.ts";
import { hubWatch, STALL_MS, Watchdog } from "../src/hub/watchdog/index.ts";
import type { MachineEvent, RunInfo, SessionCall, SessionSummary, ThreadEvent, ThreadItem } from "../src/shared/sessions.ts";
import { eventsOf } from "./people-kit.ts";
import { AT, kit } from "./work-kit.ts";

const MIN = 60_000;
const settle = () => Bun.sleep(1);

const runOf = (id: string, status: RunInfo["status"] = "running", extra: Partial<RunInfo> = {}): RunInfo => ({ id, status, ordinal: 1, ...extra });
const running = (runId: string): Partial<SessionSummary> => ({ status: "running", activeRunId: runId, latestRun: runOf(runId) });
const ended = (runId: string, extra: Partial<RunInfo> = {}): Partial<SessionSummary> => ({ status: "idle", latestRun: runOf(runId, "completed", extra) });

/** A node on `devbox` that answers every call at once, and a watchdog over the hub's own watch. */
async function standIn() {
  const k = kit();
  const { hub, clock } = k;
  store(hub).machineUpsert({ machineId: "devbox", name: "devbox", nodeVersion: "1", status: "online", lastSeenAt: AT });
  const ex = executors(hub);
  const calls: SessionCall[] = [];
  const sessions = new Map<string, { summary: SessionSummary; items: ThreadItem[] }>();
  const at = () => new Date(clock.ms).toISOString();
  let seq = 0;
  let linkId = 0;
  const machineEvent = (event: MachineEvent) => ex.handleFrame("devbox", { t: "machine_event", seq: ++seq, at: at(), event });
  const thread = (sessionId: string, event: ThreadEvent) => ex.handleFrame("devbox", { t: "thread_event", sessionId, at: at(), event });
  const answer = (f: HubToNodeSession) => {
    ex.handleFrame("devbox", { t: "session_reply", id: f.id, result: { ok: { kind: "done" } } });
    if (f.call.op !== "follow") return;
    const s = sessions.get(f.call.sessionId)!;
    const runs = s.summary.latestRun ? [s.summary.latestRun] : [];
    thread(f.call.sessionId, { type: "snapshot", summary: s.summary, messages: [], items: s.items, runs, truncated: false });
  };
  const n = {
    hub,
    ex,
    calls,
    watchdog: new Watchdog(STALL_MS, hubWatch(hub)),
    /** The node links (again) and sends its snapshot. */
    async link() {
      ex.attach("devbox", {
        linkId: ++linkId,
        send: (f) => {
          calls.push(f.call);
          queueMicrotask(() => answer(f));
        },
      });
      await ex.awaitLive("devbox");
      const projects = [{ projectId: "app", title: "App", workspaceRoot: "/w", updatedAt: AT }];
      machineEvent({ type: "snapshot", projects, sessions: [...sessions.values()].map((s) => s.summary) });
      await settle();
    },
    drop: () => ex.detachLink("devbox", linkId),
    /** The session's row changes, as the machine stream says. */
    async set(id: string, extra: Partial<SessionSummary>) {
      const summary: SessionSummary = {
        sessionId: id,
        projectId: "app",
        title: `work ${id}`,
        status: "idle",
        model: "claude-opus-5-5",
        effort: "high",
        runtimeMode: "full-access",
        createdAt: AT,
        updatedAt: at(),
        ...extra,
      };
      const s = sessions.get(id);
      if (s) s.summary = summary;
      else sessions.set(id, { summary, items: [] });
      if (ex.isConnected("devbox")) machineEvent({ type: "session_updated", ...summary });
      await settle();
    },
    /** A tool call of the run, as an item frame. */
    item(id: string, runId: string, itemId: string, status: ThreadItem["status"], kind: ThreadItem["kind"]) {
      const item: ThreadItem = { id: itemId, runId, status, title: itemId, startedAt: at(), updatedAt: at(), kind };
      const items = sessions.get(id)!.items.filter((i) => i.id !== itemId);
      sessions.get(id)!.items = [...items, item];
      thread(id, { type: "item", ...item });
    },
    thread,
    /** `minutes` checks, one a minute; `each` runs before each. */
    async minutes(minutes: number, each?: (minute: number) => void) {
      for (let m = 1; m <= minutes; m++) {
        clock.ms += MIN;
        each?.(m);
        await n.watchdog.check();
      }
    },
    stalls: () => eventsOf(hub, "thread.failed").filter((e) => e.data?.reason === "stalled"),
    interrupts: () => calls.filter((c) => c.op === "interrupt"),
    end: () => hub.shutdown.abort(),
  };
  return n;
}

test("a running thread with no frame for 10 minutes gets one thread.failed{stalled} and one interrupt", async () => {
  const n = await standIn();
  await n.set("s1", running("r1"));
  await n.link();
  await n.minutes(9);
  expect(n.stalls()).toEqual([]);
  await n.minutes(1);
  expect(n.stalls().length).toBe(1);
  expect(n.stalls()[0]?.data).toMatchObject({ reason: "stalled", runId: "r1", inTool: false, idleSec: 600, thresholdSec: 600 });
  expect(n.stalls()[0]?.summary).toBe('"work s1" on devbox stalled: no progress for 10 min outside a tool, so fleetd interrupted it');
  expect(n.interrupts()).toEqual([{ op: "interrupt", sessionId: "s1", runId: "r1", reason: "interrupted through fleetd" }]);
  // Once per run, however long it stays running.
  await n.minutes(30);
  expect([n.stalls().length, n.interrupts().length]).toEqual([1, 1]);
  n.end();
});

test("a long model turn that is still streaming is left alone", async () => {
  const n = await standIn();
  await n.set("s1", running("r1"));
  await n.link();
  // Text deltas every few minutes, and in between the usage the node sends once a minute while claude thinks.
  await n.minutes(90, (m) =>
    m % 3 === 0
      ? n.thread("s1", { type: "delta", messageId: "m1", runId: "r1", append: "more" })
      : n.thread("s1", { type: "usage", runId: "r1", usage: { inputTokens: 10, outputTokens: m, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 } }),
  );
  expect([n.stalls().length, n.interrupts().length]).toEqual([0, 0]);
  n.end();
});

test("a tool inside its stated timeout, and one with none up to its limit, are left alone; past them the run stalls", async () => {
  const n = await standIn();
  await n.set("s1", running("r1"));
  await n.set("s2", running("r2"));
  await n.link();
  n.item("s1", "r1", "bash", "running", { type: "command", command: "bun run build", timeoutMs: 25 * MIN });
  n.item("s2", "r2", "mcp", "running", { type: "tool", toolName: "mcp__docs__search", input: {} });
  // Stated: its 25 minutes plus 10. None stated: 10 minutes plus 10.
  await n.minutes(19);
  expect(n.stalls()).toEqual([]);
  await n.minutes(1);
  expect(n.stalls().map((e) => e.data)).toMatchObject([{ runId: "r2", inTool: true, thresholdSec: 1200 }]);
  await n.minutes(14);
  expect(n.stalls().length).toBe(1);
  await n.minutes(1);
  expect(n.stalls().map((e) => e.data)).toMatchObject([{ runId: "r2" }, { runId: "r1", inTool: true, thresholdSec: 2100 }]);
  expect(n.interrupts().map((c) => c.sessionId)).toEqual(["s2", "s1"]);
  n.end();
});

test("a run waiting on a person is never stalled, and the wait doesn't count once they answer", async () => {
  const n = await standIn();
  const prompts = ["Bash", "mcp__fleetd__project_propose", "mcp__fleetd__confirm_step"];
  for (const [i, toolName] of prompts.entries()) {
    await n.set(`s${i}`, { ...running(`r${i}`), status: "waiting", pendingPermission: { requestId: `p${i}`, toolName, summary: "asks" } });
  }
  await n.link();
  const r = { machineId: "devbox", threadId: "s0" };
  expect(executors(n.hub).running().length).toBe(3);
  expect(hubWatch(n.hub).running()).toEqual([]);
  // The node sends nothing while a prompt waits: five hours of it.
  await n.minutes(300);
  expect([n.stalls().length, n.interrupts().length]).toEqual([0, 0]);
  expect(n.calls.filter((c) => c.op === "release")).toEqual([]);
  expect(n.ex.views.isFollowed(r)).toBe(true);
  // Answered: watched from then on, the wait not counted.
  await n.set("s0", running("r0"));
  await n.minutes(9);
  expect(n.stalls()).toEqual([]);
  await n.minutes(1);
  expect(n.stalls().map((e) => e.data?.runId)).toEqual(["r0"]);
  n.end();
});

test("a turn that ended waiting on a person, a usage reset, a Monitor or CI is left alone, and its next run is watched afresh", async () => {
  const n = await standIn();
  await n.set("s1", running("r1"));
  await n.set("s2", running("r2"));
  await n.link();
  // request_takeover, a secure input and gated_run answer at once; the person's part comes after the turn.
  for (const tool of ["mcp__fleetd__request_takeover", "mcp__fleetd__secure_input", "mcp__fleetd__gated_run"]) {
    n.item("s1", "r1", tool, "completed", { type: "tool", toolName: tool, input: {} });
  }
  n.item("s1", "r1", "wait", "completed", { type: "tool", toolName: "mcp__fleetd__wait_ci", input: {} });
  await n.set("s1", ended("r1"));
  // Parked on a usage limit: the run ended limited, and the usage layer continues it at the reset.
  await n.set("s2", { ...ended("r2", { status: "failed", end: "limited" }), status: "failed" });
  await n.minutes(300);
  expect([n.stalls().length, n.interrupts().length]).toEqual([0, 0]);
  // The Monitor fires and claude starts a turn by itself; the usage layer continues the parked one.
  await n.set("s1", running("woke-1"));
  await n.set("s2", running("r3"));
  await n.minutes(9);
  expect(n.stalls()).toEqual([]);
  n.end();
});

test("a subagent's tool call is left alone while the node says claude is at work", async () => {
  const n = await standIn();
  await n.set("s1", running("r1"));
  await n.link();
  // The Agent call is open for three hours; its subagent's own lines reach the hub as the run's usage, once a minute.
  n.item("s1", "r1", "agent", "running", { type: "tool", toolName: "Agent", input: { description: "survey" } });
  await n.minutes(180, (m) =>
    n.thread("s1", { type: "usage", runId: "r1", usage: { inputTokens: m, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 } }),
  );
  expect([n.stalls().length, n.interrupts().length]).toEqual([0, 0]);
  n.end();
});

test("a thread whose machine link dropped and came back is watched afresh, not stalled for the gap", async () => {
  const n = await standIn();
  await n.set("s1", running("r1"));
  await n.link();
  await n.minutes(8);
  n.drop();
  await n.minutes(30);
  expect(n.stalls()).toEqual([]);
  await n.link();
  await n.minutes(9);
  expect([n.stalls().length, n.interrupts().length]).toEqual([0, 0]);
  await n.minutes(1);
  expect(n.stalls().length).toBe(1);
  n.end();
});

test("a hub restarted under runs in flight stalls none on its first checks", async () => {
  const n = await standIn();
  // Runs that started hours before this hub did, on a node that links after the first check.
  await n.set("s1", { ...running("r1"), createdAt: "2026-10-17T06:00:00.000Z" });
  await n.set("s2", { ...running("r2"), createdAt: "2026-10-17T06:00:00.000Z" });
  await n.watchdog.check();
  await n.link();
  await n.watchdog.check();
  await n.minutes(9);
  expect([n.stalls().length, n.interrupts().length]).toEqual([0, 0]);
  n.end();
});

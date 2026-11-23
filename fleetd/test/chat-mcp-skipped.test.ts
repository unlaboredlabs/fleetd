// A lead's start that left out MCP servers that didn't answer (src/node/mcp_reach.ts, W818) is told in the lead's chat
// in a line of fleetd's own, once per start: the lead was told in a note before, and on fleetd's cloud it didn't pass it
// on. The real executor maps a fake node's machine stream, in the order a node sends it: the run's "starting" frame goes
// out before the start looks at the servers, and the fields come with a later frame, which moves no run state.
import { expect, test } from "bun:test";
import { chat } from "../src/hub/chat/index.ts";
import { executors, type HubToNodeSession } from "../src/hub/executor/index.ts";
import { executorHooks } from "../src/hub/executor/hooks.ts";
import { leads } from "../src/hub/leads/index.ts";
import { mcpSkipped } from "../src/hub/leads/loops.ts";
import { store } from "../src/hub/store/hub_store.ts";
import type { SessionSummary } from "../src/shared/sessions.ts";
import { AT, kit } from "./work-kit.ts";

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const r = { machineId: "devbox", projectId: "p1" };

/** A session's summary with run `run` at `status` ("starting" reads as running, as the node's settle() makes it). */
const summary = (id: string, run: string, status: "starting" | "running" | "completed", extra: Partial<SessionSummary> = {}): SessionSummary => ({
  sessionId: id,
  projectId: "p1",
  title: id,
  status: status === "completed" ? "idle" : "running",
  model: "claude-opus-5-5",
  effort: "high",
  runtimeMode: "full-access",
  createdAt: AT,
  updatedAt: AT,
  ...(status === "completed" ? {} : { activeRunId: run }),
  latestRun: { id: run, status, ordinal: 1 },
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
  // As the leads area wires it (src/hub/leads/loops.ts `start`).
  executorHooks(k.hub).onMcpSkipped((thread, change, at) => mcpSkipped(k.hub, thread, change, at));
  let seq = 1;
  const updated = async (s: SessionSummary) => {
    ex.handleFrame("devbox", { t: "machine_event", seq: ++seq, at: AT, event: { type: "session_updated", ...s } });
    for (let i = 0; i < 5; i++) await settle();
  };
  const systemLines = () =>
    chat(k.hub)
      .page(r, undefined, undefined, 50)
      .messages.filter((m: { author: string }) => m.author === "system")
      .map((m: { text: string }) => m.text);
  return { ...k, updated, systemLines, done: () => k.hub.shutdown.abort() };
}

/** A start's summary fields as the node writes them (src/node/mcp_reach.ts `startChange`). */
const left = (now: string[], down: string[], back: string[], at: string): Partial<SessionSummary> => ({ mcpSkipped: now, mcpChange: { down, back }, mcpSkippedAt: at });

test("a lead's chat says what each start changed of its left-out MCP servers, once, though the fields come after the run started", async () => {
  const n = await node();
  // The person's message wakes the lead: its run is "starting" before the start has looked at any server.
  await n.updated(summary("lead-1", "run-1", "starting"));
  expect(n.systemLines()).toEqual([]);
  // claude's first frame: the run runs, and the summary now says what the start changed.
  await n.updated(summary("lead-1", "run-1", "running", left(["devbox-tailnet"], ["devbox-tailnet"], [], "2026-11-23T04:32:31.000Z")));
  // The same fields again (the run's end, a follow's snapshot), and the next wake's "starting" frame carrying them.
  await n.updated(summary("lead-1", "run-1", "completed", left(["devbox-tailnet"], ["devbox-tailnet"], [], "2026-11-23T04:32:31.000Z")));
  await n.updated(summary("lead-1", "run-2", "starting", left(["devbox-tailnet"], ["devbox-tailnet"], [], "2026-11-23T04:32:31.000Z")));
  expect(n.systemLines()).toEqual(["The MCP server “devbox-tailnet” didn't answer, so its tools are off until the next start."]);
  // That start leaves it out again: nothing changed, nothing said.
  await n.updated(summary("lead-1", "run-2", "running", left(["devbox-tailnet"], [], [], "2026-11-23T05:00:00.000Z")));
  expect(n.systemLines()).toHaveLength(1);
  // It answers again: said once.
  await n.updated(summary("lead-1", "run-3", "running", left([], [], ["devbox-tailnet"], "2026-11-23T06:00:00.000Z")));
  expect(n.systemLines().at(-1)).toBe("The MCP server “devbox-tailnet” answers again: its tools are back.");
  // One start with one back and two down: both said.
  await n.updated(summary("lead-1", "run-4", "running", left(["a", "b"], ["a", "b"], ["c"], "2026-11-23T07:00:00.000Z")));
  expect(n.systemLines().slice(2)).toEqual([
    "The MCP servers “a” and “b” didn't answer, so their tools are off until the next start.",
    "The MCP server “c” answers again: its tools are back.",
  ]);
  n.done();
});

test("a start that changed nothing, or another thread's start, says nothing", async () => {
  const n = await node();
  await n.updated(summary("lead-1", "run-1", "starting"));
  await n.updated(summary("lead-1", "run-1", "running", left([], [], [], "2026-11-23T04:00:00.000Z")));
  await n.updated(summary("agent-7", "run-9", "running", left(["devbox-tailnet"], ["devbox-tailnet"], [], "2026-11-23T04:00:00.000Z")));
  expect(n.systemLines()).toEqual([]);
  n.done();
});

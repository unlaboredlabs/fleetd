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
  executorHooks(k.hub).onMcpSkipped((thread, names, at, looked) => mcpSkipped(k.hub, thread, names, at, looked));
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

test("a lead's chat says a change of its starts' left-out MCP servers once, though the fields come after the run started", async () => {
  const n = await node();
  // The person's message wakes the lead: its run is "starting" before the start has looked at any server.
  await n.updated(summary("lead-1", "run-1", "starting"));
  expect(n.systemLines()).toEqual([]);
  // claude's first frame: the run runs, and the summary now names what the start left out.
  await n.updated(summary("lead-1", "run-1", "running", { mcpSkipped: ["devbox-tailnet"], mcpSkippedAt: "2026-11-23T04:32:31.000Z" }));
  // The same fields again (the run's end, a follow's snapshot): never said twice.
  await n.updated(summary("lead-1", "run-1", "completed", { mcpSkipped: ["devbox-tailnet"], mcpSkippedAt: "2026-11-23T04:32:31.000Z" }));
  expect(n.systemLines()).toEqual(["The MCP server “devbox-tailnet” didn't answer, so its tools are off until the next start."]);
  // The next wake: its "starting" frame carries the last start's fields, and its start leaves the same server out.
  await n.updated(summary("lead-1", "run-2", "starting", { mcpSkipped: ["devbox-tailnet"], mcpSkippedAt: "2026-11-23T04:32:31.000Z" }));
  await n.updated(summary("lead-1", "run-2", "running", { mcpSkipped: ["devbox-tailnet"], mcpSkippedAt: "2026-11-23T05:00:00.000Z" }));
  expect(n.systemLines()).toHaveLength(1);
  // It answers again: said once, and a start after it that leaves none out says nothing.
  await n.updated(summary("lead-1", "run-3", "running", { mcpSkipped: [], mcpSkippedAt: "2026-11-23T06:00:00.000Z" }));
  await n.updated(summary("lead-1", "run-4", "running", { mcpSkipped: [], mcpSkippedAt: "2026-11-23T07:00:00.000Z" }));
  expect(n.systemLines().slice(1)).toEqual(["The MCP server “devbox-tailnet” answers again: its tools are back."]);
  // Two others drop: a line of its own, in the plural; and the same two again say nothing.
  await n.updated(summary("lead-1", "run-5", "running", { mcpSkipped: ["b", "a"], mcpSkippedAt: "2026-11-23T08:00:00.000Z" }));
  await n.updated(summary("lead-1", "run-6", "running", { mcpSkipped: ["a", "b"], mcpSkippedAt: "2026-11-23T09:00:00.000Z" }));
  expect(n.systemLines().slice(2)).toEqual(["The MCP servers “a” and “b” didn't answer, so their tools are off until the next start."]);
  n.done();
});

test("a start that left none out, with nothing said before, or another thread's start, says nothing", async () => {
  const n = await node();
  await n.updated(summary("lead-1", "run-1", "starting"));
  await n.updated(summary("lead-1", "run-1", "running", { mcpSkipped: [], mcpSkippedAt: "2026-11-23T04:00:00.000Z" }));
  await n.updated(summary("agent-7", "run-9", "running", { mcpSkipped: ["devbox-tailnet"], mcpSkippedAt: "2026-11-23T04:00:00.000Z" }));
  expect(n.systemLines()).toEqual([]);
  n.done();
});

// The review of #2090: a person who removes the server the chat said was down (the obvious answer to that line) must
// never read that it answers again.
test("a server said down and then removed from the bot is never said to answer again", async () => {
  const n = await node();
  await n.updated(summary("lead-1", "run-1", "running", { mcpSkipped: ["docs"], mcpSkippedAt: "2026-11-23T04:00:00.000Z", mcpLooked: ["docs", "crm"] }));
  // "docs" is removed: the next start looks only at "crm", which answers.
  await n.updated(summary("lead-1", "run-2", "running", { mcpSkipped: [], mcpSkippedAt: "2026-11-23T05:00:00.000Z", mcpLooked: ["crm"] }));
  expect(n.systemLines()).toEqual(["The MCP server “docs” didn't answer, so its tools are off until the next start."]);
  n.done();
});

// A lead's start that left out MCP servers that didn't answer (src/node/mcp_reach.ts, W818) is told in the lead's chat
// in a line of fleetd's own, once per start, when its run starts: the lead was told in a note before, and on fleetd's
// cloud it didn't pass it on. The real executor maps a fake node's machine stream to the lead's tracked thread.
import { expect, test } from "bun:test";
import { chat } from "../src/hub/chat/index.ts";
import { executors, type HubToNodeSession } from "../src/hub/executor/index.ts";
import { leads } from "../src/hub/leads/index.ts";
import { mcpSkipped } from "../src/hub/leads/loops.ts";
import { store } from "../src/hub/store/hub_store.ts";
import type { SessionSummary } from "../src/shared/sessions.ts";
import { AT, kit } from "./work-kit.ts";

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const r = { machineId: "devbox", projectId: "p1" };

const summary = (id: string, extra: Partial<SessionSummary> = {}): SessionSummary => ({
  sessionId: id,
  projectId: "p1",
  title: id,
  status: "running",
  model: "claude-opus-5-5",
  effort: "high",
  runtimeMode: "full-access",
  createdAt: AT,
  updatedAt: AT,
  activeRunId: "run-1",
  latestRun: { id: "run-1", status: "running", ordinal: 1 },
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
  let seq = 1;
  const updated = async (s: SessionSummary) => {
    ex.handleFrame("devbox", { t: "machine_event", seq: ++seq, at: AT, event: { type: "session_updated", ...s } });
    for (let i = 0; i < 5; i++) await settle();
  };
  const started = (thread: string) => mcpSkipped(k.hub, { seq: 0, at: AT, type: "thread.started", machineId: "devbox", threadId: thread, summary: "" } as never);
  const systemLines = () =>
    chat(k.hub)
      .page(r, undefined, undefined, 50)
      .messages.filter((m: { author: string }) => m.author === "system")
      .map((m: { text: string }) => m.text);
  return { ...k, updated, started, systemLines, done: () => k.hub.shutdown.abort() };
}

test("a lead's start that left an MCP server out says which in the chat, once per start, in fleetd's own words", async () => {
  const n = await node();
  await n.updated(summary("lead-1", { mcpSkipped: ["devbox-tailnet"], mcpSkippedAt: "2026-11-23T04:32:31.000Z" }));
  n.started("lead-1");
  // The run's events come again (a follow's snapshot, a hub restart): the same start's line isn't said twice.
  n.started("lead-1");
  expect(n.systemLines()).toEqual(["The MCP server “devbox-tailnet” didn't answer, so its tools are off until the next start."]);
  // The next start leaves two out: a line of its own.
  await n.updated(summary("lead-1", { mcpSkipped: ["a", "b"], mcpSkippedAt: "2026-11-23T05:00:00.000Z" }));
  n.started("lead-1");
  expect(n.systemLines().at(-1)).toBe("The MCP servers “a” and “b” didn't answer, so their tools are off until the next start.");
  expect(n.systemLines()).toHaveLength(2);
  n.done();
});

test("a start that left none out, or another thread's start, says nothing", async () => {
  const n = await node();
  await n.updated(summary("lead-1"));
  n.started("lead-1");
  await n.updated(summary("agent-7", { mcpSkipped: ["devbox-tailnet"], mcpSkippedAt: AT }));
  n.started("agent-7");
  expect(n.systemLines()).toEqual([]);
  n.done();
});

// Replays the recorded claude 2.1.302 transcripts (test/fixtures/runner) through the session host's stream mapper
// (crates/fleetd/src/node/runner/claude/mapper/tests.rs). "in" lines drive fleetd's side (send, answer, interrupt) and
// must come out as recorded; "out" and "stderr" lines are fed; the "meta" exit ends the process. The classifier is a
// recorder, so these tests pin the evidence the real classifier receives.
import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ItemStatus, PermissionDecision, RunFailure, RunUsage, SendMode, ThreadItem } from "../../src/shared/sessions.ts";
import type { ExitInfo, RunnerEvent, RunOutcome } from "../../src/node/runner/host/events.ts";
import { classify, type FailureEvidence } from "../../src/node/runner/host/failure.ts";
import { StreamMapper, toolClass, type Classify, type Now } from "../../src/node/runner/host/mapper.ts";
import { decode, type Input, type Line } from "../../src/node/runner/host/protocol.ts";
import type { SpanWire } from "../../src/node/runner/host/spans.ts";
import { sessionInUse } from "../../src/node/runner/claude.ts";

export const FIXTURES = join(import.meta.dir, "../fixtures/runner");
const AT = "2026-10-18T10:00:00.000Z";
/** The recorded line's time: fixtures carry ms since the process started. */
const nowAt = (ms = 0): Now => ({ at: AT, ms: 1_792_000_000_000 + ms });
const now = () => nowAt(0);

type Replay = {
  /** Everything but the time spans, which are in `spans`. */
  events: RunnerEvent[];
  spans: SpanWire[];
  evidence: FailureEvidence[];
  /** (recorded stdin line, the line the mapper wrote for it) */
  inputs: [unknown, unknown][];
  replies: Input[];
  /** Recorded stdin lines the mapper writes itself as replies (a `send_now` on its message's `queued`). */
  expectedReplies: unknown[];
  sent: string[];
};

const fixtures = () => readdirSync(FIXTURES).sort();
const fileOf = (name: string) => (name.endsWith(".jsonl") ? name : `claude-2.1.302-${name}.jsonl`);
const records = (name: string): any[] =>
  readFileSync(join(FIXTURES, fileOf(name)), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
const json = (v: unknown) => JSON.parse(JSON.stringify(v));

/** `beforeExit` runs just before the recorded exit, e.g. to mark the node as stopping. */
function replay(name: string, beforeExit: (m: StreamMapper) => void = () => {}): Replay {
  const evidence: FailureEvidence[] = [];
  const recorder: Classify = (e) => {
    evidence.push(e);
    const f: RunFailure = { class: "other", message: e.text || "no text", retries: 0 };
    if (e.apiErrorStatus !== undefined) f.apiStatus = e.apiErrorStatus;
    return f;
  };
  const mapper = new StreamMapper("s", recorder);
  const out: Replay = { events: [], spans: [], evidence, inputs: [], replies: [], expectedReplies: [], sent: [] };
  // The steer probe's fixtures name their steer, and which mode sent it.
  let steer: [string, string] | undefined;
  for (const rec of records(name)) {
    const msg = rec.msg;
    const ms = typeof rec.ms === "number" ? rec.ms : 0;
    if (rec.dir === "meta" && msg.steer !== undefined) steer = [msg.steer, msg.scenario];
    else if (rec.dir === "in") {
      let ours: Input;
      if (msg.type === "user") {
        const runId: string = msg.uuid;
        out.sent.push(runId);
        const mode: SendMode = msg.priority === "now" ? "boundary" : steer && steer[0] === runId && steer[1] === "steer-send-now" ? "now" : "plain";
        const lines = mapper.send(runId, msg.message.content, mode);
        expect(lines.length).toBe(1);
        ours = lines[0]!;
      } else if (msg.type === "control_request" && msg.request.send_now === true) {
        out.expectedReplies.push(msg);
        continue;
      } else if (msg.type === "control_request" && msg.request.subtype === "cancel_async_message") {
        ours = mapper.withdraw(msg.request.message_uuid)!;
        expect(ours).toBeDefined();
      } else if (msg.type === "control_request" && msg.request.subtype === "interrupt") {
        ours = mapper.interrupt();
      } else if (msg.type === "control_request") {
        // `initialize` is the conformance probe's, not a session's.
        continue;
      } else if (msg.type === "control_response") {
        const answer = msg.response.response;
        const decision: PermissionDecision = answer.behavior === "allow" ? { behavior: "allow" } : { behavior: "deny", message: answer.message };
        ours = mapper.answer(msg.response.request_id, decision, "human", nowAt(ms))!;
        expect(ours).toBeDefined();
      } else throw new Error(`${name}: unexpected stdin line ${msg.type}`);
      out.inputs.push([msg, json(ours)]);
    } else if (rec.dir === "out") {
      const line = decode(msg);
      expect(line).toBeDefined();
      const mapped = mapper.feed(line!, nowAt(ms));
      out.events.push(...mapped.events);
      out.replies.push(...mapped.replies);
    } else if (rec.dir === "stderr") mapper.stderr(String(rec.raw).replace(/\n+$/, ""));
    else if (rec.dir === "meta" && msg.exit !== undefined) {
      beforeExit(mapper);
      const signal = msg.signal === "SIGKILL" ? 9 : msg.signal === "SIGTERM" ? 15 : null;
      const exit: ExitInfo = { code: typeof msg.exit === "number" ? msg.exit : null, signal, stderr_tail: mapper.stderrTail() };
      out.events.push(...mapper.exited(exit, nowAt(ms)));
    }
  }
  const events = out.events;
  out.events = [];
  for (const e of events) {
    if (typeof e === "object" && "Spans" in e) out.spans.push(...e.Spans);
    else out.events.push(e);
  }
  return out;
}

const runEnds = (events: RunnerEvent[]): [string, RunOutcome][] =>
  events.flatMap((e) => (typeof e === "object" && "RunEnded" in e ? [[e.RunEnded.run_id, e.RunEnded.outcome] as [string, RunOutcome]] : []));
const items = (events: RunnerEvent[]): ThreadItem[] => events.flatMap((e) => (typeof e === "object" && "Item" in e ? [e.Item] : []));
const texts = (events: RunnerEvent[]): string[] => events.flatMap((e) => (typeof e === "object" && "AssistantText" in e ? [e.AssistantText.text] : []));
const line = (v: unknown): Line => decode(v)!;
const none: Classify = () => undefined;

test("the stdin writer reproduces every recorded input line", () => {
  let checked = 0;
  for (const name of fixtures()) {
    for (const [recorded, ours] of replay(name).inputs) {
      expect(ours, name).toEqual(recorded);
      checked++;
    }
  }
  // A user message per fixture, plus the permission answers and the interrupt.
  expect(checked).toBeGreaterThanOrEqual(22);
});

test("every sent run ends exactly once and the exit comes last", () => {
  for (const name of fixtures()) {
    const r = replay(name);
    const ends = runEnds(r.events);
    for (const runId of r.sent) expect(ends.filter(([id]) => id === runId).length, `${name}: ${runId}`).toBe(1);
    const last = r.events.at(-1);
    expect(typeof last === "object" && "Exited" in last, name).toBe(true);
    const status = new Map<string, ItemStatus>();
    for (const item of items(r.events)) status.set(item.id, item.status);
    expect([...status.values()].includes("running"), name).toBe(false);
    expect(json(r.replies), `${name}: replies`).toEqual(r.expectedReplies);
  }
});

test("two turns in one process", () => {
  const r = replay("init-partial-two-turns");
  // Recorded without fleetd's deny list.
  const init: RunnerEvent = { Init: { version: "2.1.302", model: "claude-haiku-5-5", cwd: "/work/project", agent_tools: ["Task", "ListAgents", "SendMessage", "TaskStop", "Workflow"] } };
  const usage = (cacheCreation: number, cacheRead: number, output: number, cost: number): RunUsage => ({
    inputTokens: 2,
    outputTokens: output,
    cacheReadInputTokens: cacheRead,
    cacheCreationInputTokens: cacheCreation,
    costUsd: cost,
  });
  const turn = (run: string, message: string, text: string, u: RunUsage): RunnerEvent[] => {
    // The streamed usage (message_start, then message_delta) is the result's, without claude's cost estimate.
    const { costUsd: _, ...streamed } = u;
    const live: RunnerEvent = { Usage: { run_id: run, usage: streamed } };
    return [
      { Queued: { run_id: run } },
      { RunStarted: { run_id: run } },
      init,
      { Seen: { run_ids: [run] } },
      live,
      { Delta: { message_id: message, append: text } },
      { AssistantText: { message_id: message, text } },
      live,
      { RunEnded: { run_id: run, outcome: { Completed: { text } }, usage: u } },
    ];
  };
  expect(r.events).toEqual([
    ...turn("e8d52832-5cea-4aac-ba3b-f1e6763315a8", "msg_011Cg9aDpP7fzKKzDbb8vkFt", "OK", usage(27181, 0, 4, 0.003399825)),
    ...turn("a87c3994-cb34-4cef-a995-187ea281a4c5", "msg_011Cg9aDvUxvevdzsgdPectE", "TWO", usage(3055, 24171, 5, 0.00402611)),
    { Exited: { code: 0, signal: null, stderr_tail: "" } },
  ]);
});

test("deltas keep arriving in order and match the complete text", () => {
  const r = replay("resume");
  const deltas = r.events.flatMap((e) => (typeof e === "object" && "Delta" in e ? [e.Delta] : []));
  expect(deltas.length).toBe(2);
  const joined = deltas.map((d) => d.append).join("");
  const complete = r.events.flatMap((e) => (typeof e === "object" && "AssistantText" in e ? [e.AssistantText] : []))[0];
  expect(complete).toEqual({ message_id: deltas[0]!.message_id, text: joined });
  expect(joined).toBe("OK, then TWO.");
});

test("permission prompts carry what a person needs and the answer shows on the tool", () => {
  const allow = replay("permission-allow");
  const request = allow.events.flatMap((e) => (typeof e === "object" && "PermissionRequest" in e ? [e.PermissionRequest] : []))[0]!;
  expect(request).toMatchObject({
    request_id: "7b61bb9d-782a-4cbe-b52a-01bcfaf05da6",
    tool_use_id: "toolu_01BkSaeJX8QfJhbbZVabhXdh",
    tool_name: "Bash",
    input: { command: "touch perm-test.txt" },
    summary: "touch perm-test.txt",
  });
  const bash = items(allow.events);
  expect(bash.map((i) => [i.id, i.status])).toEqual([
    ["toolu_01BkSaeJX8QfJhbbZVabhXdh", "running"],
    ["toolu_01BkSaeJX8QfJhbbZVabhXdh", "completed"],
  ]);
  expect(bash[1]!.kind).toMatchObject({ type: "command", command: "touch perm-test.txt", exitCode: 0 });
  expect(bash[1]!.title).toBe("Create empty file perm-test.txt");
  expect(texts(allow.events)).toEqual(["DONE"]);

  const deny = replay("permission-deny");
  const done = items(deny.events).at(-1)!;
  expect(done.status).toBe("failed");
  expect(done.kind).toMatchObject({ type: "command", output: "Denied by fleetd policy (test)." });
  // A denied tool is the agent's business, not a failed run.
  expect(runEnds(deny.events).map(([, o]) => o)).toEqual([{ Completed: { text: "DENIED" } }]);
});

test("an allowlisted command reports its output", () => {
  const done = items(replay("allowlisted-tool").events).at(-1)!;
  expect(done.status).toBe("completed");
  expect(done.runId).toBe("e27de424-2034-45ed-b5db-519db39424c1");
  expect(done.kind).toMatchObject({ type: "command", command: "echo hi", output: "hi", exitCode: 0 });
});

test("an interrupt cancels the tool and ends the run interrupted", () => {
  const r = replay("interrupt-mid-tool");
  const tool = items(r.events);
  expect(tool.length).toBe(2);
  expect(tool[1]!.status).toBe("cancelled");
  expect(tool[1]!.kind.type === "command" && tool[1]!.kind.exitCode).toBeUndefined();
  // `result` aborted_tools, then lifecycle cancelled: one end, and claude's later exit 1 is no failure.
  expect(runEnds(r.events)).toEqual([["105ae926-5ace-4713-b671-c4f58f91803f", "Interrupted"]]);
  expect(r.evidence).toEqual([]);
});

test("a killed process ends its run and its open tool", () => {
  const crashed = replay("sigkill-mid-tool");
  const ends = runEnds(crashed.events);
  expect(ends.length).toBe(1);
  expect(typeof ends[0]![1] === "object" && "Failed" in ends[0]![1]).toBe(true);
  expect(crashed.evidence.length).toBe(1);
  expect(crashed.evidence[0]!.exit?.signal).toBe(9);
  const cut = items(crashed.events).find((i) => i.id === "toolu_01JjFcFnWCNBKPLAWMKG1J3R" && i.status !== "running");
  expect(cut?.status).toBe("cancelled");

  // The same kill, but the node asked for it: the run was stopped, not failed.
  const stopped = replay("sigkill-mid-tool", (m) => m.stopping());
  expect(runEnds(stopped.events)[0]![1]).toBe("Interrupted");
  expect(stopped.evidence).toEqual([]);

  // SIGTERM: claude kills its own tool child (exit 137) before exiting 143.
  const termed = replay("sigterm-mid-tool");
  const tool = items(termed.events)[1]!;
  expect(tool.status).toBe("failed");
  expect(tool.kind).toMatchObject({ type: "command", exitCode: 137 });
  expect(termed.evidence[0]!.exit?.code).toBe(143);
});

test("api errors become failure evidence and never the agent's reply", () => {
  const cases: [string, string | undefined, number | undefined, string][] = [
    ["invalid-model", "unknown", 400, "API Error: 400 unknown provider for model"],
    ["not-logged-in", "authentication_failed", undefined, "Not logged in · Please run /login"],
    ["auth-expired-401", "authentication_failed", 401, "Failed to authenticate. API Error: 401"],
    ["overloaded-529", "server_error", 529, "API Error: 529 Overloaded."],
    ["server-500", "server_error", 500, "API Error: 500 Internal server error."],
    ["network-refused", "server_error", undefined, "API Error: Connection refused"],
    ["rate-limit-429", "rate_limit", 429, "API Error: Request rejected (429)"],
    ["usage-429-api-key", "rate_limit", 429, "API Error: Request rejected (429)"],
    ["usage-limit-subscription.documented", "rate_limit", 429, "You've hit your limit"],
  ];
  for (const [name, error, status, text] of cases) {
    const r = replay(name);
    expect(r.evidence.length, name).toBe(1);
    const e = r.evidence[0]!;
    expect(e.assistantError, name).toBe(error);
    expect(e.apiErrorStatus, name).toBe(status);
    expect(e.text.startsWith(text), `${name}: ${e.text}`).toBe(true);
    expect(e.terminalReason, name).toBe("api_error");
    expect(e.exit, name).toBeUndefined();
    expect(texts(r.events), `${name}: error text emitted as a reply`).toEqual([]);
    // The failure is an item too, right before the run ends, so actions_list shows it.
    const third = r.events.at(-3)!;
    expect(typeof third === "object" && "Item" in third && third.Item.kind.type === "error", name).toBe(true);
  }
  // claude's stderr for the run goes to the classifier, which puts it under claude's text.
  const invalid = replay("invalid-model");
  expect(invalid.evidence[0]!.isError).toBe(true);
  expect(invalid.evidence[0]!.stderr).toBe('[claude-code:unrecognized_model] {"model":"claude-does-not-exist-9","query_source":"sdk"}');
});

test("recorded failures land in their class", () => {
  const cases: [string, string][] = [
    ["invalid-model", "invalid_request"],
    ["not-logged-in", "auth"],
    ["auth-expired-401", "auth"],
    ["overloaded-529", "overloaded"],
    ["server-500", "overloaded"],
    ["network-refused", "network"],
    ["rate-limit-429", "rate_limit"],
    ["claude-2.1.310-proxy-cooldown-429.jsonl", "rate_limit"],
    ["usage-limit-subscription.documented", "usage_limit"],
    ["sigkill-mid-tool", "process_exited"],
    ["sigterm-mid-tool", "process_exited"],
    ["session-id-in-use", "process_exited"],
  ];
  for (const [name, cls] of cases) {
    const classified = classify(replay(name).evidence[0]!);
    expect(classified?.class, `${name}: ${classified?.message}`).toBe(cls as RunFailure["class"]);
  }
  expect(classify(replay("session-id-in-use").evidence[0]!)!.message).toContain("is already in use");
});

test("subscription limits arrive structured", () => {
  const r = replay("usage-limit-subscription.documented");
  const limit = { status: "rejected", resets_at: 1_792_335_600, limit_type: "five_hour", utilization: null };
  expect(r.events).toContainEqual({ RateLimit: limit });
  expect(r.evidence[0]!.rateLimit).toEqual(limit);
});

test("retries and compaction become items", () => {
  const retries = items(replay("overloaded-529").events).flatMap((i) =>
    i.kind.type === "api_retry" ? [[i.kind.attempt, i.kind.maxRetries, i.kind.errorStatus, i.kind.error, i.status]] : [],
  );
  expect(retries).toEqual([
    [1, 2, 529, "overloaded", "completed"],
    [2, 2, 529, "overloaded", "completed"],
  ]);
  const shape = replay("compact-manual").events.flatMap((e): string[] => {
    if (typeof e !== "object") return [];
    if ("Compacting" in e) return [`compacting ${e.Compacting}`];
    if ("Item" in e && e.Item.kind.type === "compaction") return [`${e.Item.kind.trigger} ${e.Item.kind.preTokens} -> ${e.Item.kind.postTokens}`];
    if ("RunEnded" in e) return [JSON.stringify(e.RunEnded.outcome)];
    if ("AssistantText" in e) return ["text"];
    return [];
  });
  expect(shape).toEqual(["compacting true", "compacting false", "manual 27287 -> 868", '{"Completed":{"text":""}}']);
});

test("a refused start ends the run with claude's words", () => {
  const r = replay("session-id-in-use");
  const ends = runEnds(r.events);
  expect(ends.length === 1 && typeof ends[0]![1] === "object" && "Failed" in ends[0]![1]).toBe(true);
  const last = r.events.at(-1)!;
  const exit = typeof last === "object" && "Exited" in last ? last.Exited : undefined;
  expect(exit?.stderr_tail).toBe("Error: Session ID 289edad3-c10d-43bc-9a66-699588cecfc8 is already in use.");
  expect(r.evidence[0]!.exit).toEqual(exit!);
  // What the session service reads to send the run again to a resumed process.
  const failure = classify(r.evidence[0]!)!;
  expect(failure.class).toBe("process_exited");
  expect(sessionInUse(failure.message)).toBe(true);
});

test("a control request fleetd does not handle is refused so claude never waits", () => {
  const mapper = new StreamMapper("s", none);
  const mapped = mapper.feed(line({ type: "control_request", request_id: "h1", request: { subtype: "hook_callback" } }), now());
  expect(mapped.events).toEqual([]);
  expect(json(mapped.replies)).toEqual([{ type: "control_response", response: { subtype: "error", request_id: "h1", error: "fleetd does not handle hook_callback" } }]);
});

test("a prompt claude withdraws is cancelled and can no longer be answered", () => {
  const mapper = new StreamMapper("s", none);
  mapper.feed(
    line({ type: "control_request", request_id: "p1", request: { subtype: "can_use_tool", tool_name: "Write", tool_use_id: "t1", input: { file_path: "/w/a.txt", content: "x" } } }),
    now(),
  );
  const mapped = mapper.feed(line({ type: "control_cancel_request", request_id: "p1" }), now());
  expect(mapped.events.length).toBe(1);
  const item = (mapped.events[0] as { Item: ThreadItem }).Item;
  expect([item.id, item.status]).toEqual(["p1", "cancelled"]);
  expect(item.kind).toEqual({ type: "permission", requestId: "p1", toolName: "Write", summary: "/w/a.txt" });
  expect(mapper.answer("p1", { behavior: "allow" }, undefined, now())).toBeUndefined();
});

test("several text blocks of one message keep distinct ids shared with their deltas", () => {
  const mapper = new StreamMapper("s", none);
  const stream = (event: unknown) => line({ type: "stream_event", event, parent_tool_use_id: null });
  const events: RunnerEvent[] = [];
  for (const event of [
    { type: "message_start", message: { id: "m1" } },
    { type: "content_block_start", index: 0, content_block: { type: "thinking" } },
    { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "one" } },
    { type: "content_block_start", index: 2, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 2, delta: { type: "text_delta", text: "two" } },
  ])
    events.push(...mapper.feed(stream(event), now()).events);
  for (const text of ["one", "two"])
    events.push(...mapper.feed(line({ type: "assistant", parent_tool_use_id: null, message: { id: "m1", content: [{ type: "text", text }] } }), now()).events);
  const ids = events.flatMap((e) =>
    typeof e !== "object" ? [] : "Delta" in e ? [[e.Delta.message_id, e.Delta.append]] : "AssistantText" in e ? [[e.AssistantText.message_id, e.AssistantText.text]] : [],
  );
  expect(ids).toEqual([
    ["m1", "one"],
    ["m1:1", "two"],
    ["m1", "one"],
    ["m1:1", "two"],
  ]);
});

test("summarized thinking becomes a finished item and never the reply", () => {
  const mapper = new StreamMapper("s", none);
  mapper.feed(line({ type: "command_lifecycle", command_uuid: "r1", state: "started" }), now());
  const events = mapper.feed(
    line({
      type: "assistant",
      parent_tool_use_id: null,
      message: {
        id: "m1",
        content: [
          { type: "thinking", thinking: "Weighing a rebase against a merge.\nA rebase keeps the history linear." },
          { type: "thinking", thinking: "" },
          { type: "redacted_thinking", data: "…" },
          { type: "text", text: "Rebased." },
        ],
      },
    }),
    now(),
  ).events;
  expect(events.length).toBe(2);
  const item = (events[0] as { Item: ThreadItem }).Item;
  expect([item.id, item.status]).toEqual(["m1:thinking:1", "completed"]);
  expect(item.title).toBe("Thinking: Weighing a rebase against a merge.");
  expect(item.kind.type === "tool" && item.kind.toolName === "Thinking" && item.kind.output?.endsWith("keeps the history linear.")).toBe(true);
  expect(events[1]).toMatchObject({ AssistantText: { text: "Rebased." } });
});

test("streamed usage adds up over the run's messages", () => {
  const mapper = new StreamMapper("s", none);
  const stream = (event: unknown) => line({ type: "stream_event", event, parent_tool_use_id: null });
  mapper.feed(line({ type: "command_lifecycle", command_uuid: "r1", state: "started" }), now());
  const totals: unknown[] = [];
  for (const event of [
    { type: "message_start", message: { id: "m1", usage: { input_tokens: 100, cache_read_input_tokens: 40, output_tokens: 1 } } },
    { type: "message_delta", usage: { output_tokens: 30 } },
    { type: "message_start", message: { id: "m2", usage: { input_tokens: 20, output_tokens: 1 } } },
    { type: "message_delta", usage: { output_tokens: 7 } },
  ])
    for (const e of mapper.feed(stream(event), now()).events)
      if (typeof e === "object" && "Usage" in e) totals.push([e.Usage.run_id, e.Usage.usage.inputTokens, e.Usage.usage.outputTokens, e.Usage.usage.cacheReadInputTokens]);
  expect(totals).toEqual([
    ["r1", 100, 1, 40],
    ["r1", 100, 30, 40],
    ["r1", 120, 31, 40],
    ["r1", 120, 37, 40],
  ]);
});

test("every run's spans tile its wall time and match its tool items", () => {
  for (const name of fixtures()) {
    if (name.includes("initialize-probe")) continue;
    const r = replay(name);
    for (const run of r.spans.filter((s) => s.kind === "run")) {
      const excl = r.spans.filter((s) => s.runId === run.runId).reduce((n, s) => n + (s.exclMs ?? 0), 0);
      expect(excl, `${name}: ${run.runId}`).toBe(run.endMs - run.startMs);
    }
    for (const item of items(r.events)) {
      const k = item.kind;
      let exit: number | undefined;
      let output: string;
      if (k.type === "command" && k.output !== undefined) [exit, output] = [k.exitCode, k.output];
      else if (k.type === "tool" && k.output !== undefined && k.toolName !== "Thinking") output = k.output;
      else continue;
      const key = `s/${item.id}`;
      const span = r.spans.find((s) => s.key === key);
      expect(span, `${name}: no span for ${key}`).toBeDefined();
      expect(span!.exitCode, `${name}: ${key}`).toBe(exit);
      expect(span!.outBytes, `${name}: ${key}`).toBe(Buffer.byteLength(output));
    }
  }
});

test("a tool's permission wait is its own span and the model has phases", () => {
  const spans = replay("permission-allow").spans;
  const wait = spans.find((s) => s.kind === "wait.permission")!;
  expect(wait.extra?.decidedBy).toBe("human");
  const bash = spans.find((s) => s.kind === "tool.bash")!;
  expect(wait.parent).toBe(bash.key);
  expect(wait.startMs >= bash.startMs && wait.endMs <= bash.endMs).toBe(true);
  // The first message: started 1330 ms in, the lifecycle at 174 ms; it stopped at 1559.
  const first = spans.filter((s) => s.kind === "model.first_token").sort((a, b) => a.startMs - b.startMs)[0]!;
  expect(first.endMs - first.startMs).toBe(1330 - 174);
  const message = spans.filter((s) => s.kind === "model.message").sort((a, b) => a.startMs - b.startMs)[0]!;
  expect(message.endMs - message.startMs).toBe(1559 - 174);
  expect(message.extra?.stopReason).toBe("tool_use");
  expect(spans.find((s) => s.kind === "run")!.extra?.durationApiMs).toBe(2308);
});

/** The probe's task run and its steer, from the fixture's meta line. */
function taskAndSteer(name: string): [string, string] {
  const recs = records(name);
  return [recs.find((r) => r.dir === "in" && r.msg.type === "user").msg.uuid, recs[0].msg.steer];
}

function itemStatus(events: RunnerEvent[], id: string): [ItemStatus, string | undefined] | undefined {
  const item = items(events)
    .reverse()
    .find((i) => i.id === id);
  return item && [item.status, item.runId];
}

test("a boundary steer supersedes the running turn after its tool and gets its own turn", () => {
  const r = replay("steer-boundary");
  const [task, steer] = taskAndSteer("steer-boundary");
  expect(runEnds(r.events)).toEqual([
    [task, { Superseded: { by: steer } }],
    [steer, { Completed: { text: "REDIRECTED" } }],
  ]);
  // The running tool was not cut: its result is kept.
  expect(itemStatus(r.events, "toolu_01JE4mGrY2TaxcDU99QyXGUR")).toEqual(["completed", task]);
  expect(r.events).toContainEqual({ RunStarted: { run_id: steer } });
});

test("a send-now steer stops the running tool and names it", () => {
  const r = replay("steer-send-now");
  const [task, steer] = taskAndSteer("steer-send-now");
  const sendNow = r.events.flatMap((e) => (typeof e === "object" && "SendNow" in e ? [e.SendNow] : []))[0];
  expect(sendNow).toEqual({ run_id: steer, outcome: "stopped", stopped_tool: "Sleep 5 seconds then echo one" });
  expect(itemStatus(r.events, "toolu_01CWvUjo2u8omdJKzvvJu3qq")).toEqual(["cancelled", task]);
  const ends = runEnds(r.events);
  expect(ends[0]).toEqual([task, { Superseded: { by: steer } }]);
  expect(ends[1]).toEqual([steer, { Completed: { text: "REDIRECTED" } }]);
});

test("a withdrawn steer never starts and the turn runs on", () => {
  const r = replay("steer-withdraw");
  const [task, steer] = taskAndSteer("steer-withdraw");
  // claude says `cancelled` before it answers the withdraw: the withdraw is reported first, then the run's end.
  const withdrawn = r.events.findIndex((e) => Bun.deepEquals(e, { Withdrawn: { run_id: steer, cancelled: true, by_stop: false } }));
  const ended = r.events.findIndex((e) => typeof e === "object" && "RunEnded" in e && e.RunEnded.run_id === steer);
  expect(withdrawn >= 0 && withdrawn < ended).toBe(true);
  expect(r.events.filter((e) => typeof e === "object" && "Withdrawn" in e).length).toBe(1);
  expect(r.events).not.toContainEqual({ RunStarted: { run_id: steer } });
  expect(runEnds(r.events)).toEqual([
    [steer, "Interrupted"],
    [task, { Completed: { text: "DONE" } }],
  ]);
});

test("a joined send stays filed under the turn and ends with it", () => {
  const r = replay("steer-joined");
  const [task, steer] = taskAndSteer("steer-joined");
  expect(r.events).toContainEqual({ Joined: { run_id: steer } });
  expect(r.events).not.toContainEqual({ RunStarted: { run_id: steer } });
  const done = { Completed: { text: "REDIRECTED" } };
  expect(runEnds(r.events)).toEqual([
    [task, done],
    [steer, done],
  ]);
  // Work after the boundary stays the turn's.
  expect(items(r.events).every((i) => i.runId === task)).toBe(true);
});

function midTurn(capabilities: string[]): StreamMapper {
  const mapper = new StreamMapper("s", none);
  mapper.send("task", "work", "plain");
  for (const l of [
    { type: "command_lifecycle", command_uuid: "task", state: "started" },
    { type: "system", subtype: "init", capabilities },
  ])
    mapper.feed(line(l), now());
  return mapper;
}

const request = (input: Input) => (input as { request: unknown }).request;

test("a now steer falls back by capability", () => {
  // send_now: only the message now; the stop follows its `queued`.
  let mapper = midTurn(["interrupt_receipt_v1", "interrupt_send_now_v1", "msg_lifecycle_v1"]);
  expect(mapper.send("steer", "stop", "now").length).toBe(1);
  const mapped = mapper.feed(line({ type: "command_lifecycle", command_uuid: "steer", state: "queued" }), now());
  expect(request(mapped.replies[0]!)).toEqual({ subtype: "interrupt", send_now: true, message_uuid: "steer" });
  // Without send_now: an interrupt scoped to the running message, then the message.
  mapper = midTurn(["interrupt_receipt_v1", "msg_lifecycle_v1"]);
  let lines = mapper.send("steer", "stop", "now");
  expect(request(lines[0]!)).toEqual({ subtype: "interrupt", for_user_message_uuids: ["task"] });
  expect((lines[1] as { uuid: string }).uuid).toBe("steer");
  // Without interrupt receipts: today's plain interrupt.
  mapper = midTurn([]);
  lines = mapper.send("steer", "stop", "now");
  expect(request(lines[0]!)).toEqual({ subtype: "interrupt" });
  // Between turns every mode is one plain new turn.
  expect(new StreamMapper("s", none).send("steer", "stop", "now").length).toBe(1);
});

test("back-to-back steers hand over turn by turn and the last one runs", () => {
  // Two steers claude merged into one turn, whose `result` names the second. That ended the second twice and never the
  // first, whose late end then landed on the next steer's run before it began.
  const mapper = midTurn([]);
  const events: RunnerEvent[] = [];
  const feed = (lines: unknown[]) => {
    for (const l of lines) events.push(...mapper.feed(line(l), now()).events);
  };
  const lifecycle = (run: string, state: string) => ({ type: "command_lifecycle", command_uuid: run, state });
  const cut = (run: string, why: string) => ({ type: "result", subtype: "success", is_error: false, result: "", terminal_reason: why, user_message_uuid: run });
  for (const steer of ["s1", "s2"]) {
    mapper.send(steer, "the answer", "boundary");
    feed([lifecycle(steer, "queued")]);
  }
  feed([cut("task", "aborted_tools"), lifecycle("task", "cancelled"), lifecycle("s1", "started"), lifecycle("s2", "started")]);
  mapper.send("s3", "and this", "boundary");
  feed([lifecycle("s3", "queued"), cut("s2", "aborted_streaming"), lifecycle("s1", "cancelled"), lifecycle("s2", "cancelled"), lifecycle("s3", "started")]);
  const by = (run: string) => ({ Superseded: { by: run } });
  expect(runEnds(events)).toEqual([
    ["task", by("s1")],
    ["s1", by("s3")],
    ["s2", by("s3")],
  ]);
  expect(events).toContainEqual({ Joined: { run_id: "s2" } });
  expect(events).toContainEqual({ RunStarted: { run_id: "s3" } });
  expect(mapper.hasOpenRun()).toBe(true);
});

test("a person's stop ends the turn interrupted and withdraws the waiting steer", () => {
  const mapper = midTurn(["interrupt_receipt_v1", "msg_lifecycle_v1"]);
  mapper.send("steer", "do this instead", "boundary");
  expect(mapper.stop().map(request)).toEqual([{ subtype: "interrupt" }, { subtype: "cancel_async_message", message_uuid: "steer" }]);
  const events: RunnerEvent[] = [];
  for (const l of [
    { type: "result", subtype: "error_during_execution", is_error: true, terminal_reason: "aborted_tools", user_message_uuid: "task" },
    { type: "command_lifecycle", command_uuid: "steer", state: "cancelled" },
    { type: "control_response", response: { subtype: "success", request_id: "fleetd-withdraw-1", response: { cancelled: true } } },
  ])
    events.push(...mapper.feed(line(l), now()).events);
  expect(runEnds(events)).toEqual([
    ["task", "Interrupted"],
    ["steer", "Interrupted"],
  ]);
  expect(events.filter((e) => typeof e === "object" && "Withdrawn" in e)).toEqual([{ Withdrawn: { run_id: "steer", cancelled: true, by_stop: true } }]);
});

/** Seen live on a resumed lead: claude first runs its own turn for a background task's notice left from the previous
 * process (a `result` with an `origin` and no `user_message_uuid`), then the message fleetd sent. */
test("a notice turn on resume ends no run of fleetd's", () => {
  const mapper = new StreamMapper("s", none);
  mapper.send("chat", "The human writes in your chat", "plain");
  const ends: string[] = [];
  for (const l of [
    { type: "system", subtype: "task_notification", task_id: "b1", status: "stopped", summary: "Background shell command didn't finish before the previous session ended" },
    { type: "command_lifecycle", command_uuid: "chat", state: "queued" },
    { type: "result", subtype: "success", is_error: false, result: "", num_turns: 0, origin: { kind: "task-notification" } },
    { type: "command_lifecycle", command_uuid: "chat", state: "started" },
    { type: "result", subtype: "success", is_error: false, result: "W8 is closed.", user_message_uuid: "chat" },
    { type: "command_lifecycle", command_uuid: "chat", state: "completed" },
  ])
    for (const e of mapper.feed(line(l), now()).events) {
      if (typeof e !== "object") continue;
      if ("RunStarted" in e) ends.push(`started ${e.RunStarted.run_id}`);
      if ("RunEnded" in e) ends.push(`ended ${e.RunEnded.run_id}: ${JSON.stringify(e.RunEnded.outcome)}`);
    }
  expect(ends).toEqual(["started chat", 'ended chat: {"Completed":{"text":"W8 is closed."}}']);
  expect(mapper.hasOpenRun()).toBe(false);
});

/** A Monitor fired after the agent's turn ended: claude runs a turn of its own for the notice, with no run of fleetd's
 * open. It runs as a run of the mapper's, which its `result` ends, and a message sent meanwhile runs after it. */
test("a turn claude starts for a notice while idle is a run of its own", () => {
  const mapper = new StreamMapper("s", none);
  const runs: string[] = [];
  const feed = (l: unknown) => {
    for (const e of mapper.feed(line(l), now()).events) {
      if (typeof e !== "object") continue;
      if ("RunStarted" in e) runs.push(`started ${e.RunStarted.run_id}`);
      if ("RunEnded" in e) runs.push(`ended ${e.RunEnded.run_id}: ${JSON.stringify(e.RunEnded.outcome)}`);
      if ("AssistantText" in e) runs.push(`said ${e.AssistantText.text}`);
    }
  };
  feed({ type: "system", subtype: "task_notification", task_id: "b1", status: "completed", summary: 'Monitor "build" stream ended' });
  expect(mapper.hasOpenRun()).toBe(false);
  feed({ type: "assistant", parent_tool_use_id: null, message: { id: "m1", role: "assistant", content: [{ type: "text", text: "The build passed." }] } });
  expect(mapper.hasOpenRun()).toBe(true);
  mapper.send("lead", "Push it.", "plain");
  for (const l of [
    { type: "command_lifecycle", command_uuid: "lead", state: "queued" },
    { type: "result", subtype: "success", is_error: false, result: "The build passed.", num_turns: 1, origin: { kind: "task-notification" } },
    { type: "command_lifecycle", command_uuid: "lead", state: "started" },
    { type: "result", subtype: "success", is_error: false, result: "Pushed.", user_message_uuid: "lead" },
  ])
    feed(l);
  const woke = runs[0]!.slice("started ".length);
  expect(woke).toStartWith("s-woke-");
  expect(runs).toEqual([
    `started ${woke}`,
    "said The build passed.",
    `ended ${woke}: {"Completed":{"text":"The build passed."}}`,
    "started lead",
    'ended lead: {"Completed":{"text":"Pushed."}}',
  ]);
  expect(mapper.hasOpenRun()).toBe(false);
});

test("claude's tools arrive classified", () => {
  expect(toolClass("Read", { file_path: "/x/a.rs" })).toEqual({ type: "read", path: "/x/a.rs" });
  expect(toolClass("Glob", { pattern: "**/*.rs" })).toEqual({ type: "search", pattern: "**/*.rs" });
  expect(toolClass("WebSearch", { query: "tokio" })).toEqual({ type: "web", query: "tokio" });
  expect(toolClass("TodoWrite", {})).toEqual({ type: "plan" });
  expect(toolClass("mcp__fleetd__spawn_agent", {})).toEqual({ type: "mcp", server: "fleetd", tool: "spawn_agent" });
  expect(toolClass("Skill", {})).toBeUndefined();
  expect(toolClass("mcp__broken", {})).toBeUndefined();
});

/** Every recorded stdout line decodes, and none of the types fleetd reads falls through to `other` (protocol.rs). */
test("every fixture line decodes", () => {
  let lines = 0;
  for (const name of fixtures()) {
    records(name).forEach((rec, n) => {
      if (rec.dir !== "out") return;
      const decoded = decode(rec.msg);
      expect(decoded, `${name}:${n + 1}`).toBeDefined();
      if (decoded!.type === "other") expect(["system", "assistant", "user", "result", "control_request"], `${name}:${n + 1}`).not.toContain(rec.msg.type);
      lines++;
    });
  }
  expect(lines).toBeGreaterThan(100);
});

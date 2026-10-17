// Records the executor's shell/thread stream fixtures from the S0 lab, once. Not run in CI.
//   lab/up.sh && node apps/hub/test/record-fixtures.ts && lab/down.sh
// Costs a handful of tiny claude-haiku-5-5 turns. Writes scrubbed JSON to apps/hub/test/fixtures/.
// Also checks the open S0 question: does `--disallowedTools mcp__t3-code__*` hide every T3 tool (lab-a)?
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import {
  CommandId,
  MessageId,
  ORCHESTRATION_V2_WS_METHODS as M,
  type OrchestrationV2ShellStreamItem,
  OrchestrationV2ShellStreamItem as ShellItemSchema,
  type OrchestrationV2ThreadShell,
  type OrchestrationV2ThreadStreamItem,
  OrchestrationV2ThreadStreamItem as ThreadItemSchema,
  OrchestrationV2TurnItem,
  ProjectId,
  WS_METHODS,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { connect, type T3Client } from "../src/executor/T3Connection.ts";

const LAB = process.env.FLEETD_LAB ?? path.join(process.env.HOME ?? "", "src/fleetd-lab");
const T3_SRC = process.env.T3_SRC ?? path.join(LAB, "t3-src");
const OUT = path.join(import.meta.dirname, "fixtures");
const MODEL = "claude-haiku-5-5";
const LABS = {
  a: { url: "http://127.0.0.1:4711", home: path.join(LAB, "home-a"), pid: path.join(LAB, "pids/lab-a.pid") },
  b: { url: "http://127.0.0.1:4712", home: path.join(LAB, "home-b"), pid: path.join(LAB, "pids/lab-b.pid") },
};
type LabRef = (typeof LABS)[keyof typeof LABS];

const scrubbedEnv = () => {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ["HOME", "PATH", "USER", "LANG"]) if (process.env[key] !== undefined) env[key] = process.env[key];
  return env;
};
const mint = (lab: LabRef) =>
  execFileSync(process.execPath, [path.join(T3_SRC, "apps/server/src/bin.ts"), "auth", "session", "issue",
    "--base-dir", lab.home, "--ttl", "1h", "--label", "fleetd-fixtures", "--token-only"],
  { env: scrubbedEnv(), encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim().split("\n").at(-1)!.trim();

const encodeShell = Schema.encodeSync(Schema.toCodecJson(ShellItemSchema));
const encodeThread = Schema.encodeSync(Schema.toCodecJson(ThreadItemSchema));
const encodeItem = Schema.encodeSync(Schema.toCodecJson(Schema.NullOr(OrchestrationV2TurnItem)));

/** Replace machine-specific paths, then refuse to write anything that still looks like a secret. */
const scrub = (value: unknown) => {
  let text = JSON.stringify(value, null, 1);
  text = text.split(LAB).join("/lab").split(process.env.HOME ?? "/nonexistent").join("/home/user");
  for (const bad of [/wsTicket/i, /Bearer /, /ANTHROPIC_/, /sk-[a-z0-9-]{10,}/i, /\/home\/(?!user)/]) {
    if (bad.test(text)) throw new Error(`fixture still contains ${bad}`);
  }
  return text;
};
const write = (name: string, value: unknown) => {
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, name), `${scrub(value)}\n`);
  console.log(`wrote ${name}`);
};

const until = <A>(what: string, check: () => A | undefined, timeoutMs = 180_000) =>
  Effect.gen(function* () {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const v = check();
      if (v !== undefined) return v;
      yield* Effect.sleep("250 millis");
    }
    return yield* Effect.fail(new Error(`timed out: ${what}`));
  });

const collect = <A, E>(stream: Stream.Stream<A, E>) =>
  Effect.gen(function* () {
    const items: A[] = [];
    const fiber = yield* stream.pipe(
      Stream.runForEach((a) => Effect.sync(() => void items.push(a))),
      Effect.forkDetach,
    );
    return { items, stop: Fiber.interrupt(fiber) };
  });

/** Items of a finite resume: everything up to the `synchronized` marker. */
const resume = (client: T3Client, afterSequence: number) =>
  client[M.subscribeShell]({ afterSequence, requestCompletionMarker: true }).pipe(
    Stream.takeUntil((i) => i.kind === "synchronized"),
    Stream.runCollect,
    Effect.map((c) => [...c]),
  );

const latestShell = (items: ReadonlyArray<OrchestrationV2ShellStreamItem>, threadId: string) => {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]!;
    if (item.kind === "thread.updated" && item.thread.id === threadId) return item.thread;
  }
  return undefined;
};
const whenShell = (items: OrchestrationV2ShellStreamItem[], threadId: string, ok: (t: OrchestrationV2ThreadShell) => boolean, what: string) =>
  until(what, () => { const t = latestShell(items, threadId); return t && ok(t) ? t : undefined; });

const id = () => crypto.randomUUID();
const launch = (client: T3Client, projectId: string, title: string, prompt: string, opts: { model?: string; runtimeMode?: "full-access" | "approval-required" } = {}) =>
  client[M.launchThread]({
    commandId: CommandId.make(id()),
    projectId: ProjectId.make(projectId),
    title,
    generateTitle: false,
    modelSelection: { instanceId: "fleetd", model: opts.model ?? MODEL, options: [{ id: "effort", value: "low" }] } as never,
    runtimeMode: opts.runtimeMode ?? "full-access",
    interactionMode: "default",
    workspaceStrategy: { type: "root" },
    initialMessage: { text: prompt, attachments: [] },
  }).pipe(Effect.map((r) => r.threadId));

const descendants = (root: number) => {
  const parent = new Map<number, number>();
  for (const e of fs.readdirSync("/proc")) {
    if (!/^\d+$/.test(e)) continue;
    try { const s = fs.readFileSync(`/proc/${e}/stat`, "utf8"); parent.set(Number(e), Number(s.slice(s.lastIndexOf(")") + 2).split(" ")[1])); } catch { /* exited */ }
  }
  const out: string[][] = [];
  for (const pid of parent.keys()) {
    let p = parent.get(pid);
    while (p !== undefined && p > 1 && p !== root) p = parent.get(p);
    if (p !== root) continue;
    try { out.push(fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean)); } catch { /* exited */ }
  }
  return out;
};

const session = (lab: LabRef) =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    const client = yield* connect(lab.url, mint(lab)).pipe(Scope.provide(scope));
    return { client, close: Scope.close(scope, Exit.void) };
  });

const recordLabB = Effect.gen(function* () {
  const { client, close } = yield* session(LABS.b);
  const live = yield* collect(client[M.subscribeShell]({}));
  const snapshot = yield* until("shell snapshot", () => live.items.find((i) => i.kind === "snapshot" && i.resolvedRepositoryIdentityRoots === undefined));
  if (snapshot.kind !== "snapshot") throw new Error("unreachable");
  const before = snapshot.snapshot.snapshotSequence;
  let projectId = snapshot.snapshot.projects.find((p) => p.workspaceRoot.endsWith("repo-b"))?.id as string | undefined;
  if (projectId === undefined) {
    projectId = id();
    yield* client[WS_METHODS.projectsMutate]({ type: "project.create", commandId: CommandId.make(id()), projectId: ProjectId.make(projectId), title: "lab-b repo", workspaceRoot: path.join(LAB, "repo-b") });
  }

  // 1. completed run with a passing and a failing command (reused if an earlier recording made it);
  //    then a second run on the same thread.
  const A_TITLE = "fixtures: echo and false";
  let a = snapshot.snapshot.threads.find((t) => t.title === A_TITLE && t.status === "completed")?.id;
  if (a === undefined) {
    a = yield* launch(client, projectId, A_TITLE,
      "Use the Bash tool to run `echo hi`, then in a separate Bash call run `false`. Then reply with the single word DONE.");
  }
  const threadStream = yield* collect(client[M.subscribeThread]({ threadId: a, acceptBoundedSnapshot: true }));
  const first = snapshot.snapshot.threads.find((t) => t.id === a) ?? (yield* whenShell(live.items, a, (t) => t.status === "completed", "thread a completed"));
  yield* client[M.dispatchCommand]({
    type: "message.dispatch", createdBy: "user", creationSource: "web", commandId: CommandId.make(id()), threadId: a,
    messageId: MessageId.make(id()), text: "Reply with the single word OK.", attachments: [], deliveryIntent: "auto",
    dispatchMode: { type: "start_immediately" },
  } as never);
  yield* whenShell(live.items, a, (t) => t.status === "completed" && t.latestRunId !== first.latestRunId, "thread a run 2 completed");
  yield* Effect.sleep("2 seconds");
  yield* threadStream.stop;

  // 2. approval-required: waits on a permission request, then we interrupt it.
  // A read-only command like `echo` is auto-allowed, so ask for one that writes.
  const c = yield* launch(client, projectId, "fixtures: approval wait",
    "Use the Bash tool to run `touch fixtures-approval.txt`, then reply with the single word DONE.", { runtimeMode: "approval-required" });
  const waiting = yield* whenShell(live.items, c, (t) => t.pendingRuntimeRequest !== null || t.status === "waiting", "thread c waiting");
  yield* client[M.dispatchCommand]({ type: "run.interrupt", commandId: CommandId.make(id()), threadId: c, runId: waiting.activeRunId ?? waiting.latestRunId!, reason: "fleetd fixtures" } as never);
  yield* whenShell(live.items, c, (t) => t.status === "interrupted" || t.status === "cancelled" || t.status === "completed", "thread c terminal");

  // 3. a provider failure that costs nothing: a model that does not exist.
  const d = yield* launch(client, projectId, "fixtures: bad model", "Reply OK.", { model: "claude-nonexistent-0" });
  yield* whenShell(live.items, d, (t) => t.status === "failed" || t.status === "completed", "thread d terminal");
  yield* Effect.sleep("2 seconds");
  yield* live.stop;

  // Thread A as a tail/actions read sees it: the bounded snapshot, plus the full command items.
  const tail = yield* client[M.subscribeThread]({ threadId: a, acceptBoundedSnapshot: true }).pipe(Stream.take(1), Stream.runCollect, Effect.map((x) => [...x]));
  const snap = tail[0];
  const commands = snap?.kind === "snapshot" ? snap.projection.turnItems.filter((i) => i.type === "command_execution") : [];
  const full = [];
  for (const item of commands) full.push(encodeItem((yield* client[M.getTurnItem]({ threadId: a, itemId: item.id })).item));

  // Resume from the pre-run cursor (a replay), and from a cursor past the head (T3 answers with a snapshot).
  const replay = yield* resume(client, before);
  const head = Math.max(...live.items.flatMap((i) => ("sequence" in i ? [i.sequence] : [])));
  const reset = yield* resume(client, head + 1_000_000);
  yield* close;

  const enc = (items: ReadonlyArray<OrchestrationV2ShellStreamItem>) => items.map((i) => encodeShell(i));
  write("shell-live.json", { machine: "lab-b", before, threads: { a, c, d }, items: enc(live.items) });
  write("shell-resume-replay.json", { afterSequence: before, items: enc(replay) });
  write("shell-resume-snapshot.json", { afterSequence: head + 1_000_000, items: enc(reset) });
  write("thread-a-stream.json", { threadId: a, items: threadStream.items.map((i: OrchestrationV2ThreadStreamItem) => encodeThread(i)) });
  write("thread-a-tail.json", { threadId: a, items: tail.map((i) => encodeThread(i)), commandItems: full });
});

// The open S0 question, on lab-a: with `--disallowedTools mcp__t3-code__*`, which T3 tools can the agent see?
const checkWildcard = Effect.gen(function* () {
  const { client, close } = yield* session(LABS.a);
  const live = yield* collect(client[M.subscribeShell]({}));
  const snapshot = yield* until("shell snapshot", () => live.items.find((i) => i.kind === "snapshot" && i.resolvedRepositoryIdentityRoots === undefined));
  if (snapshot.kind !== "snapshot") throw new Error("unreachable");
  const projectId = snapshot.snapshot.projects.find((p) => p.workspaceRoot.endsWith("repo-a"))?.id;
  if (projectId === undefined) throw new Error("lab-a has no repo-a project (run the S0 spike once)");
  const serverPid = Number(fs.readFileSync(LABS.a.pid, "utf8").trim());
  const argv: string[][] = [];
  const sampler = setInterval(() => {
    for (const a of descendants(serverPid)) if (a.includes("--disallowedTools") && !argv.some((x) => x.join(" ") === a.join(" "))) argv.push(a);
  }, 150);
  const t = yield* launch(client, projectId, "wildcard deny check",
    "Reply with exactly two lines and do nothing else. Line 1: the names of the non-MCP tools available to you, comma-separated. " +
      "Line 2: the comma-separated names of every tool available to you whose name starts with mcp__ (write NONE if there are none).");
  yield* whenShell(live.items, t, (s) => s.status === "completed" || s.status === "failed", "wildcard thread terminal");
  clearInterval(sampler);
  const shell = latestShell(live.items, t);
  yield* live.stop;
  yield* close;
  const flags = argv.map((a) => a[a.indexOf("--disallowedTools") + 1]);
  console.log(`wildcard: claude --disallowedTools=${JSON.stringify([...new Set(flags)])}`);
  console.log(`wildcard: status=${shell?.status} reply=${JSON.stringify(shell?.latestVisibleMessage?.text)}`);
});

const stages = process.argv.slice(2);
for (const [name, stage] of [["b", recordLabB], ["wildcard", checkWildcard]] as const) {
  if (stages.length > 0 && !stages.includes(name)) continue;
  const exit = await Effect.runPromiseExit(stage);
  if (Exit.isFailure(exit)) {
    console.error(`stage ${name} failed: ${String(exit.cause).slice(0, 2000)}`);
    process.exitCode = 1;
  }
}
process.exit();

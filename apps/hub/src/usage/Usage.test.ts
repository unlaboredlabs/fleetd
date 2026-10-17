// The usage layer over the real tasks, slots, leads and write queue, with fake executors and a TestClock that starts
// at 1970-01-01T00:00Z (a Thursday). Limits are injected as the executor reports them: a failed thread summary,
// then the thread.usage_limited event ShellMapper builds from it.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { HubEvent, HubEventType, TaskId, ThreadId, ThreadSummary } from "@fleetd/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { TestClock } from "effect/testing";
import { describe, expect, it } from "vitest";
import { transitionEvent } from "../executor/ShellMapper.ts";
import * as Leads from "../leads/Leads.ts";
import * as LeadWakes from "../leads/LeadWakes.ts";
import * as EventLog from "../store/EventLog.ts";
import * as HubStore from "../store/HubStore.ts";
import * as Tasks from "../tasks/Tasks.ts";
import { LEAD, makeKit, nextEvent, REF, runKit } from "../tasks/testKit.ts";
import { countProbes } from "./probes.ts";
import * as Usage from "./Usage.ts";
import { loginKindOf } from "./UsageSource.ts";

const HOUR = 3_600_000;
const iso = (ms: number) => new Date(ms).toISOString();
const T = (n: number) => `T${n}` as TaskId;
const PR = "https://github.com/wynn-dev/lab/pull/7";
const USAGE = { class: "usage_limit", message: "Claude usage limit reached. Send the message again once the limit resets." };
const PROXY_400 = {
  class: "provider_error",
  message: 'API Error: 400 {"error":{"message":"unknown provider for model claude-opus-5-5","type":"invalid_request_error","code":"model_not_found","param":"model"}}',
};
const reading = Effect.succeed({ login: "custom_base_url" as const, local: false });

const spawn = (workstreamId: string, over: Partial<Tasks.SpawnInput> = {}) =>
  Effect.flatMap(Tasks.Tasks, (tasks) =>
    tasks.spawn(LEAD, {
      workstreamId,
      title: "add file",
      kind: "write",
      prompt: "create docs/x.md",
      areas: ["docs"],
      serves: "done:0",
      ...over,
    } as Tasks.SpawnInput),
  );

/** What the executor does when a thread fails on a limit: the failed summary, then thread.usage_limited from it. */
const limited = (threadId: string, error: { readonly class: string; readonly message: string }, resetAt?: string) =>
  Effect.gen(function* () {
    const now = DateTime.formatIso(yield* DateTime.now);
    const summary: ThreadSummary = {
      machineId: REF.machineId,
      threadId: threadId as ThreadId,
      projectId: REF.projectId,
      title: threadId,
      status: "failed",
      headline: "",
      latestMessageTail: "",
      lastError: error,
      ...(resetAt === undefined ? {} : { usageLimitResetAt: resetAt }),
      lastProgressAt: now,
      model: "claude-opus-5-5",
      stale: false,
      asOf: now,
    };
    yield* (yield* HubStore.HubStore).threads.upsert(summary);
    yield* (yield* EventLog.EventLog).append(
      transitionEvent({ type: "thread.usage_limited", threadId: summary.threadId }, { summary, runId: `r-${threadId}`, activeRunId: null, activeRunStarting: false }, REF.machineId),
    );
  });

const eventsOf = (type: HubEventType) =>
  Effect.flatMap(EventLog.EventLog, (log) => Effect.map(log.wait({ cursor: 0, types: [type], timeoutSec: 0 }), (page): ReadonlyArray<HubEvent> => page.events));

const head = Effect.flatMap(EventLog.EventLog, (e) => e.head());

describe("Usage", () => {
  it("parks a task at a usage limit and sends it one continue at the reset", async () => {
    const kit = makeKit();
    await runKit(
      kit,
      Effect.gen(function* () {
        const ws = yield* kit.setup;
        const usage = yield* Usage.Usage;
        const tasks = yield* Tasks.Tasks;
        yield* spawn(ws); // T1 in t2
        yield* spawn(ws, { title: "look", kind: "read", areas: [] }); // T2 in t3
        const before = yield* head;
        yield* limited("t2", USAGE, iso(HOUR));
        // Thread events are handled in order: once T2's end is handled, so is T1's limit.
        yield* kit.threadEvent("t3", "thread.completed", "looked");
        yield* nextEvent(before, "task.completed", "T2");

        expect(yield* tasks.get(T(1))).toMatchObject({ state: "idle", parked: { class: "usage_limit", since: iso(0), resumeAt: iso(HOUR) } });
        const status = yield* usage.status(REF.machineId, reading);
        expect(status).toMatchObject({ login: "custom_base_url", breaker: { state: "closed" }, parked: { leads: 0, tasks: 1 } });
        expect(status.lastEvents.map((e) => e.type)).toEqual(["thread.usage_limited"]);

        yield* TestClock.adjust(Duration.millis(HOUR - 1));
        expect(kit.sends.filter((s) => s.message === Usage.CONTINUE_MESSAGE)).toEqual([]);
        yield* TestClock.adjust(Duration.millis(1));
        expect(kit.sends.filter((s) => s.message === Usage.CONTINUE_MESSAGE).map((s) => s.threadId)).toEqual(["t2"]);
        const [resumed] = yield* eventsOf("usage.resumed");
        expect(resumed).toMatchObject({ summary: `Usage limit reset on lab-a; sent "continue" to 1 parked thread`, data: { breakerCleared: false, threads: [{ threadId: "t2", kind: "write", taskId: "T1" }] } });
        expect(yield* eventsOf("thread.usage_limited")).toHaveLength(1);
        expect(yield* eventsOf("usage.breaker")).toEqual([]);
        // The continue starts a run; the task takes its slot again and is no longer parked.
        yield* kit.threadEvent("t2", "thread.started");
        yield* kit.threadEvent("t2", "thread.completed", "done");
        yield* nextEvent(before, "task.completed", "T1");
        expect((yield* tasks.get(T(1)))?.parked).toBeUndefined();
      }),
    );
  });

  it("trips one breaker when two threads hit the same limit within 10 minutes, queues spawns and holds lead wakes, then resumes lead, review, write at the reset", async () => {
    const kit = makeKit();
    await runKit(
      kit,
      Effect.gen(function* () {
        const ws = yield* kit.setup; // the lead runs in t1
        const usage = yield* Usage.Usage;
        const tasks = yield* Tasks.Tasks;
        const reset = iso(2 * HOUR);
        yield* spawn(ws); // T1 write in t2
        yield* spawn(ws, { title: "review it", kind: "review", areas: [], pr: PR }); // T2 review in t3
        yield* spawn(ws, { title: "look", kind: "read", areas: [] }); // T3 read in t4
        const before = yield* head;

        yield* limited("t2", USAGE, reset);
        yield* usage.drain;
        expect(yield* usage.gate(REF.machineId)).toBeUndefined();
        yield* TestClock.adjust(Duration.minutes(1));
        yield* limited("t1", USAGE, reset);
        yield* usage.drain;
        yield* TestClock.adjust(Duration.minutes(1));
        yield* limited("t3", USAGE, reset);
        yield* kit.threadEvent("t4", "thread.completed", "looked");
        yield* nextEvent(before, "task.completed", "T3");
        yield* usage.drain;

        const breakers = yield* eventsOf("usage.breaker");
        expect(breakers.map((e) => e.summary)).toEqual(["Claude limit reached on lab-a's login; resets Thu 02:00 UTC; the lead and 1 task parked"]);
        expect(breakers[0]!.data).toMatchObject({ class: "usage_limit", until: reset, parked: { leads: 1, tasks: 1 } });
        expect((yield* (yield* Leads.Leads).get(REF))?.parked).toEqual({ class: "usage_limit", since: iso(60_000), resumeAt: reset });
        expect((yield* usage.status(REF.machineId, reading)).parked).toEqual({ leads: 1, tasks: 2 });

        // New work on the paused login queues with the reason; a lead wake waits.
        const launchesBefore = kit.launches.length;
        expect(yield* spawn(ws, { title: "more", kind: "read", areas: [] })).toMatchObject({
          taskId: "T4",
          state: "queued",
          queuedReason: "usage: paused until Thu 02:00 UTC (Claude limit on lab-a's login)",
        });
        yield* (yield* LeadWakes.LeadWakes).trigger(REF, { kind: "train", line: "PR #7 merged" });
        yield* TestClock.adjust(LeadWakes.WAKE_DEBOUNCE);
        expect(kit.sends).toEqual([]);
        expect(kit.launches).toHaveLength(launchesBefore);

        yield* TestClock.adjust(Duration.millis(2 * HOUR - 2 * 60_000 - Duration.toMillis(LeadWakes.WAKE_DEBOUNCE)));
        expect(kit.sends.map((s) => [s.threadId, s.message])).toEqual([
          ["t1", Usage.CONTINUE_MESSAGE],
          ["t3", Usage.CONTINUE_MESSAGE],
          ["t2", Usage.CONTINUE_MESSAGE],
        ]);
        const [resumed] = yield* eventsOf("usage.resumed");
        expect(resumed).toMatchObject({ data: { breakerCleared: true, by: "reset" } });
        expect(resumed!.summary).toBe(`Usage pause on lab-a lifted (the limit reset); sent "continue" to 3 parked threads`);
        expect(yield* usage.gate(REF.machineId)).toBeUndefined();
        yield* nextEvent(before, "task.started", "T4");
        expect(kit.launches).toHaveLength(launchesBefore + 1);

        // The held wake goes out once the pause lifted, after its debounce.
        yield* TestClock.adjust(LeadWakes.WAKE_DEBOUNCE);
        expect(kit.sends.slice(3).map((s) => s.threadId)).toEqual(["t1"]);
        expect(kit.sends[3]!.message).toContain("PR #7 merged");
        expect(yield* eventsOf("usage.breaker")).toHaveLength(1);
        expect((yield* tasks.get(T(1)))?.state).toBe("idle");
      }),
    );
  });

  it("does not trip on two limits more than 10 minutes apart", async () => {
    const kit = makeKit();
    await runKit(
      kit,
      Effect.gen(function* () {
        const ws = yield* kit.setup;
        const usage = yield* Usage.Usage;
        yield* spawn(ws);
        yield* limited("t2", USAGE, iso(3 * HOUR));
        yield* usage.drain;
        yield* TestClock.adjust(Duration.minutes(11));
        yield* limited("t1", USAGE, iso(3 * HOUR));
        yield* usage.drain;
        expect(yield* eventsOf("usage.breaker")).toEqual([]);
        expect((yield* usage.status(REF.machineId, reading)).breaker).toEqual({ state: "closed" });
      }),
    );
  });

  it("classifies the proxy's 'unknown provider for model' 400 as pool_exhausted and pauses until usage_resume", async () => {
    const kit = makeKit();
    await runKit(
      kit,
      Effect.gen(function* () {
        const ws = yield* kit.setup;
        const usage = yield* Usage.Usage;
        yield* spawn(ws); // t2
        yield* limited("t2", PROXY_400);
        yield* usage.drain;
        const [breaker] = yield* eventsOf("usage.breaker");
        expect(breaker?.summary).toBe(
          "your proxy has no account available for claude-opus-5-5; fleetd paused work on lab-a — check your proxy, then run usage_resume",
        );
        expect(yield* usage.gate(REF.machineId)).toBe("usage: paused until usage_resume (your proxy has no account for claude-opus-5-5)");
        expect((yield* usage.status(REF.machineId, reading)).breaker).toMatchObject({ state: "open", class: "pool_exhausted" });

        // No reset to wait for: a day later nothing has resumed.
        yield* TestClock.adjust(Duration.days(1));
        expect(kit.sends).toEqual([]);

        expect(yield* usage.resume(REF.machineId, "wynn")).toEqual({ resumed: 1 });
        expect(kit.sends.map((s) => [s.threadId, s.message])).toEqual([["t2", Usage.CONTINUE_MESSAGE]]);
        expect((yield* eventsOf("usage.resumed"))[0]?.summary).toBe(`Usage pause on lab-a lifted (usage_resume by wynn); sent "continue" to 1 parked thread`);
        expect(yield* usage.gate(REF.machineId)).toBeUndefined();
        expect((yield* usage.status(REF.machineId, reading)).breaker).toEqual({ state: "closed" });
      }),
    );
  });

  it("rebuilds the breaker and parked threads from the event log, as after a hub restart", async () => {
    const kit = makeKit();
    await runKit(
      kit,
      Effect.gen(function* () {
        const ws = yield* kit.setup;
        yield* spawn(ws);
        yield* limited("t2", PROXY_400);
        yield* (yield* Usage.Usage).drain;
        yield* Effect.scoped(
          Effect.gen(function* () {
            const restarted = Context.get(yield* Layer.build(Usage.layer), Usage.Usage);
            const status = yield* restarted.status(REF.machineId, reading);
            expect(status.breaker).toMatchObject({ state: "open", class: "pool_exhausted" });
            expect(status.parked).toEqual({ leads: 0, tasks: 1 });
            expect(yield* restarted.resume(REF.machineId, "wynn")).toEqual({ resumed: 1 });
          }),
        );
      }),
    );
  });
});

describe("probe counter", () => {
  const span = (name: string, attributes: Record<string, string> = {}) => JSON.stringify({ type: "effect-span", name, attributes });

  it("counts only lines that show a direct usage or reset-credit call, across rotations", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleetd-probes-"));
    fs.writeFileSync(
      path.join(dir, "server.trace.ndjson"),
      [span("UsageLimitRecoveryWorker.sweep"), span("readClaudeResetCredits"), span("http.client GET", { "url.full": "https://api.anthropic.com/api/oauth/usage?cedar_ember=1" })].join("\n"),
    );
    fs.writeFileSync(path.join(dir, "server.trace.ndjson.1"), [span("CliproxyApi.apiCall"), span("processRunner.runProcessCore")].join("\n"));
    fs.writeFileSync(path.join(dir, "other.log"), "api/oauth/usage\n");
    expect(await Effect.runPromise(countProbes(dir, "/nonexistent-home"))).toEqual({ observable: true, count: 2, source: dir });
  });

  it("is not observable without a trace file, and never reads the live T3 home", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "fleetd-home-"));
    const live = path.join(home, ".t3", "userdata", "logs");
    fs.mkdirSync(live, { recursive: true });
    fs.writeFileSync(path.join(live, "server.trace.ndjson"), "api/oauth/usage\n");
    expect(await Effect.runPromise(countProbes(live, home))).toMatchObject({ observable: false, reason: expect.stringContaining("~/.t3") });
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "fleetd-empty-"));
    expect(await Effect.runPromise(countProbes(empty, home))).toMatchObject({ observable: false, reason: `no T3 trace file in ${empty}` });
  });
});

describe("loginKindOf", () => {
  const provider = (auth: { status: "authenticated" | "unauthenticated" | "unknown"; type?: string }) =>
    ({ auth }) as unknown as Parameters<typeof loginKindOf>[0];
  const env = (...names: ReadonlyArray<string>) =>
    ({ driver: "claudeAgent", environment: names.map((name) => ({ name, value: "", sensitive: true, valueRedacted: true })) }) as unknown as Parameters<typeof loginKindOf>[1];

  it("reads the kind from provider status and env var names only", () => {
    expect(loginKindOf(provider({ status: "authenticated", type: "max" }), env())).toBe("subscription");
    expect(loginKindOf(provider({ status: "authenticated", type: "apiKey" }), env())).toBe("api_key");
    expect(loginKindOf(provider({ status: "unknown" }), env("ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN"))).toBe("custom_base_url");
    expect(loginKindOf(provider({ status: "unauthenticated" }), undefined)).toBe("unknown");
  });
});

// Watchers (src/hub/watchers): automations that look at the bot's own software on a schedule, open no order, and say
// one line in the chat only when something is off. GitHub, the sessions and their answers are fakes on a fake clock.
import { afterEach, expect, test } from "bun:test";
import type { Hub } from "../src/hub/api/hub.ts";
import type { Registry } from "../src/hub/api/registry.ts";
import { answer } from "../src/hub/automations/calls.ts";
import { automations, type NewAutomation } from "../src/hub/automations/index.ts";
import { register } from "../src/hub/automations/tools.ts";
import type { LaunchInput, LaunchOptions } from "../src/hub/executor/sessions.ts";
import type { LeadCall, LeadCaller } from "../src/hub/leads/seams.ts";
import { events } from "../src/hub/store/events.ts";
import { isoMs } from "../src/hub/store/time.ts";
import {
  checkWatch,
  deploys,
  dollars,
  lastDay,
  mainCi,
  message,
  RUN_LIMIT_MS,
  verdict,
  watchers,
  type WatcherPorts,
} from "../src/hub/watchers/index.ts";
import type { AutomationRun, AutomationWatch } from "../src/shared/contracts.ts";
import { ToolError } from "../src/shared/errors.ts";
import { caller, PROJECT, testHub } from "./hub-helpers.ts";

const MIN = 60_000;
const START = Date.parse("2026-11-22T10:00:00Z");
const SHA = "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2";

let cleanup: (() => void) | undefined;
afterEach(() => {
  cleanup?.();
  cleanup = undefined;
});

type Launched = { machineId: string; input: LaunchInput; options: LaunchOptions };

/** A hub whose bot's repo is github.com/acme/shop, with fake GitHub answers and sessions. */
function setup(answers: Record<string, unknown> = {}) {
  const t = testHub(START);
  cleanup = t.done;
  t.hub.db.conn
    .query("INSERT INTO repos (machine_id, project_id, checkout_machine_id, checkout_project_id, name, repo_key, base) VALUES (?, ?, ?, ?, 'shop', 'github.com/acme/shop', 'main')")
    .run(PROJECT.machineId, PROJECT.projectId, PROJECT.machineId, PROJECT.projectId);
  const launched: Launched[] = [];
  const stopped: string[] = [];
  const said = new Map<string, string>();
  const asked: string[] = [];
  const github = { ...answers } as Record<string, unknown>;
  const ports: WatcherPorts = {
    launch: async (machineId, input, options) => {
      launched.push({ machineId, input, options });
      return `th-${launched.length}`;
    },
    stop: async (thread) => void stopped.push(thread.threadId),
    text: async (thread) => said.get(thread.threadId),
    cost: async () => 0.0123,
    github: async (path) => {
      asked.push(path);
      const key = Object.keys(github).find((k) => path.startsWith(k));
      return key === undefined ? { ok: false, status: 404, message: "Not Found" } : { ok: true, value: github[key] };
    },
  };
  watchers(t.hub).port = ports;
  return { ...t, launched, stopped, said, asked, github };
}

/** Main's CI on acme/shop: its head with one failed and one passed check. */
const failing = (conclusion = "failure") => ({
  "repos/acme/shop/commits/main": { sha: SHA, commit: { message: "Fix the cart\n\nbody", committer: { date: "2026-11-22T09:30:00Z" } } },
  [`repos/acme/shop/commits/${SHA}/check-runs`]: {
    check_runs: [
      { id: 1, name: "test (linux)", status: "completed", conclusion, completed_at: "2026-11-22T09:50:00Z", html_url: "https://github.com/acme/shop/actions/runs/7/job/8" },
      { id: 2, name: "lint", status: "completed", conclusion: "success", completed_at: "2026-11-22T09:40:00Z" },
    ],
  },
  [`repos/acme/shop/commits/${SHA}/status`]: { statuses: [] },
});

const watch = (kind: string, every = "15m", profile?: string): AutomationWatch => ({ kind, every, ...(profile ? { profile } : {}) });

const watcher = (w: AutomationWatch, prompt = "x"): NewAutomation => ({
  projectRef: PROJECT,
  name: "",
  prompt,
  schedule: { tz: "UTC" },
  webhook: true,
  by: "human",
  confirmed: true,
  watch: w,
});

async function settle(hub: Hub): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await Bun.sleep(2);
    await automations(hub).settled();
    await watchers(hub).settled();
  }
}

const chatLines = (hub: Hub) =>
  hub.db
    .all<{ data: string }>("SELECT data FROM chat_messages WHERE machine_id = ? AND project_id = ? ORDER BY seq", [PROJECT.machineId, PROJECT.projectId])
    .map((r) => (JSON.parse(r.data) as { text?: string }).text ?? "");

const orders = (hub: Hub) => hub.db.all<{ n: number }>("SELECT n FROM workstreams").length;

const ended = (hub: Hub, threadId: string, type: "thread.completed" | "thread.failed" = "thread.completed") =>
  events(hub).append({ at: isoMs(hub.clock.now()), type, machineId: PROJECT.machineId, threadId, summary: "ended", data: { threadId } });

test("a Main's CI watcher keeps its preset's name and a 15-minute schedule, with no webhook", () => {
  const { hub } = setup();
  const [a, secret] = automations(hub).create(watcher(watch("main_ci")));
  expect(secret).toBeUndefined();
  expect([a.name, a.prompt, a.webhook, a.schedule?.cron, a.watch?.every]).toEqual(["Main's CI", "Main's CI", false, "*/15 * * * *", "15m"]);
  expect(a.nextRunAt).toBe("2026-11-22T10:15:00.000Z");
  // One preset of a kind per bot.
  expect(() => automations(hub).create(watcher(watch("main_ci", "day")))).toThrow("already has a Main's CI watcher");
  // A profile the bot doesn't allow is refused.
  expect(() => automations(hub).create(watcher(watch("other", "hour", "nope"), "Is fleetd.sh up?"))).toThrow("doesn't allow the profile 'nope'");
  // Several "Something else" watchers, each named by its sentence.
  const [o] = automations(hub).create(watcher(watch("other", "day"), "  Watch the   checkout errors in Sentry "));
  expect([o.name, o.prompt, o.schedule?.cron]).toEqual(["Watch the checkout errors in Sentry", "Watch the checkout errors in Sentry", "0 9 * * *"]);
});

test("a look that finds a failed check posts one line with its evidence, opens no order and keeps its cost", async () => {
  const { hub, launched, said } = setup(failing());
  const [a] = automations(hub).create(watcher(watch("main_ci")));
  watchers(hub).start();
  const run = await automations(hub).run(a.automationId, { kind: "manual", by: "human" });
  await settle(hub);
  expect(run.state).toBe("running");
  expect(launched.length).toBe(1);
  const { input, options } = launched[0]!;
  // A preset's session has no tools at all: the hub gave it the evidence.
  expect(options.onlyTools).toEqual([]);
  expect(options.mcp).toEqual({ userServers: false, servers: [] });
  expect(input.runtimeMode).toBe("approval-required");
  expect(input.prompt).toContain("acme/shop main is at a1b2c3d4e5f6");
  expect(input.prompt).toContain("- test (linux): failure, finished 2026-11-22 09:50 UTC, 10 min ago (https://github.com/acme/shop/actions/runs/7/job/8)");
  expect(input.prompt).not.toContain("- lint");

  said.set("th-1", "Looked at the checks.\n\ntest (linux) failed on main at a1b2c3d (09:50 UTC): https://github.com/acme/shop/actions/runs/7/job/8");
  ended(hub, "th-1");
  await settle(hub);
  const done = automations(hub).runs(a.automationId, 5)[0]!;
  expect(done.state).toBe("done");
  expect(done.said).toBe("test (linux) failed on main at a1b2c3d (09:50 UTC): https://github.com/acme/shop/actions/runs/7/job/8");
  expect(done.costUsd).toBe(0.0123);
  expect(done.workstreamId).toBeUndefined();
  expect(orders(hub)).toBe(0);
  expect(chatLines(hub)).toEqual([`Main's CI: ${done.said}`]);
  // Its run links that line, so its row opens it in the chat.
  const line = hub.db.all<{ n: number }>("SELECT n FROM chat_messages ORDER BY seq DESC LIMIT 1")[0]!.n;
  expect(done.messageId).toBe(`m${line}`);
  // Its end is an automation.run event, so the apps read the row and its runs again.
  const ran = events(hub).page(0, ["automation.run"]).events;
  expect(ran.at(-1)?.data).toMatchObject({ runId: done.runId, state: "done", automationId: a.automationId });
  expect(ran.at(-1)?.summary).toContain("spoke up: test (linux) failed");
  const listed = automations(hub).get(a.automationId)!;
  expect(listed.lastDay).toEqual({ runs: 1, spoke: 1, costUsd: 0.0123 });
});

test("an OK answer posts nothing, and the same evidence again starts no session", async () => {
  const { hub, clock, launched, said } = setup(failing("success"));
  const [a] = automations(hub).create(watcher(watch("main_ci")));
  watchers(hub).start();
  await automations(hub).run(a.automationId, { kind: "manual", by: "human" });
  await settle(hub);
  said.set("th-1", "All checks passed.\n**OK**");
  ended(hub, "th-1");
  await settle(hub);
  expect(automations(hub).runs(a.automationId, 5)[0]).toMatchObject({ state: "done", costUsd: 0.0123 });
  expect(chatLines(hub)).toEqual([]);

  clock.ms += 15 * MIN;
  await automations(hub).run(a.automationId, { kind: "manual", by: "human" });
  await settle(hub);
  expect(launched.length).toBe(1);
  const again = automations(hub).runs(a.automationId, 5)[0]!;
  expect(again).toMatchObject({ state: "done", why: "Nothing changed since its last look.", costUsd: 0 });
  expect(events(hub).page(0, ["automation.run"]).events.at(-1)?.data).toMatchObject({ runId: again.runId, state: "done" });
  expect(automations(hub).get(a.automationId)!.lastDay).toEqual({ runs: 2, spoke: 0, costUsd: 0.0123 });
});

test("a run waits for the look before it: one at a time", async () => {
  const { hub, launched } = setup(failing());
  const [a] = automations(hub).create(watcher(watch("main_ci")));
  await automations(hub).run(a.automationId, { kind: "manual", by: "human" });
  await settle(hub);
  const second = await automations(hub).run(a.automationId, { kind: "manual", by: "human" });
  expect(second.state).toBe("skipped");
  expect(launched.length).toBe(1);
});

test("GitHub that can't be read fails the run and posts nothing", async () => {
  const { hub, launched } = setup({});
  const [a] = automations(hub).create(watcher(watch("main_ci")));
  await automations(hub).run(a.automationId, { kind: "manual", by: "human" });
  await settle(hub);
  expect(launched.length).toBe(0);
  const run = automations(hub).runs(a.automationId, 5)[0]!;
  expect(run.state).toBe("failed");
  expect(run.why).toContain("GitHub couldn't be read: GitHub answered 404");
  expect(chatLines(hub)).toEqual([]);
});

test("a look still going after its limit is stopped and fails; a failed session posts nothing", async () => {
  const { hub, clock, stopped, said } = setup(failing());
  const [a] = automations(hub).create(watcher(watch("main_ci")));
  await automations(hub).run(a.automationId, { kind: "manual", by: "human" });
  await settle(hub);
  clock.ms += RUN_LIMIT_MS + MIN;
  await watchers(hub).sweep();
  expect(stopped).toEqual(["th-1"]);
  expect(automations(hub).runs(a.automationId, 5)[0]).toMatchObject({ state: "failed", why: "It ran past 10 minutes and was stopped." });

  clock.ms += 15 * MIN;
  said.set("th-2", "test failed");
  await automations(hub).run(a.automationId, { kind: "manual", by: "human" });
  await settle(hub);
  watchers(hub).start();
  ended(hub, "th-2", "thread.failed");
  await settle(hub);
  expect(automations(hub).runs(a.automationId, 5)[0]).toMatchObject({ state: "failed", costUsd: 0.0123 });
  expect(chatLines(hub)).toEqual([]);
});

test("Something else gets the sentence, WebFetch, WebSearch and nothing that writes", async () => {
  const { hub, launched } = setup();
  const [a] = automations(hub).create(watcher(watch("other", "hour"), "Check that https://shop.example is up."));
  await automations(hub).run(a.automationId, { kind: "manual", by: "human" });
  await settle(hub);
  const { input, options } = launched[0]!;
  expect(options.onlyTools).toEqual(["WebFetch", "WebSearch"]);
  expect(input.prompt).toContain("What to watch, as the person said it: Check that https://shop.example is up.");
  expect(input.prompt).toContain("Look, change nothing");
  expect(input.title).toBe("fleetd watcher: Check that https://shop.example is up.");
});

test("Deploys is offered only once the repo has GitHub deployments", async () => {
  const none = setup({ "repos/acme/shop/deployments": [] });
  expect(await watchers(none.hub).watchable(PROJECT)).toEqual(["main_ci", "other"]);
  none.done();
  cleanup = undefined;
  const some = setup({ "repos/acme/shop/deployments": [{ id: 9, environment: "production", ref: "main", sha: SHA, created_at: "2026-11-22T09:00:00Z" }] });
  expect(await watchers(some.hub).watchable(PROJECT)).toEqual(["main_ci", "deploys", "other"]);
  // The app's list carries it.
  const tools = new Map<string, (hub: Hub, c: unknown, input: unknown) => unknown>();
  register({ add: (name: string, fn: never) => void tools.set(name, fn) } as unknown as Registry);
  const out = (await tools.get("automation_list")!(some.hub, caller("read"), { projectRef: PROJECT })) as { watchable?: string[] };
  expect(out.watchable).toEqual(["main_ci", "deploys", "other"]);
});

test("a watcher's first look a day after it was made ends its first day with one line saying what it cost", async () => {
  const { hub, clock, said } = setup(failing("success"));
  const [a] = automations(hub).create(watcher(watch("main_ci", "hour")));
  watchers(hub).start();
  await automations(hub).run(a.automationId, { kind: "manual", by: "human" });
  await settle(hub);
  said.set("th-1", "OK");
  ended(hub, "th-1");
  await settle(hub);
  clock.ms += 24 * 60 * MIN;
  // A new head: a new look.
  const head = watchers(hub).port;
  watchers(hub).port = {
    ...head,
    github: async (path) =>
      path.startsWith("repos/acme/shop/commits/main") ? { ok: true, value: { sha: "f".repeat(40), commit: { committer: { date: "2026-11-23T09:00:00Z" } } } } : { ok: true, value: { check_runs: [], statuses: [] } },
  };
  await automations(hub).run(a.automationId, { kind: "manual", by: "human" });
  await settle(hub);
  said.set("th-2", "OK");
  ended(hub, "th-2");
  await settle(hub);
  expect(chatLines(hub)).toEqual(["Main's CI watcher, first day: 1 look, spoke up 0 times, cost $0.0123."]);
});

test("a watcher's frequency and profile change; a preset's prompt and a watcher's schedule don't", () => {
  const { hub } = setup();
  const [a] = automations(hub).create(watcher(watch("main_ci")));
  const [daily] = automations(hub).update(a.automationId, { watch: watch("main_ci", "day") }, "human");
  expect([daily.schedule?.cron, daily.watch?.every, daily.nextRunAt]).toEqual(["0 9 * * *", "day", "2026-11-23T09:00:00.000Z"]);
  expect(() => automations(hub).update(a.automationId, { prompt: "Something else" }, "human")).toThrow("is a preset");
  expect(() => automations(hub).update(a.automationId, { watch: watch("deploys") }, "human")).toThrow("keeps what it watches");
  expect(() => automations(hub).update(a.automationId, { schedule: { cron: "* * * * *", tz: "UTC" } }, "human")).toThrow("follows how often it looks");
  expect(() => automations(hub).update(a.automationId, { webhook: true }, "human")).toThrow("has no webhook");
});

test("the lead adds a watcher when asked, in the person's zone", async () => {
  const { hub } = setup();
  const lead: LeadCaller = { projectRef: PROJECT, by: `lead:${PROJECT.machineId}/${PROJECT.projectId}`, agent: { kind: "lead" } };
  const out = (await answer(hub, lead, { op: "automation_create", name: "Checkout errors", prompt: "Watch checkout errors in Sentry", watch: { kind: "other", every: "hour" } } as LeadCall)) as {
    automation: { name: string; watch?: AutomationWatch; schedule?: { cron?: string } };
    next: string;
  };
  expect([out.automation.name, out.automation.watch?.kind, out.automation.schedule?.cron]).toEqual(["Checkout errors", "other", "0 * * * *"]);
  expect(out.next).toContain("opens no order");
  await expect(answer(hub, lead, { op: "automation_create", name: "x", prompt: "x", watch: { kind: "merge_train", every: "15m" } } as LeadCall)).rejects.toBeInstanceOf(ToolError);
});

// ---- rules -------------------------------------------------------------------------------------------------------

test("checkWatch knows the kinds and frequencies, and fleetd's own machinery isn't one", () => {
  expect(checkWatch(watch("deploys", "hour"))).toEqual({ kind: "deploys", every: "hour" });
  for (const kind of ["merge_train", "machines", "spend"]) expect(() => checkWatch(watch(kind))).toThrow("is not something a watcher watches");
  expect(() => checkWatch(watch("main_ci", "5m"))).toThrow("is not a watcher's frequency");
});

test("the answer's last line decides: OK is quiet, anything else is the line, cut to 300", () => {
  expect(verdict("Everything passed.\nOK")).toBeUndefined();
  expect(verdict("ok.")).toBeUndefined();
  expect(verdict("- **deploy to production failed** at 09:12")).toBe("deploy to production failed** at 09:12");
  expect(verdict("")).toBe("It ended without an answer.");
  expect([...verdict("x".repeat(500))!].length).toBe(300);
});

test("evidence keys move with a new head, a changed check, or a check that keeps running", () => {
  const now = START;
  const check = (status: string, conclusion: string | null) => [{ name: "test", status, conclusion, startedAt: "2026-11-22T09:55:00Z" }];
  const a = mainCi("acme/shop", "main", { sha: SHA }, check("in_progress", null), [], now);
  expect(mainCi("acme/shop", "main", { sha: SHA }, check("in_progress", null), [], now + 10 * MIN).key).toBe(a.key);
  expect(mainCi("acme/shop", "main", { sha: SHA }, check("in_progress", null), [], now + 40 * MIN).key).not.toBe(a.key);
  expect(mainCi("acme/shop", "main", { sha: SHA }, check("completed", "success"), [], now).key).not.toBe(a.key);
  expect(mainCi("acme/shop", "main", { sha: "b".repeat(40) }, check("in_progress", null), [], now).key).not.toBe(a.key);
  expect(mainCi("acme/shop", "main", { sha: SHA }, [], [], now).text).toContain("No check runs on it.");
  const d = deploys("acme/shop", [{ id: 3, environment: "production", ref: "main", createdAt: "2026-11-22T09:00:00Z", state: "failure", stateAt: "2026-11-22T09:10:00Z", url: "https://x/log" }], now);
  expect(d.text).toContain("- production: failure since 2026-11-22 09:10 UTC, 50 min ago; main, made 2026-11-22 09:00 UTC, 1 h ago (https://x/log)");
  expect(deploys("acme/shop", [], now).text).toBe("acme/shop has no GitHub deployments.");
});

test("a preset's message has its checks and evidence; usage counts the last day only", () => {
  const text = message(watch("deploys"), "Deploys", { text: "EVIDENCE", key: "k" }, []);
  expect(text).toContain("You have no tools and change nothing.");
  expect(text).toContain("in progress for over 30 minutes");
  expect(text).toContain("Evidence, read by fleetd just now:\nEVIDENCE");
  const run = (at: number, extra: Partial<AutomationRun>): AutomationRun => ({ runId: "ar_aaaaaaaa", automationId: "au_aaaaaaaa", trigger: "schedule", at: isoMs(at), state: "done", ...extra });
  expect(lastDay([run(START - 2 * MIN, { costUsd: 0.5, said: "x" }), run(START - 25 * 60 * MIN, { costUsd: 9 }), run(START, { state: "skipped" })], START)).toEqual({ runs: 1, spoke: 1, costUsd: 0.5 });
  expect([dollars(0), dollars(0.0042), dollars(0.0123), dollars(0.5), dollars(1.239)]).toEqual(["$0", "$0.0042", "$0.0123", "$0.50", "$1.24"]);
});

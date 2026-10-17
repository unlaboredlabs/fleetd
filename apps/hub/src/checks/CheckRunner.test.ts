import http from "node:http";
import type { AddressInfo } from "node:net";
import type { CheckSpec, ClaimId, MachineId, TaskId, WorkstreamId } from "@fleetd/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as LeadRecords from "../leads/LeadRecords.ts";
import { Asks } from "../ledger/Asks.ts";
import { Inbox } from "../ledger/Inbox.ts";
import * as EventLog from "../store/EventLog.ts";
import * as Tasks from "../tasks/Tasks.ts";
import { CheckRunner } from "./CheckRunner.ts";
import { GH_AUTH_FIX } from "./GitHub.ts";
import { Judges } from "./Judges.ts";
import { json, makeChecksKit, runChecksKit } from "./testKit.ts";

const C1 = "C1" as ClaimId;
const SHA = "a".repeat(40);
const LAB_A = "lab-a" as MachineId;

const runCheck = (spec: CheckSpec, index = 0) =>
  Effect.gen(function* () {
    const w = (yield* (yield* LeadRecords.LeadRecords).workstreams.get("W1" as WorkstreamId))!.workstream;
    return yield* (yield* CheckRunner).run({ workstream: w, claimId: C1 }, index, spec);
  });

const withKit = <A, E>(spec: ReadonlyArray<CheckSpec>, body: (kit: ReturnType<typeof makeChecksKit>) => Effect.Effect<A, E, any>) => {
  const kit = makeChecksKit();
  return runChecksKit(kit, Effect.andThen(kit.setup(spec), body(kit)) as Effect.Effect<A, E, never>);
};

const cmd = (argv: ReadonlyArray<string>, expectExit = 0, machineId = LAB_A): CheckSpec => ({ type: "cmd", machineId, argv, expectExit });

describe("cmd checks", () => {
  it("run on the project's machine in its workspace and compare the exit code", () =>
    withKit([cmd(["test", "-f", "docs/x.md"])], (kit) =>
      Effect.gen(function* () {
        kit.setNode(() => ({ exitCode: 0, outputTail: "", timedOut: false }));
        expect(yield* runCheck(cmd(["test", "-f", "docs/x.md"]))).toMatchObject({
          checkIndex: 0,
          result: "pass",
          exitCode: 0,
          ranBy: "node",
          evidence: "`test -f docs/x.md` in /w/p1 exited 0 (expected 0)",
        });
        expect(kit.commands).toEqual([{ machineId: "lab-a", input: { cwd: "/w/p1", argv: ["test", "-f", "docs/x.md"] } }]);

        kit.setNode(() => ({ exitCode: 1, outputTail: "no such file\n", timedOut: false }));
        expect(yield* runCheck(cmd(["test", "-f", "docs/x.md"]))).toMatchObject({
          result: "fail",
          exitCode: 1,
          evidence: "`test -f docs/x.md` in /w/p1 exited 1 (expected 0)\nno such file",
        });
      }),
    ));

  it("fail on a timeout, and error when the node is offline, the command did not exit, or it names another machine", () =>
    withKit([cmd(["sleep", "999"])], (kit) =>
      Effect.gen(function* () {
        kit.setNode(() => ({ exitCode: null, outputTail: "[fleetd: killed after 120 s]", timedOut: true }));
        const timedOut = yield* runCheck(cmd(["sleep", "999"]));
        expect(timedOut).toMatchObject({ result: "fail", evidence: "`sleep 999` timed out and was killed\n[fleetd: killed after 120 s]" });
        expect(timedOut.exitCode).toBeUndefined();

        kit.setNode(() => "offline");
        expect(yield* runCheck(cmd(["true"]))).toMatchObject({ result: "error", evidence: "`true` did not run on lab-a: lab-a's node is not linked to the hub" });

        kit.setNode(() => ({ exitCode: null, outputTail: "could not start nope: spawn nope ENOENT", timedOut: false }));
        expect((yield* runCheck(cmd(["nope"]))).result).toBe("error");

        expect(yield* runCheck(cmd(["true"], 0, "lab-b" as MachineId))).toMatchObject({
          result: "error",
          evidence: "cmd checks run in the project's workspace, which is on lab-a; this check names lab-b",
        });
      }),
    ));
});

describe("http checks", () => {
  let server: http.Server;
  let base = "";
  beforeAll(async () => {
    server = http.createServer((req, res) => {
      res.statusCode = req.url === "/missing" ? 404 : 200;
      res.end(req.url === "/missing" ? "nope" : "version 1.2.3 ok");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it("check the status and what the body contains", () =>
    withKit([{ type: "http", url: "http://x.test/", status: 200 }], () =>
      Effect.gen(function* () {
        expect(yield* runCheck({ type: "http", url: `${base}/health`, status: 200, contains: "1.2.3" })).toMatchObject({
          result: "pass",
          ranBy: "hub",
          evidence: `GET ${base}/health → HTTP 200 (expected 200); body contains "1.2.3"`,
        });
        expect(yield* runCheck({ type: "http", url: `${base}/health`, status: 200, contains: "2.0.0" })).toMatchObject({
          result: "fail",
          evidence: `GET ${base}/health → HTTP 200 (expected 200); body does not contain "2.0.0"\nversion 1.2.3 ok`,
        });
        expect((yield* runCheck({ type: "http", url: `${base}/missing`, status: 200 })).evidence).toBe(
          `GET ${base}/missing → HTTP 404 (expected 200)\nnope`,
        );
        const port = yield* Effect.promise(closedPort);
        const closed = yield* runCheck({ type: "http", url: `http://127.0.0.1:${port}/`, status: 200 });
        expect(closed.result).toBe("fail");
        expect(closed.evidence).toBe(`GET http://127.0.0.1:${port}/ failed: connect ECONNREFUSED 127.0.0.1:${port}`);
      }),
    ));
});

/** A port nothing listens on: bound once, then closed. */
const closedPort = () =>
  new Promise<number>((resolve) => {
    const probe = http.createServer().listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => resolve(port));
    });
  });

const pull = (merged: boolean, extra: Record<string, unknown> = {}) =>
  json({ merged, state: merged ? "closed" : "open", merged_at: merged ? "2026-10-17T10:00:00Z" : null, merge_commit_sha: merged ? SHA : null, ...extra });

describe("GitHub checks through gh", () => {
  it("pr_merged reads the named PR, or the newest PR a task of the workstream opened", () =>
    withKit([{ type: "pr_merged", repo: "wynn-dev/lab" }], (kit) =>
      Effect.gen(function* () {
        kit.setGh((path) => (path === "repos/wynn-dev/lab/pulls/3" ? pull(true) : path === "repos/wynn-dev/lab/pulls/7" ? pull(false) : json({})));
        expect(yield* runCheck({ type: "pr_merged", repo: "wynn-dev/lab", pr: 3 })).toMatchObject({
          result: "pass",
          ranBy: "hub",
          evidence: `wynn-dev/lab#3 merged at 2026-10-17T10:00:00Z as ${SHA.slice(0, 12)}`,
        });
        expect(kit.ghCalls[0]).toEqual(["api", "-H", "Accept: application/vnd.github+json", "repos/wynn-dev/lab/pulls/3"]);

        expect(yield* runCheck({ type: "pr_merged", repo: "wynn-dev/lab" })).toMatchObject({
          result: "error",
          evidence: "no PR to check: the check names none and no task of W1 opened a PR in wynn-dev/lab",
        });
        // The tasks kit's executor reports PR 7 for every finished task.
        yield* spawnFinishedTask(kit);
        expect(yield* runCheck({ type: "pr_merged", repo: "wynn-dev/lab" })).toMatchObject({ result: "fail", evidence: "wynn-dev/lab#7 is open, not merged" });
      }),
    ));

  it("ci_green passes only when the newest run of every check on the commit is green", () =>
    withKit([{ type: "ci_green", repo: "o/r" }], (kit) =>
      Effect.gen(function* () {
        const runs = (list: ReadonlyArray<Record<string, unknown>>) => json({ total_count: list.length, check_runs: list });
        let answer = runs([
          { id: 1, name: "test", status: "completed", conclusion: "failure" },
          { id: 2, name: "test", status: "completed", conclusion: "success" },
          { id: 3, name: "lint", status: "completed", conclusion: "skipped" },
        ]);
        kit.setGh((path) => (path === "repos/o/r" ? json({ default_branch: "main" }) : path.startsWith("repos/o/r/commits/") ? answer : json({})));
        expect(yield* runCheck({ type: "ci_green", repo: "o/r", ref: "v1" })).toMatchObject({ result: "pass", evidence: "2 check runs on v1 in o/r, all green" });
        expect(kit.ghCalls.at(-1)!.at(-1)).toBe("repos/o/r/commits/v1/check-runs?per_page=100");

        answer = runs([
          { id: 1, name: "test", status: "completed", conclusion: "failure" },
          { id: 2, name: "build", status: "in_progress", conclusion: null },
          { id: 3, name: "lint", status: "completed", conclusion: "success" },
        ]);
        expect(yield* runCheck({ type: "ci_green", repo: "o/r" })).toMatchObject({
          result: "fail",
          evidence: "2 of 3 check runs on the head of main in o/r are not green: build: in_progress, test: failure",
        });
        answer = runs([]);
        expect(yield* runCheck({ type: "ci_green", repo: "o/r" })).toMatchObject({ result: "fail", evidence: "no check runs on the head of main in o/r" });
      }),
    ));

  it("test finds the named check run on the merge commit of the workstream's PR", () =>
    withKit([{ type: "test", repo: "wynn-dev/lab", testId: "e2e" }], (kit) =>
      Effect.gen(function* () {
        yield* spawnFinishedTask(kit);
        let conclusion = "success";
        kit.setGh((path) =>
          path === "repos/wynn-dev/lab/pulls/7"
            ? pull(true)
            : path === `repos/wynn-dev/lab/commits/${SHA}/check-runs?per_page=100&check_name=e2e`
              ? json({ check_runs: [{ id: 9, name: "e2e", status: "completed", conclusion, html_url: "https://github.com/wynn-dev/lab/runs/9" }] })
              : json({ check_runs: [] }),
        );
        expect(yield* runCheck({ type: "test", repo: "wynn-dev/lab", testId: "e2e" })).toMatchObject({
          result: "pass",
          evidence: `"e2e" on merge commit ${SHA.slice(0, 12)} of #7: success (https://github.com/wynn-dev/lab/runs/9)`,
        });
        conclusion = "failure";
        expect((yield* runCheck({ type: "test", repo: "wynn-dev/lab", testId: "e2e" })).result).toBe("fail");
        expect(yield* runCheck({ type: "test", repo: "wynn-dev/lab", testId: "unit" })).toMatchObject({
          result: "fail",
          evidence: `no check run named "unit" on merge commit ${SHA.slice(0, 12)} of #7 in wynn-dev/lab`,
        });
      }),
    ));

  it("are errors with the fix when gh is not logged in or not installed", () =>
    withKit([{ type: "pr_merged", repo: "o/r", pr: 1 }], (kit) =>
      Effect.gen(function* () {
        kit.setGh(() => ({ exitCode: 4, stdout: "", stderr: "To get started with GitHub CLI, please run:  gh auth login" }));
        for (const spec of [
          { type: "pr_merged", repo: "o/r", pr: 1 },
          { type: "ci_green", repo: "o/r", ref: "main" },
          { type: "test", repo: "o/r", testId: "unit" },
        ] as const) {
          expect(yield* runCheck(spec)).toMatchObject({ result: "error", evidence: `gh is not authenticated: ${GH_AUTH_FIX}` });
        }
        kit.setGh(() => "missing");
        expect((yield* runCheck({ type: "pr_merged", repo: "o/r", pr: 1 })).evidence).toBe(
          `gh is not installed on the hub machine: install the GitHub CLI, then ${GH_AUTH_FIX}`,
        );
        kit.setGh(() => ({ exitCode: 1, stdout: "", stderr: "gh: Not Found (HTTP 404)" }));
        expect((yield* runCheck({ type: "pr_merged", repo: "o/r", pr: 1 })).evidence).toBe("gh api repos/o/r/pulls/1 failed: gh: Not Found (HTTP 404)");
      }),
    ));
});

describe("judge checks", () => {
  it("spawn a review task with only the criteria and artifact refs, and take its verdict", () =>
    withKit([{ type: "judge", criteria: "The page explains setup in under 10 steps." }], (kit) =>
      Effect.gen(function* () {
        const records = yield* LeadRecords.LeadRecords;
        const stored = (yield* records.workstreams.get("W1" as WorkstreamId))!;
        yield* records.workstreams.put({ ...stored, workstream: { ...stored.workstream, headline: "lead says: all done, trust me" } });
        yield* spawnFinishedTask(kit);
        const launchesBefore = kit.tasksKit.launches.length;

        const fiber = yield* Effect.forkChild(runCheck({ type: "judge", criteria: "The page explains setup in under 10 steps." }, 1));
        const task = yield* untilTask("review");
        expect(task).toMatchObject({ kind: "review", state: "running", title: "Judge W1 done:1 for C1" });
        const prompt = kit.tasksKit.launches[launchesBefore]!.input.prompt;
        expect(prompt).toContain("Criterion, frozen with the brief:\nThe page explains setup in under 10 steps.");
        expect(prompt).toContain("- T1: PR https://github.com/wynn-dev/lab/pull/7, branch fleetd/T1-add-file");
        expect(prompt).toContain("fleetd review verdict --task");
        expect(prompt).not.toContain("trust me");

        const judges = yield* Judges;
        expect(yield* judges.complete({ taskId: "T99" as TaskId, prHeadSha: SHA, blocking: 0, nonBlocking: 0, summary: "x" })).toBe(false);
        expect(yield* judges.complete({ taskId: task.taskId, prHeadSha: SHA, blocking: 1, nonBlocking: 2, summary: "Setup takes 14 steps." })).toBe(true);
        expect(yield* Fiber.join(fiber)).toMatchObject({
          result: "fail",
          ranBy: "judge",
          evidence: `judge ${task.taskId} at ${SHA.slice(0, 12)}: 1 blocking, 2 non-blocking. Setup takes 14 steps.`,
        });
      }),
    ));

  it("are an error when the judge task ends without a verdict", () =>
    withKit([{ type: "judge", criteria: "c" }], (kit) =>
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(runCheck({ type: "judge", criteria: "c" }));
        const task = yield* untilTask("review");
        yield* kit.tasksKit.threadEvent(task.threadRef!.threadId, "thread.completed", "I looked; seems fine.");
        expect(yield* Fiber.join(fiber)).toMatchObject({ result: "error", evidence: `the judge task ${task.taskId} ended (completed) without \`fleetd review verdict\`` });
      }),
    ));
});

describe("human checks", () => {
  it("file a do-ask and pass only when the human answers done", () =>
    withKit([{ type: "human", question: "Open /setup on your phone; does it load?" }], () =>
      Effect.gen(function* () {
        const human = { source: "human" as const, by: "human:phone" };
        const spec: CheckSpec = { type: "human", question: "Open /setup on your phone; does it load?" };
        const first = yield* Effect.forkChild(runCheck(spec, 2));
        const ask = yield* untilAsk;
        expect(ask).toMatchObject({
          kind: "do",
          class: "product",
          key: "w1.c1.done-2",
          workstreamId: "W1",
          text: "Check done:2 of W1 (docs): Open /setup on your phone; does it load?",
          steps: [{ text: "Open /setup on your phone; does it load?", where: "browser" }],
        });
        yield* (yield* Inbox).reply({ raw: "1 done" }, human);
        expect(yield* Fiber.join(first)).toMatchObject({ result: "pass", ranBy: "human", evidence: `the human answered done to ${ask.askId}` });

        const second = yield* Effect.forkChild(runCheck(spec, 3));
        const next = yield* untilAsk;
        yield* (yield* Inbox).reply({ raw: '1 "it 404s"' }, human);
        expect(yield* Fiber.join(second)).toMatchObject({ result: "fail", evidence: `the human answered "it 404s" to ${next.askId}` });
      }),
    ));
});

/** A finished write task on W1; the kit's executor reports PR 7 for it. */
const spawnFinishedTask = (kit: ReturnType<typeof makeChecksKit>) =>
  Effect.gen(function* () {
    const tasks = yield* Tasks.Tasks;
    const task = yield* tasks.spawn(
      { projectRef: { machineId: LAB_A, projectId: "p1" as never }, by: "lead:lab-a/p1" },
      { workstreamId: "W1" as WorkstreamId, title: "add file", kind: "write", prompt: "write docs/x.md", areas: ["docs"], serves: "done:0" } as unknown as Tasks.SpawnInput,
    );
    const cursor = yield* (yield* EventLog.EventLog).head();
    yield* kit.tasksKit.threadEvent(task.threadRef!.threadId, "thread.completed", "Done; opened a PR.");
    yield* (yield* EventLog.EventLog).wait({ cursor, types: ["task.completed"], timeoutSec: 3600 });
    return task;
  });

/** The newest task of `kind` once it exists, waiting on the event log. */
const untilTask = (kind: "review") =>
  Effect.gen(function* () {
    const events = yield* EventLog.EventLog;
    let cursor = 0;
    while (true) {
      const found = (yield* (yield* Tasks.Tasks).list({ limit: 10 })).find((t) => t.kind === kind && t.threadRef !== undefined);
      if (found !== undefined) return found;
      cursor = (yield* events.wait({ cursor, types: ["task.started"], timeoutSec: 3600 })).cursor;
    }
  });

/** The newest open ask once it exists, waiting on the event log. */
const untilAsk = Effect.gen(function* () {
  const events = yield* EventLog.EventLog;
  let cursor = 0;
  while (true) {
    const [found] = yield* (yield* Asks).list({ state: "open" });
    if (found !== undefined) return found;
    cursor = (yield* events.wait({ cursor, types: ["ask.created"], timeoutSec: 3600 })).cursor;
  }
});

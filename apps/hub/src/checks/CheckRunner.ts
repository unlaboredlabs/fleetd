// Runs one done-when check and says pass, fail or error (could not run), with evidence. `cmd` runs on the node, `http`
// and the GitHub checks on the hub, `judge` through a review task, `human` through a do-ask.
import {
  DecisionKey,
  type AskId,
  type CheckOutcome,
  type CheckResult,
  type CheckSpec,
  type ClaimId,
  type Workstream,
} from "@fleetd/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { Asks } from "../ledger/Asks.ts";
import * as EventLog from "../store/EventLog.ts";
import * as HubStore from "../store/HubStore.ts";
import * as Tasks from "../tasks/Tasks.ts";
import { GhError, GitHub } from "./GitHub.ts";
import { Judges } from "./Judges.ts";
import { NodeCommands } from "./NodeCommands.ts";

export const HTTP_TIMEOUT_MS = 10_000;
/** Recorded as the filer of `human` check asks. */
export const CLAIMS_BY = "hub:claims";
const EVIDENCE_MAX = 2000;

export interface CheckContext {
  readonly workstream: Workstream;
  readonly claimId: ClaimId;
}

export class CheckRunner extends Context.Service<
  CheckRunner,
  { readonly run: (ctx: CheckContext, checkIndex: number, spec: CheckSpec) => Effect.Effect<CheckResult> }
>()("fleetd/checks/CheckRunner") {}

export const ranByOf = (spec: CheckSpec): CheckResult["ranBy"] =>
  spec.type === "cmd" ? "node" : spec.type === "judge" ? "judge" : spec.type === "human" ? "human" : "hub";

interface Verdict {
  readonly result: CheckOutcome;
  readonly evidence: string;
  readonly exitCode?: number;
}

const verdict = (result: CheckOutcome, evidence: string, exitCode?: number): Verdict => ({
  result,
  evidence,
  ...(exitCode === undefined ? {} : { exitCode }),
});

/** A header line, then as much of the tail as fits. */
const withTail = (head: string, tail: string) => {
  const room = EVIDENCE_MAX - head.length - 1;
  const t = tail.trim();
  if (t === "" || room <= 0) return head.slice(0, EVIDENCE_MAX);
  return `${head}\n${t.length <= room ? t : `…${t.slice(t.length - room + 1)}`}`;
};

const ghError = (error: GhError) => verdict("error", error.message);

const short = (sha: string) => sha.slice(0, 12);

const PULL_URL = /github\.com\/([^/\s]+\/[^/\s]+)\/pull\/(\d+)/iu;

// The slices of GitHub's REST answers the checks read.
const Pull = Schema.Struct({
  merged: Schema.Boolean,
  state: Schema.String,
  merge_commit_sha: Schema.NullOr(Schema.String),
  merged_at: Schema.NullOr(Schema.String),
});
const RepoInfo = Schema.Struct({ default_branch: Schema.String });
const CheckRun = Schema.Struct({
  id: Schema.Number,
  name: Schema.String,
  status: Schema.String,
  conclusion: Schema.NullOr(Schema.String),
  html_url: Schema.optionalKey(Schema.NullOr(Schema.String)),
});
type CheckRun = typeof CheckRun.Type;
const CheckRuns = Schema.Struct({ check_runs: Schema.Array(CheckRun) });

const GREEN: ReadonlySet<string> = new Set(["success", "neutral", "skipped"]);
const isGreen = (run: CheckRun) => run.status === "completed" && GREEN.has(run.conclusion ?? "");
const runState = (run: CheckRun) => (run.status === "completed" ? (run.conclusion ?? "completed") : run.status);

/** The newest run of each name; re-runs replace earlier attempts. */
const latestByName = (runs: ReadonlyArray<CheckRun>) => {
  const latest = new Map<string, CheckRun>();
  for (const run of runs) if ((latest.get(run.name)?.id ?? -1) < run.id) latest.set(run.name, run);
  return [...latest.values()].sort((a, b) => a.name.localeCompare(b.name));
};

export const make = Effect.gen(function* () {
  const commands = yield* NodeCommands;
  const github = yield* GitHub;
  const judges = yield* Judges;
  const asks = yield* Asks;
  const events = yield* EventLog.EventLog;
  const store = yield* HubStore.HubStore;
  const tasks = yield* Tasks.Tasks;

  const api = <S extends Schema.Top & { readonly DecodingServices: never }>(schema: S, path: string) =>
    github.api(path).pipe(
      Effect.flatMap((json) =>
        Schema.decodeUnknownEffect(schema)(json).pipe(
          Effect.mapError(() => new GhError({ kind: "failed", message: `gh api ${path} returned an unexpected shape` })),
        ),
      ),
    );

  const cmd = (w: Workstream, spec: Extract<CheckSpec, { type: "cmd" }>) =>
    Effect.gen(function* () {
      const home = w.projectRef.machineId;
      if (spec.machineId !== home) {
        return verdict("error", `cmd checks run in the project's workspace, which is on ${home}; this check names ${spec.machineId}`);
      }
      const project = yield* store.projects.get(w.projectRef);
      if (project === undefined) return verdict("error", `the hub has no record of project ${w.projectRef.projectId} on ${home}`);
      const shown = `\`${spec.argv.join(" ")}\``;
      const ran = yield* Effect.result(commands.run(spec.machineId, { cwd: project.workspaceRoot, argv: spec.argv }));
      if (ran._tag === "Failure") return verdict("error", `${shown} did not run on ${spec.machineId}: ${ran.failure.message}`);
      const out = ran.success;
      if (out.timedOut) return verdict("fail", withTail(`${shown} timed out and was killed`, out.outputTail));
      if (out.exitCode === null) return verdict("error", withTail(`${shown} did not exit on its own`, out.outputTail));
      const head = `${shown} in ${project.workspaceRoot} exited ${out.exitCode} (expected ${spec.expectExit})`;
      return verdict(out.exitCode === spec.expectExit ? "pass" : "fail", withTail(head, out.outputTail), out.exitCode);
    });

  const http = (spec: Extract<CheckSpec, { type: "http" }>) =>
    Effect.tryPromise({
      try: async (signal) => {
        const response = await fetch(spec.url, { signal: AbortSignal.any([signal, AbortSignal.timeout(HTTP_TIMEOUT_MS)]) });
        return { status: response.status, body: (await response.text()).slice(0, 100_000) };
      },
      catch: (error) => (error instanceof Error && error.name === "TimeoutError" ? "no answer within 10 s" : describeFetchError(error)),
    }).pipe(
      Effect.map(({ status, body }) => {
        const statusOk = status === spec.status;
        const containsOk = spec.contains === undefined || body.includes(spec.contains);
        const head = [
          `GET ${spec.url} → HTTP ${status} (expected ${spec.status})`,
          ...(spec.contains === undefined ? [] : [containsOk ? `body contains "${spec.contains}"` : `body does not contain "${spec.contains}"`]),
        ].join("; ");
        return statusOk && containsOk ? verdict("pass", head) : verdict("fail", withTail(head, body.slice(0, 500)));
      }),
      // The probe ran and the target did not answer: that is the check failing, not fleetd.
      Effect.catch((why) => Effect.succeed(verdict("fail", `GET ${spec.url} failed: ${why}`))),
    );

  /** PR numbers in `repo` that the workstream's tasks opened, newest first. */
  const workstreamPrs = (w: Workstream, repo: string) =>
    Effect.map(tasks.list({ ref: w.projectRef, workstreamId: w.workstreamId, limit: 50 }), (list) => {
      const numbers: Array<number> = [];
      for (const t of list) {
        const m = PULL_URL.exec(t.result?.prUrl ?? "");
        if (m !== null && m[1]!.toLowerCase() === repo.toLowerCase() && !numbers.includes(Number(m[2]))) numbers.push(Number(m[2]));
      }
      return numbers;
    });

  /** The commit CI is judged on: the merge commit of the workstream's newest merged PR, else the default branch's head. */
  const targetRef = (w: Workstream, repo: string) =>
    Effect.gen(function* () {
      const [newest] = yield* workstreamPrs(w, repo);
      if (newest !== undefined) {
        const pull = yield* api(Pull, `repos/${repo}/pulls/${newest}`);
        if (pull.merged && pull.merge_commit_sha !== null) return { ref: pull.merge_commit_sha, label: `merge commit ${short(pull.merge_commit_sha)} of #${newest}` };
      }
      const info = yield* api(RepoInfo, `repos/${repo}`);
      return { ref: info.default_branch, label: `the head of ${info.default_branch}` };
    });

  const checkRuns = (repo: string, ref: string, name?: string) =>
    api(
      CheckRuns,
      `repos/${repo}/commits/${encodeURIComponent(ref)}/check-runs?per_page=100${name === undefined ? "" : `&check_name=${encodeURIComponent(name)}`}`,
    ).pipe(Effect.map(({ check_runs }) => latestByName(check_runs)));

  const prMerged = (w: Workstream, spec: Extract<CheckSpec, { type: "pr_merged" }>) =>
    Effect.gen(function* () {
      const pr = spec.pr ?? (yield* workstreamPrs(w, spec.repo))[0];
      if (pr === undefined) {
        return verdict("error", `no PR to check: the check names none and no task of ${w.workstreamId} opened a PR in ${spec.repo}`);
      }
      const pull = yield* api(Pull, `repos/${spec.repo}/pulls/${pr}`);
      return pull.merged
        ? verdict("pass", `${spec.repo}#${pr} merged${pull.merged_at === null ? "" : ` at ${pull.merged_at}`}${pull.merge_commit_sha === null ? "" : ` as ${short(pull.merge_commit_sha)}`}`)
        : verdict("fail", `${spec.repo}#${pr} is ${pull.state}, not merged`);
    }).pipe(Effect.catchTag("GhError", (e) => Effect.succeed(ghError(e))));

  const ciGreen = (w: Workstream, spec: Extract<CheckSpec, { type: "ci_green" }>) =>
    Effect.gen(function* () {
      const target = spec.ref === undefined ? yield* targetRef(w, spec.repo) : { ref: spec.ref, label: spec.ref };
      const runs = yield* checkRuns(spec.repo, target.ref);
      if (runs.length === 0) return verdict("fail", `no check runs on ${target.label} in ${spec.repo}`);
      const red = runs.filter((run) => !isGreen(run));
      return red.length === 0
        ? verdict("pass", `${runs.length} check run${runs.length === 1 ? "" : "s"} on ${target.label} in ${spec.repo}, all green`)
        : verdict(
            "fail",
            `${red.length} of ${runs.length} check runs on ${target.label} in ${spec.repo} are not green: ${red.map((run) => `${run.name}: ${runState(run)}`).join(", ")}`.slice(0, EVIDENCE_MAX),
          );
    }).pipe(Effect.catchTag("GhError", (e) => Effect.succeed(ghError(e))));

  const test = (w: Workstream, spec: Extract<CheckSpec, { type: "test" }>) =>
    Effect.gen(function* () {
      const target = yield* targetRef(w, spec.repo);
      const [run] = yield* checkRuns(spec.repo, target.ref, spec.testId);
      if (run === undefined) return verdict("fail", `no check run named "${spec.testId}" on ${target.label} in ${spec.repo}`);
      const where = run.html_url ? ` (${run.html_url})` : "";
      return verdict(isGreen(run) ? "pass" : "fail", `"${spec.testId}" on ${target.label}: ${runState(run)}${where}`.slice(0, EVIDENCE_MAX));
    }).pipe(Effect.catchTag("GhError", (e) => Effect.succeed(ghError(e))));

  /** Waits for the human's answer to `askId`, read off the decision its answer records. */
  const answerTo = (cursor: number, askId: AskId) =>
    Effect.gen(function* () {
      let after = cursor;
      while (true) {
        const page = yield* events.wait({ cursor: after, types: ["decision.recorded"], timeoutSec: 3600 });
        after = page.cursor;
        if (!page.events.some((e) => (e.data as { readonly askId?: string } | undefined)?.askId === askId)) continue;
        const ask = yield* asks.get(askId);
        if (ask?.answer !== undefined) return ask.answer.value;
      }
    });

  const human = (ctx: CheckContext, index: number, spec: Extract<CheckSpec, { type: "human" }>) =>
    Effect.gen(function* () {
      const w = ctx.workstream;
      // One ask per claim, so an earlier answer never stands in for a fresh look.
      const key = DecisionKey.make(`${w.workstreamId.toLowerCase()}.${ctx.claimId.toLowerCase()}.done-${index}`);
      const cursor = yield* events.head();
      const filed = yield* Effect.result(
        asks.create(
          {
            projectRef: w.projectRef,
            workstreamId: w.workstreamId,
            kind: "do",
            key,
            class: "product",
            text: `Check done:${index} of ${w.workstreamId} (${w.title}): ${spec.question}`.slice(0, 500),
            steps: [{ text: spec.question, where: "browser", expect: `reply "done" when it holds; anything else fails the check` }],
            blocks: `${w.workstreamId} being marked done`,
            proceededOnRec: false,
          },
          CLAIMS_BY,
        ),
      );
      if (filed._tag === "Failure") return verdict("error", `could not ask the human: ${filed.failure.message}`);
      const { ask } = filed.success;
      const value = filed.success.state === "auto" ? (filed.success.decision?.value ?? "") : yield* answerTo(cursor, ask.askId);
      return value.trim().toLowerCase() === "done"
        ? verdict("pass", `the human answered done to ${ask.askId}`)
        : verdict("fail", `the human answered "${value}" to ${ask.askId}`.slice(0, EVIDENCE_MAX));
    });

  const run: CheckRunner["Service"]["run"] = (ctx, checkIndex, spec) =>
    Effect.gen(function* () {
      const w = ctx.workstream;
      const outcome: Verdict = yield* (() => {
        switch (spec.type) {
          case "cmd":
            return cmd(w, spec);
          case "http":
            return http(spec);
          case "pr_merged":
            return prMerged(w, spec);
          case "ci_green":
            return ciGreen(w, spec);
          case "test":
            return test(w, spec);
          case "judge":
            return judges.judge({ workstream: w, claimId: ctx.claimId, checkIndex, criteria: spec.criteria });
          case "human":
            return human(ctx, checkIndex, spec);
        }
      })();
      return {
        checkIndex,
        spec,
        result: outcome.result,
        evidence: outcome.evidence.slice(0, EVIDENCE_MAX),
        ...(outcome.exitCode === undefined ? {} : { exitCode: outcome.exitCode }),
        ranBy: ranByOf(spec),
        at: DateTime.formatIso(yield* DateTime.now),
      } satisfies CheckResult;
    });

  return CheckRunner.of({ run });
});

/** fetch() wraps the useful part ("ECONNREFUSED ...") in `cause`. */
const describeFetchError = (error: unknown) => {
  const inner = error instanceof Error && error.cause instanceof Error ? error.cause : error;
  return (inner instanceof Error ? inner.message : String(inner)).slice(0, 300);
};

/** Needs NodeCommands, GitHub, Judges, Asks, EventLog, HubStore and Tasks. */
export const layer = Layer.effect(CheckRunner, make);

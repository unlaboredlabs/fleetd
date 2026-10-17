// What the train asks of GitHub, through the `gh` CLI on the hub machine: PRs, check runs on a head, the
// `fleetd/train` commit status, the pinned squash merge, and recently merged PRs for bypass detection.
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { GH_AUTH_FIX, GhError, type GhRunner, ghRunner } from "../checks/GitHub.ts";

export const TRAIN_CONTEXT = "fleetd/train";

const PullJson = Schema.Struct({
  state: Schema.String,
  merged: Schema.Boolean,
  merge_commit_sha: Schema.NullOr(Schema.String),
  body: Schema.NullOr(Schema.String),
  head: Schema.Struct({ ref: Schema.String, sha: Schema.String, repo: Schema.NullOr(Schema.Struct({ full_name: Schema.String })) }),
  base: Schema.Struct({ ref: Schema.String }),
});
export type Pull = typeof PullJson.Type;

const CheckRunsJson = Schema.Struct({
  check_runs: Schema.Array(
    Schema.Struct({
      id: Schema.Number,
      name: Schema.String,
      status: Schema.String,
      conclusion: Schema.NullOr(Schema.String),
      html_url: Schema.NullOr(Schema.String),
    }),
  ),
});
export type CheckRun = (typeof CheckRunsJson.Type)["check_runs"][number];

const MergeJson = Schema.Struct({ sha: Schema.String, merged: Schema.Boolean });
const ClosedJson = Schema.Array(
  Schema.Struct({ number: Schema.Number, merged_at: Schema.NullOr(Schema.String), merge_commit_sha: Schema.NullOr(Schema.String) }),
);

export type MergeOutcome =
  | { readonly merged: true; readonly sha: string }
  /** GitHub said no: 405 (not mergeable, e.g. the base moved) or 409 (the head is no longer `sha`). */
  | { readonly merged: false; readonly status: number; readonly message: string };

export class TrainGitHub extends Context.Service<
  TrainGitHub,
  {
    readonly pull: (repo: string, prNumber: number) => Effect.Effect<Pull, GhError>;
    /** The latest run of each check on `sha`. */
    readonly checkRuns: (repo: string, sha: string) => Effect.Effect<ReadonlyArray<CheckRun>, GhError>;
    /** Posts `fleetd/train=success` on `sha`. */
    readonly postTrainStatus: (repo: string, sha: string, description: string) => Effect.Effect<void, GhError>;
    /** Squash-merges pinned to `sha`. */
    readonly merge: (repo: string, prNumber: number, sha: string) => Effect.Effect<MergeOutcome, GhError>;
    /** Recently updated closed PRs that were merged. */
    readonly mergedPulls: (repo: string) => Effect.Effect<ReadonlyArray<{ readonly number: number; readonly mergedAt: string; readonly mergeSha: string | null }>, GhError>;
  }
>()("fleetd/train/TrainGitHub") {}

const AUTH_HINT = /gh auth login|not logged in|authentication required/iu;

type Reply = { readonly ok: true; readonly json: unknown } | { readonly ok: false; readonly status: number; readonly message: string };

export const make = (run: GhRunner) => {
  /** `gh api`; a non-2xx answer is `{ status, message }` rather than an error, so callers can tell a 409 apart. */
  const call = (method: "GET" | "POST" | "PUT", path: string, fields: Record<string, string> = {}) =>
    run(["api", "-X", method, "-H", "Accept: application/vnd.github+json", path, ...Object.entries(fields).flatMap(([k, v]) => ["-f", `${k}=${v}`])]).pipe(
      Effect.mapError(({ spawnError }) =>
        new GhError(
          spawnError === "ENOENT"
            ? { kind: "missing", message: `gh is not installed on the hub machine: install the GitHub CLI, then ${GH_AUTH_FIX}` }
            : { kind: "failed", message: `gh could not start: ${spawnError}` },
        ),
      ),
      Effect.flatMap(({ exitCode, stdout, stderr }): Effect.Effect<Reply, GhError> => {
        if (exitCode === 4 || (exitCode !== 0 && AUTH_HINT.test(stderr))) {
          return Effect.fail(new GhError({ kind: "auth", message: `gh is not authenticated: ${GH_AUTH_FIX}` }));
        }
        if (exitCode === 0) {
          return Effect.try({
            try: (): Reply => ({ ok: true, json: JSON.parse(stdout === "" ? "null" : stdout) as unknown }),
            catch: () => new GhError({ kind: "failed", message: `gh api ${path} did not return JSON` }),
          });
        }
        const status = Number(/\(HTTP (\d{3})\)/u.exec(stderr)?.[1] ?? 0);
        const message = (stderr.trim().split("\n").at(-1) ?? `exit ${exitCode}`).replace(/^gh: /u, "").slice(0, 500);
        return Effect.succeed({ ok: false, status, message });
      }),
    );

  const json = <S extends Schema.Top & { readonly DecodingServices: never }>(schema: S, method: "GET" | "POST" | "PUT", path: string, fields?: Record<string, string>) =>
    Effect.flatMap(call(method, path, fields), (reply) =>
      reply.ok
        ? Effect.mapError(
            Schema.decodeUnknownEffect(schema)(reply.json),
            () => new GhError({ kind: "failed", message: `gh api ${path} returned an unexpected shape` }),
          )
        : Effect.fail(new GhError({ kind: "failed", message: `gh api ${path} failed: ${reply.message}` })),
    );

  return TrainGitHub.of({
    pull: (repo, n) => json(PullJson, "GET", `repos/${repo}/pulls/${n}`),
    checkRuns: (repo, sha) =>
      Effect.map(json(CheckRunsJson, "GET", `repos/${repo}/commits/${sha}/check-runs?per_page=100`), ({ check_runs }) => {
        // A re-run adds a newer run with the same name; only the newest counts.
        const latest = new Map<string, CheckRun>();
        for (const r of check_runs) if ((latest.get(r.name)?.id ?? -1) < r.id) latest.set(r.name, r);
        return [...latest.values()];
      }),
    postTrainStatus: (repo, sha, description) =>
      Effect.asVoid(json(Schema.Unknown, "POST", `repos/${repo}/statuses/${sha}`, { state: "success", context: TRAIN_CONTEXT, description: description.slice(0, 140) })),
    merge: (repo, n, sha) =>
      Effect.flatMap(call("PUT", `repos/${repo}/pulls/${n}/merge`, { merge_method: "squash", sha }), (reply): Effect.Effect<MergeOutcome, GhError> => {
        if (!reply.ok) {
          return reply.status === 405 || reply.status === 409
            ? Effect.succeed({ merged: false, status: reply.status, message: reply.message })
            : Effect.fail(new GhError({ kind: "failed", message: `merging ${repo}#${n} failed: ${reply.message}` }));
        }
        return Effect.mapBoth(Schema.decodeUnknownEffect(MergeJson)(reply.json), {
          onFailure: () => new GhError({ kind: "failed", message: `merging ${repo}#${n} returned an unexpected shape` }),
          onSuccess: (m): MergeOutcome => (m.merged ? { merged: true, sha: m.sha } : { merged: false, status: 405, message: "GitHub did not merge it" }),
        });
      }),
    mergedPulls: (repo) =>
      Effect.map(json(ClosedJson, "GET", `repos/${repo}/pulls?state=closed&sort=updated&direction=desc&per_page=50`), (pulls) =>
        pulls.flatMap((p) => (p.merged_at === null ? [] : [{ number: p.number, mergedAt: p.merged_at, mergeSha: p.merge_commit_sha }])),
      ),
  });
};

export const layer = (run: GhRunner = ghRunner) => Layer.succeed(TrainGitHub, make(run));

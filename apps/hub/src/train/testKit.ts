// Test kit for the train: the tasks kit (real store, leads, ledger, tasks under a TestClock) plus the train over
// real git in temp repos (a bare "origin", the project's checkout, an author's clone) run by local NodeCommands, and
// a fake `gh` that answers from that origin like GitHub would, with CI red iff the head has a file FAIL.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Change, WorkstreamId } from "@fleetd/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { NodeCommands } from "../checks/NodeCommands.ts";
import * as HubStore from "../store/HubStore.ts";
import { makeKit, REF } from "../tasks/testKit.ts";
import type { GhRunner } from "../checks/GitHub.ts";
import * as ChangeRecords from "./ChangeRecords.ts";
import { localCommands } from "./localCommands.ts";
import { ReviewGate } from "./ReviewGate.ts";
import * as Train from "./Train.ts";
import * as TrainGitHub from "./TrainGitHub.ts";

export { REF };
export const REPO = "wynn-dev/lab";

const GIT_ENV: NodeJS.ProcessEnv = {
  PATH: process.env.PATH,
  HOME: os.tmpdir(),
  LANG: "C",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "author",
  GIT_AUTHOR_EMAIL: "author@example.invalid",
  GIT_COMMITTER_NAME: "author",
  GIT_COMMITTER_EMAIL: "author@example.invalid",
};

const git = (cwd: string, ...argv: ReadonlyArray<string>) => execFileSync("git", argv, { cwd, env: GIT_ENV, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const tryGit = (cwd: string, ...argv: ReadonlyArray<string>) => {
  try {
    return git(cwd, ...argv);
  } catch {
    return undefined;
  }
};

interface FakePull {
  readonly number: number;
  readonly branch: string;
  body: string;
  state: "open" | "closed";
  merged: boolean;
  mergeSha: string | null;
  mergedAt: string | null;
}

type GhReply = { readonly exitCode: number; readonly stdout: string; readonly stderr: string };
const ok = (body: unknown): GhReply => ({ exitCode: 0, stdout: JSON.stringify(body), stderr: "" });
const httpError = (status: number, message: string): GhReply => ({ exitCode: 1, stdout: JSON.stringify({ message, status: String(status) }), stderr: `gh: ${message} (HTTP ${status})\n` });

export const makeTrainKit = () => {
  const tasksKit = makeKit();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleetd-train-"));
  const origin = path.join(dir, "origin.git");
  const author = path.join(dir, "author");
  const checkout = path.join(dir, "project");

  git(dir, "init", "-q", "--bare", "-b", "main", origin);
  git(dir, "clone", "-q", origin, author);
  fs.writeFileSync(path.join(author, "a.txt"), Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join("\n") + "\n");
  git(author, "add", "-A");
  git(author, "commit", "-q", "-m", "base");
  git(author, "push", "-q", "origin", "HEAD:main");
  git(dir, "clone", "-q", origin, checkout);

  const pulls = new Map<number, FakePull>();
  const statuses: Array<{ readonly sha: string; readonly context: string; readonly state: string }> = [];
  const merges: Array<{ readonly prNumber: number; readonly sha: string }> = [];
  /** Scripted answers to the next merge calls, before the fake merges for real. */
  const mergeReplies: Array<GhReply> = [];
  const reviewed: Array<Change> = [];

  const headOf = (branch: string) => git(origin, "rev-parse", `refs/heads/${branch}`);
  const pullJson = (p: FakePull) => {
    const head = tryGit(origin, "rev-parse", `refs/heads/${p.branch}`) ?? "0".repeat(40);
    return {
      number: p.number,
      state: p.state,
      merged: p.merged,
      merge_commit_sha: p.mergeSha,
      merged_at: p.mergedAt,
      body: p.body,
      head: { ref: p.branch, sha: head, repo: { full_name: REPO } },
      base: { ref: "main" },
    };
  };

  /** Squash onto main: main's head as parent, the PR head's tree. Refused like GitHub when the head or main moved. */
  const merge = (p: FakePull, sha: string): GhReply => {
    if (headOf(p.branch) !== sha) return httpError(409, "Head branch was modified. Review and try the merge again.");
    if (!statuses.some((s) => s.sha === sha && s.context === TrainGitHub.TRAIN_CONTEXT && s.state === "success")) {
      return httpError(405, "Required status check \"fleetd/train\" is expected.");
    }
    const main = headOf("main");
    if (git(origin, "merge-base", main, sha) !== main) return httpError(405, "Base branch was modified. Review and try the merge again.");
    const squash = git(origin, "commit-tree", `${sha}^{tree}`, "-p", main, "-m", `squash #${p.number}`);
    git(origin, "update-ref", "refs/heads/main", squash);
    p.merged = true;
    p.state = "closed";
    p.mergeSha = squash;
    p.mergedAt = "2026-10-17T12:00:00Z";
    merges.push({ prNumber: p.number, sha });
    return ok({ sha: squash, merged: true, message: "Pull Request successfully merged" });
  };

  const gh: GhRunner = (args) =>
    Effect.sync(() => {
      const method = args[args.indexOf("-X") + 1] ?? "GET";
      const target = args.find((a) => a.startsWith("repos/")) ?? "";
      const fields = Object.fromEntries(args.flatMap((a, i) => (args[i - 1] === "-f" ? [a.split(/=(.*)/su).slice(0, 2)] : [])));
      const [pathPart = "", query = ""] = target.split("?");
      const parts = pathPart.split("/").slice(3);
      const pull = (n: string | undefined) => pulls.get(Number(n));
      if (parts[0] === "pulls" && parts.length === 1 && query.includes("state=closed")) {
        return ok([...pulls.values()].filter((p) => p.state === "closed").map(pullJson));
      }
      if (parts[0] === "pulls" && parts.length === 2 && method === "GET") {
        const p = pull(parts[1]);
        return p === undefined ? httpError(404, "Not Found") : ok(pullJson(p));
      }
      if (parts[0] === "pulls" && parts[2] === "merge" && method === "PUT") {
        const scripted = mergeReplies.shift();
        if (scripted !== undefined) return scripted;
        const p = pull(parts[1]);
        return p === undefined ? httpError(404, "Not Found") : merge(p, fields.sha ?? "");
      }
      if (parts[0] === "commits" && parts[2] === "check-runs") {
        const sha = parts[1]!;
        const red = tryGit(origin, "cat-file", "-e", `${sha}:FAIL`) !== undefined;
        return ok({
          check_runs: [{ id: 1, name: "ci", status: "completed", conclusion: red ? "failure" : "success", html_url: `https://github.com/${REPO}/actions/runs/1` }],
        });
      }
      if (parts[0] === "statuses" && method === "POST") {
        statuses.push({ sha: parts[1]!, context: fields.context ?? "", state: fields.state ?? "" });
        return ok({ state: fields.state });
      }
      return httpError(404, "Not Found");
    });

  const gate = ReviewGate.of({
    review: (change) =>
      Effect.sync(() => {
        reviewed.push(change);
        return change.tier === "S" ? "ready" : "pending";
      }),
  });

  const layer = Train.layer({ autoRun: false, bypassEvery: 0, worktreeFor: () => path.join(dir, "train-wt") }).pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        ChangeRecords.layer,
        TrainGitHub.layer(gh),
        Layer.succeed(NodeCommands, localCommands(GIT_ENV)),
        Layer.succeed(ReviewGate, gate),
      ),
    ),
    Layer.provideMerge(tasksKit.layer),
  );

  /** The tasks kit's project (its checkout now a real clone) with its lead and running W1. */
  const setup = Effect.gen(function* () {
    const id = yield* tasksKit.setup;
    const store = yield* HubStore.HubStore;
    const project = (yield* store.projects.get(REF))!;
    yield* store.projects.upsertMany(REF.machineId, [{ ...project, workspaceRoot: checkout }]);
    return id as WorkstreamId;
  });

  /** Commits `files` (null deletes) on `branch` from `from` in the author's clone and pushes it. Returns the head. */
  const commit = (branch: string, files: Record<string, string | null>, from = `origin/${branch}`) => {
    git(author, "fetch", "-q", "origin");
    git(author, "checkout", "-q", "-B", branch, tryGit(author, "rev-parse", "--verify", from) === undefined ? "origin/main" : from);
    for (const [file, content] of Object.entries(files)) {
      if (content === null) fs.rmSync(path.join(author, file));
      else fs.writeFileSync(path.join(author, file), content);
    }
    git(author, "add", "-A");
    git(author, "commit", "-q", "-m", `change ${branch}`);
    git(author, "push", "-q", "--force", "origin", `HEAD:refs/heads/${branch}`);
    return headOf(branch);
  };

  /** A PR from `branch` (pushed with `files` on top of main) with `body`. */
  const openPr = (number: number, branch: string, files: Record<string, string | null>, body = "Source: done:0") => {
    commit(branch, files, "origin/main");
    pulls.set(number, { number, branch, body, state: "open", merged: false, mergeSha: null, mergedAt: null });
    return `https://github.com/${REPO}/pull/${number}`;
  };

  /** a.txt with line `n` (1-based) replaced. */
  const aWith = (edits: Record<number, string>) =>
    Array.from({ length: 10 }, (_, i) => edits[i + 1] ?? `line ${i + 1}`).join("\n") + "\n";

  return {
    tasksKit,
    layer,
    setup,
    pulls,
    statuses,
    merges,
    mergeReplies,
    reviewed,
    commit,
    openPr,
    aWith,
    headOf,
    /** main's file content on origin. */
    mainFile: (file: string) => tryGit(origin, "show", `main:${file}`),
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
};

export type TrainKit = ReturnType<typeof makeTrainKit>;

export const runTrainKit = <A, E>(kit: TrainKit, effect: Effect.Effect<A, E, Layer.Success<TrainKit["layer"]>>) =>
  Effect.runPromise(Effect.scoped(Effect.provide(effect, kit.layer))).finally(kit.cleanup);

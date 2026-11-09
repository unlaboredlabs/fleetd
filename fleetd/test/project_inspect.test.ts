// The pure side of adding a project (mod.rs tests, fleetd-contracts
// projects.rs `github_repo`): GitHub's answers into an inspect, the lead's line, the best worker, events that fit.
import { expect, test } from "bun:test";
import { failInterrupted, progressDue } from "../src/hub/projects/add.ts";
import {
  bestWorker,
  build,
  cloneProblem,
  compact,
  fitAdded,
  fitFailed,
  type GitHubAnswers,
  githubRepo,
  repoGate,
  repoKeyOf,
  size,
  type Worker,
} from "../src/hub/projects/inspect.ts";
import { events } from "../src/hub/store/events.ts";
import { kit } from "./work-kit.ts";

const repo = "acme/storefront";
const answers = (a: Partial<GitHubAnswers>): GitHubAnswers => ({ unread: [], ...a });

test("reads CI and merge rules from GitHub", () => {
  const i = build(
    repo,
    answers({
      repo: { default_branch: "main", allow_squash_merge: true },
      branch: { protected: true, protection: { required_status_checks: { contexts: ["build"] } } },
      rules: [
        {
          type: "required_status_checks",
          ruleset_id: 7,
          parameters: { strict_required_status_checks_policy: true, required_status_checks: [{ context: "test" }, { context: "build" }] },
        },
        { type: "pull_request", ruleset_id: 7, parameters: { required_approving_review_count: 0 } },
      ],
      rulesets: [{ id: 7, name: "main gate" }],
      workflows: {
        workflows: [
          { name: "CI", state: "active", path: ".github/workflows/ci.yml" },
          { name: "Old", state: "disabled_manually" },
          { name: "Copilot", state: "active", path: "dynamic/copilot-swe-agent/copilot" },
        ],
      },
    }),
    undefined,
    [],
    true,
  );
  expect(i.defaultBranch).toBe("main");
  expect(i.ci).toEqual({ workflows: ["CI"], requiredChecks: ["build", "test"] });
  expect(i.merge).toEqual({ protected: true, rulesets: ["main gate"], squashAllowed: true, requiredReviews: 0, strict: true });
  expect(i.notes).toEqual([]);
  expect(i.leadNeeds).toBe("ready: main requires build, test; the train waits for them before each squash merge");
});

test("failed reads are unknown, not absent", () => {
  const i = build(
    repo,
    answers({
      repo: { default_branch: "main", allow_squash_merge: true },
      branch: { protected: false },
      rules: [],
      unread: ["workflows (HTTP 403: API rate limit exceeded)"],
    }),
    undefined,
    [],
    true,
  );
  expect(i.leadNeeds).toBe(
    "CI and merge rules unknown: gh on the hub could not read workflows (HTTP 403: API rate limit exceeded) on acme/storefront",
  );
  expect(i.notes.some((n) => n.includes("rate limit"))).toBe(true);
  const whole = answers({ unread: ["acme/storefront (HTTP 502: Bad Gateway)"] });
  expect(build(repo, whole, undefined, [], true).leadNeeds.startsWith("CI and merge rules unknown")).toBe(true);
});

test("many checks are counted, and an event fits", () => {
  const checks = Array.from({ length: 40 }, (_, n) => ({ context: `test matrix job number ${n}` }));
  const gh = answers({
    repo: { default_branch: "master", allow_squash_merge: true },
    rules: [{ type: "required_status_checks", parameters: { required_status_checks: checks } }],
  });
  const i = build(repo, gh, undefined, [], true);
  expect(i.leadNeeds).toBe(
    "ready: master requires 40 checks (test matrix job number 0, test matrix job number 1, …); the train waits for them before each squash merge",
  );
  const small = compact(i, 1500);
  expect(size(small)).toBeLessThanOrEqual(1500);
  expect(small.ci.requiredChecks.length).toBeGreaterThan(0);
  expect(small.leadNeeds).toBe(i.leadNeeds);
  // The original is untouched.
  expect(i.ci.requiredChecks).toHaveLength(40);
});

test("says what the lead will need", () => {
  const bare = (gh: GitHubAnswers) => build(repo, gh, undefined, [], true);
  const none = answers({
    repo: { default_branch: "main", allow_squash_merge: true },
    branch: { protected: false },
    rules: [],
    rulesets: [],
    workflows: { workflows: [] },
  });
  expect(bare(none).leadNeeds).toBe("no CI found: the merge train holds its PRs until the repo has CI");
  expect(bare(answers({ repo: { default_branch: "main", allow_squash_merge: false } })).leadNeeds).toStartWith(
    "squash merges are off on acme/storefront",
  );
  const reviews = bare(
    answers({ repo: { default_branch: "trunk" }, rules: [{ type: "pull_request", parameters: { required_approving_review_count: 2 } }] }),
  );
  expect(reviews.leadNeeds).toStartWith("trunk needs 2 approving reviews");
  expect(reviews.notes.some((n) => n.includes("merge settings"))).toBe(true);
  const local = build(undefined, answers({}), { exists: true, isGit: true, defaultBranch: "main", workflowFiles: ["ci.yml"] }, [], true);
  expect(local.leadNeeds).toStartWith("no GitHub remote");
  expect(local.ci.workflows).toEqual(["ci.yml"]);
  expect(build(repo, answers({}), undefined, [], false).leadNeeds).toStartWith("gh is not logged in on the hub");
});

test("picks the least busy connected worker", () => {
  const w = (machineId: string, connected: boolean, ready: boolean, running: number, load?: number): Worker => ({
    machineId,
    connected,
    capable: true,
    ready,
    running,
    ...(load !== undefined ? { load } : {}),
  });
  expect(bestWorker([])).toBeUndefined();
  expect(bestWorker([w("devbox", false, true, 0)])).toBeUndefined();
  expect(bestWorker([w("devbox", true, true, 3, 0.1), w("buildbox", true, true, 1, 0.9)])).toBe("buildbox");
  expect(bestWorker([w("devbox", true, false, 0), w("buildbox", true, true, 4)])).toBe("buildbox");
  expect(bestWorker([w("devbox", true, true, 1, 0.5), w("buildbox", true, true, 1, 0.2)])).toBe("buildbox");
  // An old node is never picked, however idle.
  expect(bestWorker([{ ...w("buildbox", true, true, 0), capable: false }, w("devbox", true, true, 9)])).toBe("devbox");
});

test("project events always fit the log with their addId", () => {
  const long = `/home/me/${"é".repeat(490)}/storefront`;
  const checks = Array.from({ length: 60 }, (_, n) => ({ context: `a long required check name ${n}` }));
  const gh = answers({ repo: { default_branch: "main" }, rules: [{ type: "required_status_checks", parameters: { required_status_checks: checks } }] });
  const added = fitAdded({
    addId: "08028d03-66c3-4f57-c1f1-967e18cd24f4",
    title: "t".repeat(200),
    path: long,
    created: true,
    inspect: build(repo, gh, undefined, Array(5).fill("n".repeat(400)), true),
  });
  expect(size(added)).toBeLessThanOrEqual(2048);
  expect(JSON.stringify(added)).toContain("08028d03-66c3-4f57-c1f1-967e18cd24f4");
  expect(added.path.endsWith("/storefront")).toBe(true);
  expect(Buffer.byteLength(added.path)).toBeLessThanOrEqual(500);
  const failed = fitFailed({ addId: "a1", repo, path: long, problem: cloneProblem("x".repeat(2000), repo, "devbox", long) });
  const text = JSON.stringify(failed);
  expect(Buffer.byteLength(text)).toBeLessThanOrEqual(2048);
  expect(text).toContain('"addId":"a1"');
  expect(text).toContain("clone_failed");
});

test("an old node is never sent repo calls", () => {
  expect(repoGate("buildbox", true, false)?.code).toBe("node_too_old");
  expect(repoGate("buildbox", false, false)?.code).toBe("machine_offline");
  expect(repoGate("buildbox", true, true)).toBeUndefined();
});

test("a failed clone says how to fix it", () => {
  const p = cloneProblem("repository 'https://github.com/acme/storefront/' not found", repo, "devbox", "/x");
  expect(p.code).toBe("gh_no_access");
  expect(p.fix).toContain("gh auth login");
  expect(cloneProblem("could not read Username for 'https://github.com': terminal prompts disabled", repo, "devbox", "/x").code).toBe("gh_no_access");
  expect(cloneProblem("/home/me/src/storefront already exists", repo, "devbox", "/home/me/src/storefront").code).toBe("dest_exists");
  const eof = cloneProblem("early EOF", repo, "devbox", "/x");
  expect(eof.code).toBe("clone_failed");
  expect(eof.fix).toContain("git clone");
});

test("reads what people paste for a repo", () => {
  for (const text of [
    "https://github.com/acme/storefront",
    "https://github.com/acme/storefront.git",
    "https://github.com/acme/storefront/tree/main/src",
    "git@github.com:acme/storefront.git",
    "github.com/acme/storefront",
    "acme/storefront",
    " acme/storefront\n",
  ]) {
    expect(githubRepo(text)).toBe("acme/storefront");
  }
  for (const text of ["https://gitlab.com/acme/storefront", "storefront", "/home/me/src/storefront", "a/b/c"]) {
    expect(githubRepo(text)).toBeUndefined();
  }
  expect(repoKeyOf("git@github.com:Acme/Shop.git")).toBe("github.com/acme/shop");
  expect(repoKeyOf("https://github.com/acme/shop")).toBe("github.com/acme/shop");
  expect(repoKeyOf("")).toBeUndefined();
});

test("a clone cut off by a hub restart fails once", () => {
  const k = kit();
  const log = events(k.hub);
  const at = "2026-10-18T20:00:00.000Z";
  const progress = (addId: string) => ({
    at,
    type: "project.clone_progress" as const,
    machineId: "devbox",
    summary: "cloning",
    data: { addId, repo, path: "/home/me/src/storefront", phase: "receiving", percent: 40 },
  });
  log.append(progress("cut-off"));
  log.append(progress("finished"));
  log.append({ ...progress("finished"), type: "project.added", data: { addId: "finished" } });
  expect(failInterrupted(log, at)).toBe(1);
  const failed = log.page(0, ["project.add_failed"]).events;
  expect(failed).toHaveLength(1);
  expect(failed[0]?.data).toMatchObject({ addId: "cut-off", code: "clone_failed", message: "the hub restarted while cloning acme/storefront" });
  expect(failed[0]?.machineId).toBe("devbox");
  // The next start finds nothing open.
  expect(failInterrupted(log, at)).toBe(0);
});

test("progress events are throttled", () => {
  const t = 10_000;
  expect(progressDue(undefined, "receiving", 0, t)).toBe(true);
  expect(progressDue({ atMs: t, phase: "starting", percent: 0 }, "receiving", 1, t)).toBe(true);
  expect(progressDue({ atMs: t, phase: "receiving", percent: 10 }, "receiving", 20, t)).toBe(false);
  expect(progressDue({ atMs: t - 2000, phase: "receiving", percent: 10 }, "receiving", 12, t)).toBe(false);
  expect(progressDue({ atMs: t - 2000, phase: "receiving", percent: 10 }, "receiving", 15, t)).toBe(true);
  expect(progressDue({ atMs: t, phase: "receiving", percent: 90 }, "receiving", 100, t)).toBe(true);
});

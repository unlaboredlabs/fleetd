// The landing scanner against real git (crates/fleetd/src/hub/work/landings_tests.rs and landings.rs' own tests): an
// origin, a person's clone of it, and checkouts for projects under $TMPDIR, with every commit dated from the hub's clock.
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { leadWakes, type Trigger } from "../src/hub/api/leads.ts";
import type { Hub } from "../src/hub/api/hub.ts";
import { events } from "../src/hub/store/events.ts";
import { TaskRecords } from "../src/hub/tasks/records.ts";
import { changeRecords } from "../src/hub/train/index.ts";
import type { MergedPull } from "../src/hub/train/github.ts";
import { remoteHead } from "../src/hub/work/bind.ts";
import { type NewClaim, OUTAGE_GAP_MS, work } from "../src/hub/work/index.ts";
import {
  closes,
  cutLines,
  issueRefs,
  type LandingPorts,
  landingStore,
  lsRemoteSha,
  originOf,
  parseCommit,
  pathMatches,
  prNumberIn,
  prUrl,
  scan,
  stronglyMatches,
  wakeLine,
  words,
} from "../src/hub/work/landings.ts";
import { repoKeyOf } from "../src/hub/work/repo_key.ts";
import type { WorkScope } from "../src/hub/work/store.ts";
import type { Change, ProjectRef, Task, WorkKey } from "../src/shared/contracts.ts";
import { tempHome } from "./helpers.ts";
import { kit, project as addProject } from "./work-kit.ts";

const START_MS = 1_792_922_400_000;
const GITLAB = "git@gitlab.example.com:acme/shop.git";
const GITHUB = "https://github.com/acme/shop.git";
const AT = "2026-10-25T10:00:00.000Z";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const done of cleanups.splice(0)) done();
});

/** Real git in each checkout; offline machines answer nothing, and machines without a network fail ls-remote and fetch. */
class LocalGit implements LandingPorts {
  offline = new Set<string>();
  noNetwork = new Set<string>();
  pulls: MergedPull[] = [];
  commitPulls = new Map<string, MergedPull[]>();

  async git(machine: string, cwd: string, args: string[]) {
    if (this.offline.has(machine)) return undefined;
    if (this.noNetwork.has(machine) && (args[0] === "ls-remote" || args[0] === "fetch")) {
      return { code: 128, out: "fatal: unable to access 'https://github.com/acme/shop.git/': Could not resolve host: github.com" };
    }
    const out = Bun.spawnSync(["git", ...args], { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
    const text = out.stdout.toString() + out.stderr.toString();
    return { code: out.exitCode, out: text.length > 2000 ? text.slice(-2000) : text };
  }

  async mergedPulls() {
    return [...this.pulls];
  }

  async mergedPullsOf(_repo: string, sha: string) {
    return this.commitPulls.get(sha) ?? [];
  }
}

const pull = (number: number, sha: string, head: string): MergedPull => ({ number, mergedAt: AT, mergeSha: sha, base: "main", head });

/** An origin, a person's clone of it, and checkouts for projects, with every commit dated from the hub's clock. */
class Repo {
  private readonly dir: string;
  private commits = 0;

  constructor(readonly remote: string) {
    const home = tempHome();
    cleanups.push(home.done);
    this.dir = home.dir;
    mkdirSync(this.origin(), { recursive: true });
    this.run(this.origin(), ["init", "-q", "--bare", "-b", "main"]);
    this.run(this.dir, ["clone", "-q", this.origin(), this.human()]);
    this.run(this.human(), ["checkout", "-q", "-b", "main"]);
    this.commit("ada@example.com", "init", [["README.md", "shop\n"]]);
    this.run(this.human(), ["push", "-q", "origin", "main"]);
  }

  path = (name: string) => join(this.dir, name);
  origin = () => this.path("origin.git");
  human = () => this.path("human");

  run(cwd: string, args: string[], email = "t@example.com"): string {
    this.commits++;
    // The repo's first commits are older than the hub's clock, so older than any watch.
    const date = `@${START_MS / 1000 - 600 + this.commits * 60} +0000`;
    const env: Record<string, string> = { ...(process.env as Record<string, string>), GIT_COMMITTER_EMAIL: email, GIT_COMMITTER_DATE: date };
    delete env.GIT_AUTHOR_NAME;
    delete env.GIT_AUTHOR_EMAIL;
    delete env.GIT_AUTHOR_DATE;
    // A cherry-pick keeps the commit's own author, as a rebase does.
    if (args[0] !== "cherry-pick") Object.assign(env, { GIT_AUTHOR_EMAIL: email, GIT_AUTHOR_DATE: date });
    const out = Bun.spawnSync(["git", "-c", "commit.gpgsign=false", "-c", "user.name=t", "-c", `user.email=${email}`, ...args], { cwd, env });
    if (out.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${out.stderr.toString()}`);
    return out.stdout.toString().trim();
  }

  /** A project's checkout whose origin is `this.remote`, which git rewrites to the local origin. */
  checkout(name: string): string {
    const root = this.path(name);
    this.run(this.dir, ["clone", "-q", this.origin(), root]);
    this.run(root, ["config", "remote.origin.url", this.remote]);
    this.run(root, ["config", `url.${this.origin()}.insteadOf`, this.remote]);
    return root;
  }

  /** Commits the files on the person's current branch; returns its sha. */
  commit(email: string, message: string, files: [string, string][]): string {
    for (const [p, text] of files) {
      const file = join(this.human(), p);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, text);
    }
    this.run(this.human(), ["add", "-A"], email);
    this.run(this.human(), ["commit", "-q", "--allow-empty", "-m", message], email);
    return this.head();
  }

  head = () => this.run(this.human(), ["rev-parse", "HEAD"]);
  push = () => this.run(this.human(), ["push", "-q", "-f", "origin", "main"]);
  git = (args: string[]) => this.run(this.human(), args, "ada@example.com");
}

function rig() {
  const k = kit(START_MS);
  const woken: ProjectRef[] = [];
  leadWakes(k.hub).trigger = (r: ProjectRef, _t: Trigger) => void woken.push(r);
  const pending = (r: ProjectRef) => woken.some((w) => w.machineId === r.machineId && w.projectId === r.projectId);
  return { ...k, woken, pending };
}

const project = (hub: Hub, machineId: string, projectId: string, root: string, at = AT): ProjectRef => {
  addProject(hub, { machineId, projectId }, { workspaceRoot: root, lastActivityAt: at });
  return { machineId, projectId };
};

const scope = (remote: string): WorkScope => ({ repoKey: repoKeyOf(remote)!, base: "main" });

function claim(hub: Hub, s: WorkScope, title: string, email: string, keys: WorkKey[] = [], branch?: string): string {
  const input: NewClaim = {
    scope: s,
    owner: { kind: "human_session", keyId: "k7", label: "laptop" },
    title,
    keys,
    ...(branch !== undefined ? { branch } : {}),
    paths: ["app/theme.ts"],
    authorEmail: email,
  };
  return work(hub).claim(input).claimId;
}

const state = (hub: Hub, id: string) => work(hub).get(id)!.state;
const landings = (hub: Hub, s: WorkScope) => work(hub).landings(s, 0, 100).reverse();

function task(hub: Hub, r: ProjectRef, branch: string): Task {
  return TaskRecords.create(hub.db.conn, {
    taskId: "T1",
    projectRef: r,
    workstreamId: "W1",
    title: "checkout totals",
    kind: "write",
    prompt: "do it",
    state: "running",
    attempt: 1,
    createdAt: AT,
    branch,
  } as Task);
}

function change(hub: Hub, r: ProjectRef, pr: number, state: string, merged?: string): Change {
  return changeRecords(hub).create({
    changeId: "X1",
    projectRef: r,
    repo: "acme/shop",
    prNumber: pr,
    prUrl: `https://github.com/acme/shop/pull/${pr}`,
    branch: `fleetd/T9-pr-${pr}`,
    workstreamId: "W1",
    headSha: "0123456789abcdef0123456789abcdef01234567",
    state,
    ...(merged !== undefined ? { mergedSha: merged } : {}),
    reviews: [],
    createdAt: AT,
    updatedAt: AT,
  } as unknown as Change);
}

test("a direct push on a GitLab repo is recorded and ends its author's claim", async () => {
  const { hub, pending } = rig();
  const repo = new Repo(GITLAB);
  const shop = project(hub, "devbox", "shop", repo.checkout("shop"));
  const git = new LocalGit();
  const s = scope(GITLAB);
  // The first scan records the project's repo and base, and starts the watch: what was there is not a landing.
  await scan(hub, git);
  expect(work(hub).scopeOf(shop)).toEqual(s);
  expect(work(hub).watch(s)?.lastSha).toBe(repo.head());
  expect(landings(hub, s)).toEqual([]);
  const mine = claim(hub, s, "dark mode toggle in settings", "ada@example.com");
  const theirs = claim(hub, s, "dark mode toggle in settings", "sam@example.com");
  const unrelated = claim(hub, s, "checkout totals", "ada@example.com");
  const sha = repo.commit("Ada@Example.com", "feat(app): dark mode toggle for settings", [["app/theme.ts", "dark\n"]]);
  repo.push();
  await scan(hub, git);
  const all = landings(hub, s);
  expect(all.length).toBe(1);
  const landing = all[0]!;
  expect([landing.sha, landing.route, landing.prNumber, landing.authorEmail, landing.paths, landing.claimIds]).toEqual([
    sha,
    "direct_push",
    undefined,
    "Ada@Example.com",
    ["app/theme.ts"],
    [mine],
  ]);
  const ended = work(hub).get(mine)!;
  expect([ended.state, ended.end?.landing, state(hub, theirs), state(hub, unrelated)]).toEqual(["landed", sha, "active", "active"]);
  const landed = (await events(hub).wait({ cursor: 0, types: ["work.landed"], timeoutSec: 0 })).events.map((e) => e.data);
  expect(landed).toEqual([
    { repoKey: "gitlab.example.com/acme/shop", base: "main", sha, route: "direct_push", subject: "feat(app): dark mode toggle for settings", claimIds: [mine] },
  ]);
  expect(pending(shop)).toBe(true);
  expect(wakeLine(landing)).toBe(`${sha.slice(0, 7)} "feat(app): dark mode toggle for settings" was pushed straight to main by Ada@Example.com; it ended claim ${mine}.`);
  expect(landingStore(hub.db.conn).outside(s, 0, 5).map((l) => l.covers)).toEqual([[mine]]);
  await scan(hub, git);
  expect(landings(hub, s).length).toBe(1);
});

test("a GitLab merge request merged outside the train ends the claims on its branch, MR and closed issues", async () => {
  const { hub } = rig();
  const repo = new Repo(GITLAB);
  project(hub, "devbox", "shop", repo.checkout("shop"));
  const git = new LocalGit();
  const s = scope(GITLAB);
  await scan(hub, git);
  const onBranch = claim(hub, s, "dark mode", "sam@example.com", [], "ada/dark-mode");
  const onMr = claim(hub, s, "something else", "sam@example.com", [{ pr: "https://gitlab.example.com/acme/shop/-/merge_requests/12" }]);
  const onIssue = claim(hub, s, "another thing", "sam@example.com", [{ issue: "SHOP-7" }]);
  const otherMr = claim(hub, s, "other", "sam@example.com", [{ pr: "https://gitlab.example.com/acme/shop/-/merge_requests/13" }]);
  const issue = (key: string) => claim(hub, s, "an issue", "sam@example.com", [{ issue: key }]);
  const mentioned = issue("#3");
  const sameRepoUrl = issue("https://gitlab.example.com/acme/shop/-/issues/8");
  const otherRepoUrl = issue("https://gitlab.example.com/acme/other/-/issues/9");
  repo.git(["checkout", "-q", "-b", "ada/dark-mode"]);
  repo.commit("ada@example.com", "dark mode toggle", [["app/theme.ts", "dark\n"]]);
  repo.git(["checkout", "-q", "main"]);
  repo.git([
    "merge",
    "-q",
    "--no-ff",
    "ada/dark-mode",
    "-m",
    "Merge branch 'ada/dark-mode' into 'main'",
    "-m",
    "dark mode toggle, a follow-up to #3\n\nCloses SHOP-7\nFixes #8\nFixes https://gitlab.example.com/acme/other/-/issues/9\n\nSee merge request acme/shop!12",
  ]);
  const merge = repo.head();
  repo.push();
  await scan(hub, git);
  const all = landings(hub, s);
  expect(all.length).toBe(1);
  const l = all[0]!;
  expect([l.sha, l.route, l.prNumber, l.prUrl, l.headBranch, l.paths]).toEqual([
    merge,
    "pr_outside",
    12,
    "https://gitlab.example.com/acme/shop/-/merge_requests/12",
    "ada/dark-mode",
    ["app/theme.ts"],
  ]);
  for (const id of [onBranch, onMr, onIssue, sameRepoUrl]) expect([id, state(hub, id)]).toEqual([id, "landed"]);
  for (const id of [otherMr, mentioned, otherRepoUrl]) expect([id, state(hub, id)]).toEqual([id, "active"]);
  expect(work(hub).get(onBranch)!.end?.reason).toBe(`${merge.slice(0, 7)} landed on main: branch ada/dark-mode`);
});

test("a GitHub squash merge takes its branch from GitHub and links the task", async () => {
  const { hub } = rig();
  const repo = new Repo(GITHUB);
  const shop = project(hub, "devbox", "shop", repo.checkout("shop"));
  const git = new LocalGit();
  const s = scope(GITHUB);
  await scan(hub, git);
  const t = task(hub, shop, "fleetd/T1-checkout-totals");
  const held = claim(hub, s, "totals", "sam@example.com", [], "fleetd/T1-checkout-totals");
  const sha = repo.commit("ada@example.com", "feat: checkout totals (#58)", [["app/cart.ts", "1\n"]]);
  repo.push();
  git.pulls.push({ ...pull(58, sha.toUpperCase(), "fleetd/T1-checkout-totals") });
  await scan(hub, git);
  const l = landings(hub, s)[0]!;
  expect([l.route, l.prUrl, l.headBranch, l.taskId, state(hub, held)]).toEqual([
    "pr_outside",
    "https://github.com/acme/shop/pull/58",
    "fleetd/T1-checkout-totals",
    t.taskId,
    "landed",
  ]);
  expect(wakeLine(l).endsWith(`; it ended claim ${held}; it is ${t.taskId}'s work.`)).toBe(true);
  const rebased = repo.commit("ada@example.com", "checkout rounding", [["app/cart.ts", "2\n"]]);
  repo.push();
  git.pulls.push(pull(59, rebased, "ada/rounding"));
  await scan(hub, git);
  const second = landings(hub, s)[1]!;
  expect([second.route, second.prNumber]).toEqual(["pr_outside", 59]);
});

test("the train's own merge is a train landing and wakes no one; a commit waits while the train merges", async () => {
  const { hub, clock, pending } = rig();
  const repo = new Repo(GITHUB);
  const shop = project(hub, "devbox", "shop", repo.checkout("shop"));
  const git = new LocalGit();
  const s = scope(GITHUB);
  await scan(hub, git);
  const sha = repo.commit("bot@example.com", "feat: docs page (#7)", [["docs.md", "d\n"]]);
  repo.push();
  const merged = change(hub, shop, 7, "merged", sha);
  await scan(hub, git);
  const l = landings(hub, s)[0]!;
  expect([l.route, l.changeId, pending(shop)]).toEqual(["train", merged.changeId, false]);
  change(hub, shop, 8, "merging");
  const pushed = repo.commit("ada@example.com", "fix: typo", [["docs.md", "e\n"]]);
  repo.push();
  await scan(hub, git);
  expect(landings(hub, s).length).toBe(1);
  clock.ms += 11 * 60_000;
  await scan(hub, git);
  const next = landings(hub, s)[1]!;
  expect([next.sha, next.route]).toEqual([pushed, "direct_push"]);
});

test("every commit of a GitHub rebase merge is its PR's", async () => {
  const { hub, pending } = rig();
  const repo = new Repo(GITHUB);
  const shop = project(hub, "devbox", "shop", repo.checkout("shop"));
  const git = new LocalGit();
  const s = scope(GITHUB);
  await scan(hub, git);
  const first = repo.commit("ada@example.com", "rounding: helper", [["app/round.ts", "1\n"]]);
  const last = repo.commit("ada@example.com", "rounding: use it", [["app/cart.ts", "1\n"]]);
  const pushed = repo.commit("sam@example.com", "docs: typo", [["README.md", "shop!\n"]]);
  repo.push();
  git.pulls.push(pull(60, last, "ada/rounding"));
  git.commitPulls.set(first, [pull(60, last, "ada/rounding")]);
  await scan(hub, git);
  expect(landings(hub, s).map((l) => [l.sha, l.route, l.prNumber, l.headBranch])).toEqual([
    [first, "pr_outside", 60, "ada/rounding"],
    [last, "pr_outside", 60, "ada/rounding"],
    [pushed, "direct_push", undefined, undefined],
  ]);
  expect(pending(shop)).toBe(true);
});

test("a remote git can't reach is told to the lead once per outage", async () => {
  const { hub, clock, pending } = rig();
  const repo = new Repo(GITLAB);
  const root = repo.checkout("shop");
  const shop = project(hub, "devbox", "shop", root);
  const git = new LocalGit();
  const gone = repo.path("gone.git");
  repo.run(root, ["config", "--unset-all", `url.${repo.origin()}.insteadOf`]);
  repo.run(root, ["config", `url.${gone}.insteadOf`, GITLAB]);
  await scan(hub, git);
  expect(work(hub).scopeOf(shop)).toEqual(scope(GITLAB));
  const why = work(hub).scanFailure(shop)!;
  expect(why).toContain("gone.git");
  expect(pending(shop)).toBe(true);
  await scan(hub, git);
  expect(work(hub).scanFailed(shop, why)).toBe(false);
  repo.run(root, ["config", "--unset-all", `url.${gone}.insteadOf`]);
  repo.run(root, ["config", `url.${repo.origin()}.insteadOf`, GITLAB]);
  await scan(hub, git);
  expect(work(hub).watches(scope(GITLAB))).toBe(true);
  await scan(hub, git);
  expect(work(hub).scanFailure(shop)).toBeUndefined();
  expect(work(hub).scanFailed(shop, why)).toBe(false);
  expect(work(hub).scanFailure(shop)).toBe(why);
  clock.ms += OUTAGE_GAP_MS;
  expect(work(hub).scanFailed(shop, why)).toBe(true);
});

test("an offline node makes the watch wait, and another checkout of the repo reads it", async () => {
  const { hub } = rig();
  const repo = new Repo(GITLAB);
  project(hub, "devbox", "shop", repo.checkout("shop"));
  const git = new LocalGit();
  const s = scope(GITLAB);
  await scan(hub, git);
  git.offline.add("devbox");
  const first = repo.commit("ada@example.com", "one", [["a.txt", "1\n"]]);
  repo.push();
  await scan(hub, git);
  expect(landings(hub, s)).toEqual([]);
  const laptop = project(hub, "laptop", "shop", repo.checkout("laptop-shop"));
  const second = repo.commit("ada@example.com", "two", [["a.txt", "2\n"]]);
  repo.push();
  await scan(hub, git);
  expect(work(hub).scopeOf(laptop)).toEqual(s);
  expect(landings(hub, s).map((l) => l.sha)).toEqual([first, second]);
});

test("a base far behind is read from the node's output tail, and a force push reports only new commits", async () => {
  const { hub } = rig();
  const repo = new Repo(GITLAB);
  project(hub, "devbox", "shop", repo.checkout("shop"));
  const git = new LocalGit();
  const s = scope(GITLAB);
  await scan(hub, git);
  const before = repo.head();
  const pushed: string[] = [];
  for (let n = 0; n < 60; n++) pushed.push(repo.commit("ada@example.com", `step ${n}`, [["a.txt", `${n}\n`]]));
  repo.push();
  await scan(hub, git);
  expect(landings(hub, s).map((l) => l.sha)).toEqual(pushed);
  repo.git(["reset", "-q", "--hard", pushed[57]!]);
  repo.git(["cherry-pick", pushed[58]!, pushed[59]!]);
  expect(repo.head()).not.toBe(pushed[59]);
  const redo = repo.commit("ada@example.com", "redo", [["b.txt", "b\n"]]);
  repo.push();
  await scan(hub, git);
  const all = landings(hub, s);
  expect([all.length, all[60]?.sha, work(hub).watch(s)?.lastSha]).toEqual([61, redo, redo]);
  repo.git(["reset", "-q", "--hard", before]);
  const again = repo.commit("ada@example.com", "again", [["c.txt", "c\n"]]);
  repo.push();
  await scan(hub, git);
  const after = landings(hub, s);
  expect([after.length, after[61]?.sha]).toEqual([62, again]);
}, 60_000);

test("agents hear once when their machine can't reach GitHub, and once when it can", async () => {
  const { hub } = rig();
  const repo = new Repo(GITHUB);
  project(hub, "devbox", "shop", repo.checkout("shop"));
  const git = new LocalGit();
  const told: [string, boolean][] = [];
  work(hub).onGithubReach = async (m, reached) => void told.push([m, reached]);
  await scan(hub, git);
  git.noNetwork.add("devbox");
  await scan(hub, git);
  await scan(hub, git);
  git.noNetwork.delete("devbox");
  await scan(hub, git);
  await scan(hub, git);
  expect(told).toEqual([
    ["devbox", false],
    ["devbox", true],
  ]);
});

test("each host's default merge message names its PR and branch", () => {
  const cases: [string, string, ReturnType<typeof originOf>][] = [
    ["Merge pull request #57 from acme/ada/dark-mode", "dark mode", { pr: 57, head: "ada/dark-mode", host: "github" }],
    ["feat: dark mode toggle (#58)", "* first\n* second", { pr: 58, host: "github" }],
    ["Merge pull request 'dark mode' (#9) from dark-mode into main", "", { pr: 9, head: "dark-mode", host: "github" }],
    ["Merge branch 'dark-mode' into 'main'", "dark mode toggle\n\nSee merge request acme/shop!12", { pr: 12, head: "dark-mode", host: "gitlab" }],
    ["Merged in ada/dark-mode (pull request #4)", "dark mode", { pr: 4, head: "ada/dark-mode", host: "bitbucket" }],
    ["Merged PR 31: dark mode toggle", "", { pr: 31, host: "azure" }],
    ["Merge branch 'dark-mode'", "", { head: "dark-mode" }],
    ["Merge remote-tracking branch 'origin/dark-mode'", "", { head: "dark-mode" }],
    ["feat: dark mode toggle, closes #12", "", {}],
  ];
  for (const [subject, body, want] of cases) expect([subject, originOf(subject, body)]).toEqual([subject, want]);
});

test("a PR URL is built only where the host is known", () => {
  expect(prUrl("github.com/acme/shop", "github", 7)).toBe("https://github.com/acme/shop/pull/7");
  expect(prUrl("gitlab.example.com/acme/shop", "gitlab", 7)).toBe("https://gitlab.example.com/acme/shop/-/merge_requests/7");
  expect(prUrl("bitbucket.org/acme/shop", "bitbucket", 7)).toBe("https://bitbucket.org/acme/shop/pull-requests/7");
  expect(prUrl("git.example.com/acme/shop", "github", 7)).toBeUndefined();
  expect(prUrl("/srv/git/shop", "gitlab", 7)).toBeUndefined();
  expect(prNumberIn("https://gitlab.example.com/acme/shop/-/merge_requests/12", "gitlab.example.com/acme/shop")).toBe(12);
  expect(prNumberIn("https://github.com/acme/shop/pull/12/files", "github.com/acme/shop")).toBe(12);
  expect(prNumberIn("https://github.com/acme/other/pull/12", "github.com/acme/shop")).toBeUndefined();
});

test("only a closing reference on the same repo closes an issue", () => {
  expect(closes("fix: checkout total\n\nCloses SHOP-12", "SHOP-12")).toBe(true);
  expect(closes("fix: checkout total, fixes #12", "#12")).toBe(true);
  expect(closes("Resolves: #12.", "#12")).toBe(true);
  expect(closes("fix: follow-up to #12", "#12")).toBe(false);
  expect(closes("fix: checkout total (SHOP-12)", "SHOP-12")).toBe(false);
  expect(closes("fix: checkout total, closes #123", "#12")).toBe(false);
  expect(closes("closes BIGSHOP-12", "SHOP-12")).toBe(false);
  expect(issueRefs("https://github.com/acme/shop/issues/12", "github.com/acme/shop")).toEqual(["https://github.com/acme/shop/issues/12", "#12"]);
  expect(issueRefs("https://gitlab.example.com/acme/shop/-/issues/8", "gitlab.example.com/acme/shop")).toEqual([
    "https://gitlab.example.com/acme/shop/-/issues/8",
    "#8",
  ]);
  expect(issueRefs("https://github.com/acme/other/issues/12", "github.com/acme/shop")).toEqual([]);
});

test("a strong match shares most title words, or some and a file; globs match paths", () => {
  expect(stronglyMatches("dark mode toggle in settings", "feat(app): dark mode toggle for settings", false)).toBe(true);
  expect(stronglyMatches("dark mode toggle", "fix: dark mode contrast", false)).toBe(false);
  expect(stronglyMatches("dark mode toggle", "fix: dark mode contrast", true)).toBe(true);
  expect(stronglyMatches("dark mode toggle", "feat: checkout totals", true)).toBe(false);
  expect(words("fix(hub): add the dark-mode toggle (#58)")).toEqual(["hub", "dark", "mode", "toggle"]);
  expect(pathMatches("app/settings/**", "app/settings/theme/dark.ts")).toBe(true);
  expect(pathMatches("app/*.ts", "app/theme.ts")).toBe(true);
  expect(pathMatches("app/*.ts", "app/theme.tsx")).toBe(false);
  expect(pathMatches("app/theme.ts", "app/theme.ts")).toBe(true);
  expect(pathMatches("app/settings/**", "app/settingsx/a.ts")).toBe(false);
});

test("a commit is read whole even when the node kept only its tail", () => {
  const out =
    "…of a long body\nSee merge request acme/shop!12\n\u001e0123456789abcdef0123456789abcdef01234567\u001f1792922400\u001fada@example.com\u001faaa bbb\u001f1792922000\u001fMerge branch 'x' into 'main'\n";
  const commit = parseCommit(out)!;
  expect([commit.sha, commit.atSecs, commit.parents, commit.authoredSecs, commit.subject]).toEqual([
    "0123456789abcdef0123456789abcdef01234567",
    1_792_922_400,
    ["aaa", "bbb"],
    1_792_922_000,
    "Merge branch 'x' into 'main'",
  ]);
  expect(commit.body.endsWith("acme/shop!12\n")).toBe(true);
  const long = `cut-line\n${"a/b.ts\n".repeat(400)}`;
  expect(cutLines(long.slice(-2000)).every((l) => l === "a/b.ts")).toBe(true);
  expect(lsRemoteSha("0123456789ABCDEF0123456789abcdef01234567\trefs/heads/main\n", "refs/heads/main")).toBe("0123456789abcdef0123456789abcdef01234567");
  expect(remoteHead("ref: refs/heads/trunk\tHEAD\nabc\tHEAD\n")).toBe("trunk");
});

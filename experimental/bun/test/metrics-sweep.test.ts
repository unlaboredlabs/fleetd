// The host sweep over the Rust tree's recorded GitHub answers (crates/fleetd/src/hub/metrics/fixtures/github), no
// network (sweep_tests.rs): a first read's 90-day backfill and routes (bots, batches, other bases, merge-backs,
// direct pushes), the person's reviews and comments, the train's events agreeing with it, a failing host, when a repo
// is read, and a repo read from git alone.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { GitHubSource } from "../src/hub/metrics/github.ts";
import * as human from "../src/hub/metrics/human.ts";
import type { HostAct } from "../src/hub/metrics/host_acts.ts";
import { changeTrailer, type GitLog, isSync, rows as gitRows, subjectPr, subjectTask } from "../src/hub/metrics/no_host.ts";
import type { LandedCommit } from "../src/hub/metrics/source.ts";
import * as sweep from "../src/hub/metrics/sweep.ts";
import * as store from "../src/hub/metrics/store.ts";
import { kindCode } from "../src/hub/time/kinds.ts";
import { isoMs } from "../src/hub/store/time.ts";
import type { GhOut, GhRunner } from "../src/hub/train/gh.ts";
import type { GitCommit } from "../src/shared/sessions.ts";
import { admin, change, DAY, event, get, type H, HOUR, hub, ms, NOW, orders, projectFrom, REPO, rows, sql } from "./metrics-kit.ts";

const FIXTURES = join(import.meta.dir, "../../../crates/fleetd/src/hub/metrics/fixtures/github");
const fixture = (name: string) => readFileSync(join(FIXTURES, name), "utf8");

/** `gh` answering from the recorded responses, or signed out. */
class Recorded implements GhRunner {
  signedOut = false;
  /** The default branch has moved on with a commit made before the first read. */
  latePush = false;
  readonly calls: string[][] = [];

  async run(args: string[]): Promise<GhOut> {
    const joined = args.join(" ");
    this.calls.push(args);
    if (this.signedOut) return { exitCode: 4, stdout: "", stderr: "To get started with GitHub CLI, please run:  gh auth login" };
    let body: string;
    if (args[1] === "repos/acme/web") body = fixture("repo.json");
    else if (args[1] === "user") body = fixture("user.json");
    else if (joined.includes("history(")) body = fixture(this.latePush ? "commits-late.json" : "commits.json");
    else if (joined.includes("reviews(last")) body = fixture("acts.json");
    else if (joined.includes("states: MERGED") && joined.includes(" after=")) body = fixture("merged-2.json");
    else if (joined.includes("states: MERGED")) body = fixture("merged-1.json");
    else throw new Error(`no recorded answer for gh ${joined}`);
    return { exitCode: 0, stdout: body, stderr: "" };
  }

  runs = () => this.calls.map((a) => a.join(" "));
  mergedPages = () => this.runs().filter((r) => r.includes("states: MERGED")).length;
}

/** acme/web checked out as devbox/web; X45 landed in a batch, X50 on its own, both through the train; T7 wrote #43. */
function checkout(h: H) {
  orders(h);
  change(h, 45, 45, "W1", "T45", "merged", "2026-10-21T08:00:00.000Z");
  change(h, 50, 50, "W1", "T50", "merged", "2026-10-23T08:00:00.000Z");
  sql(h, "INSERT INTO metric_project_repos (machine_id, project_id, repo, checked_ms) VALUES ('devbox', 'web', ?1, ?2)", REPO, ms(NOW));
  // T7 ran from 10:00 to 10:35, was continued, and ran again from 11:40 to 11:50.
  sql(
    h,
    `INSERT INTO tasks (n, machine_id, project_id, workstream_id, state, ended_at, data)
     VALUES (7, 'devbox', 'web', 'W1', 'done', '2026-10-23T11:50:00.000Z', ?1)`,
    JSON.stringify({ taskId: "T7", createdAt: "2026-10-23T09:55:00.000Z", startedAt: "2026-10-23T10:00:00.000Z" }),
  );
  for (const [run, start, end] of [
    ["r1", "2026-10-23T10:00:00Z", "2026-10-23T10:35:00Z"],
    ["r2", "2026-10-23T11:40:00Z", "2026-10-23T11:50:00Z"],
  ] as const) {
    sql(
      h,
      `INSERT INTO time_spans (src, src_key, kind, cat, start_ms, end_ms, machine_id, project_id, task_id, run_id, lane, status)
       VALUES ('n', ?1, ?2, 0, ?3, ?4, 'devbox', 'web', 'T7', ?5, 'run', 0)`,
      `t7/${run}/run`,
      kindCode("run"),
      ms(start),
      ms(end),
      run,
    );
  }
}

const routes = (h: H) => Object.fromEntries(rows(h).map((r) => [r.unitKey, r.skipWhy === undefined ? [r.route] : [r.route, r.skipWhy]]));
const sha = (tag: string) => tag.repeat(40).slice(0, 40);

test("a first read backfills 90 days and routes every landed change", async () => {
  const { hub: h } = hub();
  checkout(h);
  const gh = new Recorded();
  const swept = await sweep.sweepRepo(h, new GitHubSource(gh), REPO, ms(NOW));
  const want = {
    "pr:50": ["train"],
    "pr:41": ["outside"],
    "pr:42": ["skipped", "bot"],
    "pr:43": ["fleetd_by_hand"],
    // The batch PR #44 is its two members, each one landed change.
    "pr:45": ["train"],
    "pr:46": ["train"],
    "pr:47": ["skipped", "other_base"],
    // Stacked: #48 took release/2.0 into main and counts once; a sync from upstream is a merge-back.
    "pr:48": ["outside"],
    "pr:49": ["skipped", "merge_back"],
    // Merged on 1 September: the backfill's second page.
    "pr:30": ["outside"],
    [`commit:${sha("b2")}`]: ["direct"],
    [`commit:${sha("b4")}`]: ["skipped", "bot"],
  };
  expect(routes(h)).toEqual(want);
  expect(swept.rows).toBe(Object.keys(want).length);
  expect(gh.mergedPages()).toBe(2);
  const byKey = Object.fromEntries(rows(h).map((r) => [r.unitKey, r]));
  const outside = byKey["pr:41"]!;
  expect([outside.mergedMs, outside.prCreatedMs, outside.authorKind, outside.mergedByKind]).toEqual([
    ms("2026-10-24T10:00:00Z"),
    ms("2026-10-20T08:00:00Z"),
    "human",
    "human",
  ]);
  expect([outside.additions, outside.deletions, outside.title, outside.machineId, outside.projectId]).toEqual([12, 3, "Fix the cart total", "devbox", "web"]);
  const member = byKey["pr:45"]!;
  expect([member.batchPr, member.changeId, member.workstreamId, member.mergedMs]).toEqual([44, "X45", "W1", ms("2026-10-22T12:00:00Z")]);
  expect(byKey["pr:43"]!.taskId).toBe("T7");
  // The person's two acts on #41 count toward outside work, the reviews of fleetd's #43 toward fleetd's.
  const touches = h.db.conn
    .query<{ pr_number: number; kind: string; outside: number }, []>("SELECT pr_number, kind, outside FROM metric_touches WHERE src = 'host' ORDER BY at_ms")
    .all()
    .map((t) => [t.pr_number, t.kind, t.outside === 1]);
  expect(touches).toEqual([
    [43, "host.review", false],
    [43, "host.review", false],
    [43, "host.comment", false],
    [41, "host.review", true],
    [41, "host.comment", true],
  ]);
  expect(swept.touches).toBe(5);
  // Thirty days: three through the train, one fleetd PR merged by hand, two outside, one direct push.
  const out = await get(h, admin(), { since: isoMs(ms(NOW) - 30 * DAY), tz: "UTC" });
  expect(out.tiles.merged.byRoute).toEqual({ train: 3, fleetdByHand: 1, outside: 2, direct: 1 });
  expect(Math.abs(out.tiles.throughFleetd.pct! - 300 / 7)).toBeLessThan(1e-9);
  // The backfill reaches past the previous 30 days, so the delta is shown: #30 on 1 September.
  expect(Math.abs(out.tiles.merged.previousPerDay! - 1 / 30)).toBeLessThan(1e-9);
  const cov = out.coverage.repos[0]!;
  expect([cov.defaultBranch, cov.knownSince]).toEqual(["main", isoMs(ms(NOW) - 90 * DAY)]);
  expect(out.coverage.stale).toEqual([]);
  expect(out.days.find((d) => d.day === "2026-10-22")!.notCounted.length).toBe(1);
});

test("the train's events and the sweep route a PR the same way", async () => {
  const { hub: h } = hub();
  checkout(h);
  sql(h, "INSERT INTO metric_repos (repo, host, default_branch) VALUES (?1, 'github', 'main')", REPO);
  for (const [n, head, author, merged] of [
    [42, "dependabot/npm_and_yarn/lodash-4.17.21", "bot", "2026-10-23T15:00:00.000Z"],
    [43, "fleetd/T7-checkout", "human", "2026-10-23T12:00:00.000Z"],
    [47, "backport-cart", "human", "2026-10-22T09:00:00.000Z"],
  ] as const) {
    event(h, NOW, "pr.merged_outside", { repo: "acme/web", prNumber: n, mergedAt: merged, head, authorKind: author, base: n === 47 ? "release/2.0" : "main" });
  }
  // An older hub's event says no base: it counts.
  event(h, NOW, "pr.merged_outside", { repo: "acme/web", prNumber: 41, mergedSha: sha("41") });
  projectFrom(h, 0);
  const fromEvents = routes(h);
  expect([fromEvents["pr:42"], fromEvents["pr:43"], fromEvents["pr:47"], fromEvents["pr:41"]]).toEqual([
    ["skipped", "bot"],
    ["fleetd_by_hand"],
    ["skipped", "other_base"],
    ["outside"],
  ]);
  expect(rows(h).find((r) => r.unitKey === "pr:43")!.mergedMs).toBe(ms("2026-10-23T12:00:00Z"));
  const source = new GitHubSource(new Recorded());
  await sweep.sweepRepo(h, source, REPO, ms(NOW));
  const after = routes(h);
  expect([after["pr:42"], after["pr:43"], after["pr:47"]]).toEqual([["skipped", "bot"], ["fleetd_by_hand"], ["skipped", "other_base"]]);
  // A second read and a replay of the log write nothing new.
  await sweep.sweepRepo(h, source, REPO, ms(NOW) + 60_000);
  projectFrom(h, 0);
  expect(routes(h)).toEqual(after);
});

test("a signed-out host keeps the rows and the view says since when", async () => {
  const { hub: h, clock } = hub();
  checkout(h);
  const gh = new Recorded();
  const source = new GitHubSource(gh);
  await sweep.sweepRepo(h, source, REPO, ms(NOW));
  const before = routes(h);
  // The next read starts at the cursor: the first page is already past it.
  clock.ms += 15 * 60_000;
  await sweep.sweepRepo(h, source, REPO, ms(NOW) + 15 * 60_000);
  expect(gh.mergedPages()).toBe(3);
  gh.signedOut = true;
  const why = await sweep.sweepRepo(h, source, REPO, ms(NOW) + 30 * 60_000).then(
    () => "",
    (e: Error) => e.message,
  );
  expect(why).toContain("gh auth login");
  expect(routes(h)).toEqual(before);
  const out = await get(h, admin(), { since: isoMs(ms(NOW) - 7 * DAY), tz: "UTC" });
  const stale = out.coverage.stale[0]!;
  expect([stale.repo, stale.since]).toEqual([REPO, isoMs(ms(NOW) + 15 * 60_000)]);
  expect(stale.reason.startsWith("GitHub not read since 12:15: GitHub isn't signed in")).toBe(true);
  expect(out.tiles.merged.n).toBe(7);
});

test("a repo is read every 15 minutes while active, else hourly, and within a minute of a read", () => {
  const now = ms(NOW);
  const active = now - DAY;
  const quiet = now - 8 * DAY;
  expect(sweep.due(undefined, undefined, false, now)).toBe(true);
  expect(sweep.due(now - sweep.ACTIVE_EVERY_MS + 1, active, false, now)).toBe(false);
  expect(sweep.due(now - sweep.ACTIVE_EVERY_MS, active, false, now)).toBe(true);
  expect(sweep.due(now - sweep.ACTIVE_EVERY_MS, quiet, false, now)).toBe(false);
  expect(sweep.due(now - sweep.QUIET_EVERY_MS, quiet, false, now)).toBe(true);
  expect(sweep.due(now - sweep.ON_READ_MS + 1, quiet, true, now)).toBe(false);
  expect(sweep.due(now - sweep.ON_READ_MS, quiet, true, now)).toBe(true);
});

test("a pass reads each due repo once, and a metrics read asks again after a minute", async () => {
  const { hub: h, clock } = hub();
  checkout(h);
  const gh = new Recorded();
  sweep.metricsSweep(h).sources = { github: new GitHubSource(gh) };
  const reads = () => gh.runs().filter((r) => r.includes("repos/acme/web")).length;
  await sweep.pass(h);
  expect(reads()).toBe(1);
  await sweep.pass(h);
  expect(reads()).toBe(1);
  clock.ms += 61_000;
  await sweep.pass(h);
  expect(reads()).toBe(1);
  await get(h, admin(), { since: isoMs(ms(NOW) - 7 * DAY), tz: "UTC" });
  await sweep.pass(h);
  expect(reads()).toBe(2);
  clock.ms += 15 * 60_000;
  await sweep.pass(h);
  expect(reads()).toBe(3);
  // A hub with no reader for the host leaves its repos alone.
  sweep.metricsSweep(h).sources = {};
  clock.ms += sweep.QUIET_EVERY_MS;
  await sweep.pass(h);
  expect(reads()).toBe(3);
});

test("the hub's own login is the person's, and only its reviews and merges count", async () => {
  const { hub: h } = hub();
  checkout(h);
  await sweep.sweepRepo(h, new GitHubSource(new Recorded()), REPO, ms(NOW));
  const ids = store.identities(h.db.conn);
  expect(ids).toEqual(["ada-lovelace"]);
  const who = new human.Identities(ids);
  const touches = store.touches(h.db.conn, 0, Number.MAX_SAFE_INTEGER);
  const counted = (kind: string) =>
    touches
      .filter((t) => t.kind === kind)
      .map((t) => [t.prNumber, t.keyId, human.attributed(t, who)] as const)
      .sort((a, b) => a[0]! - b[0]! || String(a[1]).localeCompare(String(b[1])));
  expect(counted("host.review")).toEqual([
    [41, "ada-lovelace", true],
    [43, "ada-lovelace", true],
    [43, "grace-hopper", false],
  ]);
  expect(counted("merge.by_hand")).toEqual([
    [30, "ada-lovelace", true],
    [41, "ada-lovelace", true],
    [43, "ada-lovelace", true],
    [48, "ada-lovelace", true],
  ]);
});

test("a commit made before the last read and pushed after it is a direct push", async () => {
  const { hub: h } = hub();
  checkout(h);
  const gh = new Recorded();
  const source = new GitHubSource(gh);
  await sweep.sweepRepo(h, source, REPO, ms(NOW));
  gh.latePush = true;
  await sweep.sweepRepo(h, source, REPO, ms(NOW) + HOUR);
  expect(routes(h)[`commit:${sha("c7")}`]).toEqual(["direct"]);
  const history = gh.runs().findLast((r) => r.includes("history("))!;
  expect(history.includes(" since=")).toBe(false);
  expect(h.db.conn.query<{ s: string }, [string]>("SELECT commits_cursor_sha AS s FROM metric_repos WHERE repo = ?1").get(REPO)?.s).toBe(sha("c7"));
});

test("the default branch is read back to the last head, or by date once that head is gone", () => {
  const commit = (tag: string, at: string, parent?: string): LandedCommit => ({
    sha: sha(tag),
    atMs: ms(at),
    title: "",
    ...(parent ? { firstParent: sha(parent) } : {}),
    prs: [],
    bot: false,
  });
  const commits = [commit("c7", "2026-10-01T09:00:00Z", "50"), commit("50", "2026-10-24T12:00:00Z", "41"), commit("41", "2026-10-24T10:00:00Z")];
  const shas = (cs: LandedCommit[]) => cs.map((c) => c.sha.slice(0, 2));
  const since = ms("2026-10-24T11:00:00Z");
  expect(shas(sweep.landedSince(commits, sha("50"), since))).toEqual(["c7"]);
  expect(sweep.landedSince(commits, sha("c7"), since)).toEqual([]);
  // A force push left the last head off the line: the date window it is.
  expect(shas(sweep.landedSince(commits, sha("ff"), since))).toEqual(["50"]);
  expect(shas(sweep.landedSince(commits, undefined, since))).toEqual(["50"]);
});

test("fleetd's own comments, and an agent's during its run, are not the person's", async () => {
  const { hub: h } = hub();
  checkout(h);
  await sweep.sweepRepo(h, new GitHubSource(new Recorded()), REPO, ms(NOW));
  const comments = store
    .touches(h.db.conn, 0, Number.MAX_SAFE_INTEGER)
    .filter((t) => t.kind === "host.comment")
    .map((t) => [t.prNumber, t.atMs]);
  expect(comments).toEqual([
    [43, ms("2026-10-23T12:30:00Z")],
    [41, ms("2026-10-24T09:40:00Z")],
  ]);
  const act = (at: string): HostAct => ({ kind: "comment", id: "1", prNumber: 43, atMs: ms(at), login: "ada-lovelace", bot: false, head: "slot/1/fleetd/T7-checkout" });
  const agents = (at: string) => sweep.agentsAct(h.db, REPO, act(at), ms(NOW));
  expect(agents("2026-10-23T10:35:00Z")).toBe(true);
  expect(agents("2026-10-23T11:00:00Z")).toBe(false);
  expect(agents("2026-10-23T11:45:00Z")).toBe(true);
  expect(agents("2026-10-23T12:00:00Z")).toBe(false);
  // Another fleet's `fleetd/T7-…` on a repo none of this hub's projects has is not this hub's T7.
  expect(sweep.agentsAct(h.db, "github.com/other/web", act("2026-10-23T10:30:00Z"), ms(NOW))).toBe(false);
});

// A repo read from git alone.

test("trailers and subjects name changes, tasks and PRs", () => {
  expect(changeTrailer("X12 (T45, W9)")).toEqual(["X12", "T45", "W9"]);
  expect(changeTrailer("X3 (W1)")).toEqual(["X3", undefined, "W1"]);
  expect(changeTrailer("T4")).toBeUndefined();
  expect(subjectPr("Merge pull request #12 from acme/fleetd/T45-x")).toBe(12);
  expect(subjectPr("Merge pull request 'Fix totals' (#7) from fix into main")).toBe(7);
  expect(subjectPr("Merge branch 'fix (#7x)'")).toBeUndefined();
  expect(subjectPr("Merge branch 'feature'")).toBeUndefined();
  expect(subjectTask("Merge pull request #12 from acme/fleetd/T45-x")).toBe("T45");
  expect(isSync("Merge branch 'main' of git.internal:srv/web", "main")).toBe(true);
  expect(isSync("Merge remote-tracking branch 'origin/main'", "main")).toBe(true);
  expect(isSync("Merge branch 'feature'", "main")).toBe(false);
});

const GIT = "git.internal/srv/web";
const commit = (tag: string, at: string, subject: string, more: Partial<GitCommit> = {}): GitCommit => ({
  sha: sha(tag),
  parents: [sha("00")],
  atMs: ms(at),
  authorName: "Ada",
  subject,
  ...more,
});

test("a repo with no host tells the train's merges, hand merges and direct pushes apart from git alone", () => {
  const { hub: h } = hub();
  checkout(h);
  const two = [sha("00"), sha("01")];
  const line = [
    commit("a1", "2026-10-24T11:00:00Z", "Merge branch 'main' of git.internal:srv/web", { parents: two }),
    commit("a2", "2026-10-24T10:00:00Z", "chore: bump", { authorName: "renovate[bot]" }),
    commit("a3", "2026-10-24T09:00:00Z", "Merge pull request #12 from acme/fleetd/T7-checkout", { parents: two }),
    commit("a4", "2026-10-24T08:00:00Z", "Merge branch 'feature'", { parents: two }),
    commit("a5", "2026-10-24T07:00:00Z", "fix typo"),
    commit("a6", "2026-10-24T06:00:00Z", "Checkout totals (#50)", { changes: ["X50 (T50, W1)"] }),
    commit("a7", "2026-10-24T05:00:00Z", "part two", { tasks: ["T7"] }),
    commit("a8", "2026-10-24T04:00:00Z", "part one", { tasks: ["T7"] }),
  ];
  const out = gitRows(h.db, GIT, "main", ["devbox", "web"], line);
  expect(out.map((r) => [r.unitKey.slice(0, 9), r.route, r.skipWhy, r.taskId, r.prNumber])).toEqual([
    ["commit:a1", "skipped", "merge_back", undefined, undefined],
    ["commit:a2", "skipped", "bot", undefined, undefined],
    ["commit:a3", "fleetd_by_hand", undefined, "T7", 12],
    ["commit:a4", "outside", undefined, undefined, undefined],
    ["commit:a5", "direct", undefined, undefined, undefined],
    // The train's squash, by its trailer: the Change's PR, one row.
    ["pr:50", "train", undefined, "T50", 50],
    // A run of one task's commits in a row is one change (a rebase merge).
    ["commit:a7", "fleetd_by_hand", undefined, "T7", undefined],
  ]);
  expect(out[2]!.workstreamId).toBe("W1");
});

test("a repo with no host and no connected checkout says so, never a silent zero", async () => {
  const { hub: h } = hub();
  checkout(h);
  // Checked out in the test hub's own project: the pass forgets checkouts of projects the hub doesn't have.
  sql(h, "INSERT INTO metric_project_repos (machine_id, project_id, repo, checked_ms) VALUES ('lab-a', 'p1', ?1, ?2)", GIT, ms(NOW));
  sql(h, "INSERT INTO metric_repos (repo, host, default_branch) VALUES (?1, 'git', 'main')", GIT);
  const offline: GitLog = { canRead: () => false, read: () => Promise.reject(new Error("never asked")) };
  sweep.metricsSweep(h).sources = {};
  sweep.metricsSweep(h).git = offline;
  await sweep.pass(h);
  const why = h.db.conn.query<{ e: string | null }, [string]>("SELECT last_error AS e FROM metric_repos WHERE repo = ?1").get(GIT)?.e;
  expect(why).toBe("no machine with it checked out is connected to read its git log");
  // A connected checkout's log is read and its rows kept, with the cursor at its head.
  const log: GitLog = {
    canRead: () => true,
    read: async () => ({ read: "devbox", commits: [commit("b1", "2026-10-24T07:00:00Z", "fix typo")] }),
  };
  sweep.metricsSweep(h).git = log;
  sweep.metricsSweep(h).tried.clear();
  await sweep.pass(h);
  expect(routes(h)[`commit:${sha("b1")}`]).toEqual(["direct"]);
  const out = await get(h, admin(), { since: isoMs(ms(NOW) - 7 * DAY), tz: "UTC" });
  const cov = out.coverage.repos.find((r) => r.repo === GIT)!;
  expect([cov.host, cov.unknown?.length]).toEqual(["git", 7]);
});

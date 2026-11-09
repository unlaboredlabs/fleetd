// The host sweep over recorded GitHub answers (crates/fleetd/src/hub/metrics/sweep_tests.rs, fixtures/github/), no
// network: a first read's 90-day backfill and routes (bots, batches, other bases, merge-backs, direct pushes), the
// person's reviews and comments, the train's richer events agreeing with it, a failing host, and when a repo is read.
// Then a repo whose host fleetd can't read (no_host_tests.rs), over a real bare-repo origin and a checkout of it: each
// route told apart from git alone, the next read picking up only what landed since, and the view saying what git
// can't know.
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { GitHubSource } from "../src/hub/metrics/github.ts";
import type { HostAct } from "../src/hub/metrics/host_acts.ts";
import * as human from "../src/hub/metrics/human.ts";
import { changeTrailer, type GitLog, isSync, subjectPr, subjectTask } from "../src/hub/metrics/no_host.ts";
import type { GitHostSource, LandedCommit, MergedPr, MergedRead, RepoRef } from "../src/hub/metrics/source.ts";
import * as store from "../src/hub/metrics/store.ts";
import * as sweep from "../src/hub/metrics/sweep.ts";
import { GIT_UNKNOWN } from "../src/hub/metrics/tools.ts";
import { isoMs } from "../src/hub/store/time.ts";
import type { GhOut, GhRunner } from "../src/hub/train/gh.ts";
import { landedLog } from "../src/node/actions/landed.ts";
import type { MetricsGetOutput } from "../src/shared/contracts.ts";
import { DAY, HOUR, NOW, admin, change, done, event, get, hub, ms, orders, projectFrom, rows, sql, type H } from "./metrics-helpers.ts";

afterEach(done);

const REPO = "github.com/acme/web";
const fixture = (name: string) => readFileSync(join(import.meta.dir, "fixtures/metrics/github", name), "utf8");
const REPO_JSON = fixture("repo.json");
const MERGED_1 = fixture("merged-1.json");
const MERGED_2 = fixture("merged-2.json");
const COMMITS = fixture("commits.json");
const COMMITS_LATE = fixture("commits-late.json");
const ACTS = fixture("acts.json");
const USER = fixture("user.json");

/** `gh` answering from the recorded responses, or signed out. */
class Recorded implements GhRunner {
  signedOut = false;
  /** The default branch has moved on with a commit made before the first read. */
  latePush = false;
  readonly calls: string[][] = [];

  runs(): string[] {
    return this.calls.map((a) => a.join(" "));
  }

  mergedPages(): number {
    return this.runs().filter((r) => r.includes("states: MERGED")).length;
  }

  async run(args: string[]): Promise<GhOut> {
    const joined = args.join(" ");
    this.calls.push(args);
    if (this.signedOut) return { exitCode: 4, stdout: "", stderr: "To get started with GitHub CLI, please run:  gh auth login" };
    const body =
      args[1] === "repos/acme/web"
        ? REPO_JSON
        : args[1] === "user"
          ? USER
          : joined.includes("history(")
            ? this.latePush
              ? COMMITS_LATE
              : COMMITS
            : joined.includes("reviews(last")
              ? ACTS
              : joined.includes("states: MERGED") && joined.includes(" after=")
                ? MERGED_2
                : joined.includes("states: MERGED")
                  ? MERGED_1
                  : undefined;
    if (body === undefined) throw new Error(`no recorded answer for gh ${joined}`);
    return { exitCode: 0, stdout: body, stderr: "" };
  }
}

/** acme/web checked out as devbox/web; X45 landed in a batch, X50 on its own, both through the train. */
function checkout(h: H) {
  orders(h);
  change(h, 45, 45, "W1", "T45", "merged", "2026-10-21T08:00:00.000Z");
  change(h, 50, 50, "W1", "T50", "merged", "2026-10-23T08:00:00.000Z");
  sql(h, "INSERT INTO metric_project_repos (machine_id, project_id, repo, checked_ms) VALUES ('devbox', 'web', ?1, ?2)", REPO, ms(NOW));
  // T7 wrote #43 (`fleetd/T7-checkout`) on the 23rd: it ran from 10:00 to 10:35, was continued, and ran again from
  // 11:40 to 11:50. The task itself started at 10:00 and ended at 11:50.
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
       VALUES ('n', ?1, 1, 0, ?2, ?3, 'devbox', 'web', 'T7', ?4, 'run', 0)`,
      `t7/${run}/run`,
      ms(start),
      ms(end),
      run,
    );
  }
}

/** unit key → [route, why skipped]. */
const routes = (h: H) => Object.fromEntries(rows(h).map((r) => [r.unitKey, [r.route, r.skipWhy ?? null]]));
const route = (r: string) => [r, null];
const skipped = (why: string) => ["skipped", why];
const sha = (tag: string) => tag.repeat(40).slice(0, 40);
const byKey = (h: H) => new Map(rows(h).map((r) => [r.unitKey, r]));

test("a first read backfills 90 days and routes every landed change", async () => {
  const { hub: h } = hub();
  checkout(h);
  const gh = new Recorded();
  const swept = await sweep.sweepRepo(h, new GitHubSource(gh), REPO, ms(NOW));

  const want = {
    "pr:50": route("train"),
    "pr:41": route("outside"),
    "pr:42": skipped("bot"),
    "pr:43": route("fleetd_by_hand"),
    // The batch PR #44 is its two members, each one landed change.
    "pr:45": route("train"),
    "pr:46": route("train"),
    "pr:47": skipped("other_base"),
    // Stacked: #47 went into release/2.0, then #48 took release/2.0 into main. The work counts once, as #48, the PR
    // that reached the default branch. A sync from upstream is a merge-back.
    "pr:48": route("outside"),
    "pr:49": skipped("merge_back"),
    // Merged on 1 September: the backfill's second page. #20 is older than 90 days.
    "pr:30": route("outside"),
    [`commit:${sha("b2")}`]: route("direct"),
    [`commit:${sha("b4")}`]: skipped("bot"),
  };
  expect(routes(h)).toEqual(want);
  expect(swept.rows).toBe(Object.keys(want).length);
  // #50's squash isn't linked to its PR yet, and the wip commit is off the default branch's own line.
  expect(gh.mergedPages()).toBe(2);

  const keyed = byKey(h);
  const outside = keyed.get("pr:41")!;
  expect(outside.mergedMs).toBe(ms("2026-10-24T10:00:00Z"));
  expect(outside.prCreatedMs).toBe(ms("2026-10-20T08:00:00Z"));
  expect([outside.authorKind, outside.mergedByKind]).toEqual(["human", "human"]);
  expect([outside.additions, outside.deletions]).toEqual([12, 3]);
  expect(outside.title).toBe("Fix the cart total");
  expect([outside.machineId, outside.projectId]).toEqual(["devbox", "web"]);
  const member = keyed.get("pr:45")!;
  expect([member.batchPr, member.changeId, member.workstreamId]).toEqual([44, "X45", "W1"]);
  expect(member.mergedMs).toBe(ms("2026-10-22T12:00:00Z"));
  expect(keyed.get("pr:43")!.taskId).toBe("T7");

  // The person's two acts on #41 count toward outside work, the review of fleetd's #43 toward fleetd's; the bot's
  // comment and the pending review are not acts.
  const touches = h.db.conn
    .query<{ pr: number; kind: string; outside: number }, []>(
      "SELECT pr_number AS pr, kind, outside FROM metric_touches WHERE src = 'host' ORDER BY at_ms",
    )
    .all()
    .map((t) => [t.pr, t.kind, t.outside !== 0]);
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
  const merged = out.tiles.merged;
  const by = merged.byRoute;
  expect([by.train, by.fleetdByHand, by.outside, by.direct]).toEqual([3, 1, 2, 1]);
  expect(out.tiles.throughFleetd.pct).toBeCloseTo(300 / 7, 9);
  // The backfill reaches past the previous 30 days, so the delta is shown: #30 on 1 September.
  expect(merged.previousPerDay).toBeCloseTo(1 / 30, 9);
  const cov = out.coverage.repos[0]!;
  expect(cov.defaultBranch).toBe("main");
  expect(cov.knownSince).toBe(isoMs(ms(NOW) - 90 * DAY));
  expect(out.coverage.stale).toEqual([]);
  // #47 into release/2.0.
  expect(out.days.find((d) => d.day === "2026-10-22")!.notCounted.length).toBe(1);
});

test("the train's events and the sweep route a PR the same way", async () => {
  const { hub: h } = hub();
  checkout(h);
  // The repo's default branch, as its project's node reported it.
  sql(h, "INSERT INTO metric_repos (repo, host, default_branch) VALUES (?1, 'github', 'main')", REPO);
  // What the train now reports of PRs merged without it: a bot's, and one from a fleetd branch with no Change.
  for (const [n, head, author, merged] of [
    [42, "dependabot/npm_and_yarn/lodash-4.17.21", "bot", "2026-10-23T15:00:00.000Z"],
    [43, "fleetd/T7-checkout", "human", "2026-10-23T12:00:00.000Z"],
    // Merged by hand into a release branch: not the default branch, so not landed.
    [47, "backport-cart", "human", "2026-10-22T09:00:00.000Z"],
  ] as const) {
    event(h, NOW, "pr.merged_outside", {
      repo: "acme/web",
      prNumber: n,
      mergedAt: merged,
      head,
      authorKind: author,
      base: n === 47 ? "release/2.0" : "main",
    });
  }
  // An older hub's event says no base: it counts.
  event(h, NOW, "pr.merged_outside", { repo: "acme/web", prNumber: 41, mergedSha: sha("41") });
  projectFrom(h, 0);
  const fromEvents = routes(h);
  expect(fromEvents["pr:42"]).toEqual(skipped("bot"));
  expect(fromEvents["pr:43"]).toEqual(route("fleetd_by_hand"));
  expect(fromEvents["pr:47"]).toEqual(skipped("other_base"));
  expect(fromEvents["pr:41"]).toEqual(route("outside"));
  // Timed when it merged, not when seen.
  expect(byKey(h).get("pr:43")!.mergedMs).toBe(ms("2026-10-23T12:00:00Z"));

  const source = new GitHubSource(new Recorded());
  await sweep.sweepRepo(h, source, REPO, ms(NOW));
  const after = routes(h);
  expect(after["pr:42"]).toEqual(skipped("bot"));
  expect(after["pr:43"]).toEqual(route("fleetd_by_hand"));
  expect(after["pr:47"]).toEqual(skipped("other_base"));

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
  expect(stale.repo).toBe(REPO);
  expect(stale.since).toBe(isoMs(ms(NOW) + 15 * 60_000));
  expect(stale.reason.startsWith("GitHub not read since 12:15: GitHub isn't signed in")).toBe(true);
  // The figures stay, marked stale.
  expect(out.tiles.merged.n).toBe(7);
});

test("a repo is read every 15 minutes while active, else hourly, and within a minute of a read", () => {
  const now = ms(NOW);
  expect(sweep.due(undefined, undefined, false, now)).toBe(true);
  const active = now - DAY;
  const quiet = now - 8 * DAY;
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
  // A hub built for tests reads no git host.
  expect(sweep.sweepArea(h).source("github")).toBeUndefined();
  const gh = new Recorded();
  sweep.sweepArea(h).sources = { github: new GitHubSource(gh) };
  const reads = () => gh.runs().filter((r) => r.includes("repos/acme/web")).length;

  await sweep.pass(h);
  expect(reads()).toBe(1); // every project's repo, train or not
  await sweep.pass(h);
  expect(reads()).toBe(1); // not due again yet

  clock.ms += 61_000;
  await sweep.pass(h);
  expect(reads()).toBe(1); // an active repo waits 15 minutes
  await get(h, admin(), { since: isoMs(ms(NOW) - 7 * DAY), tz: "UTC" });
  await sweep.pass(h);
  expect(reads()).toBe(2); // a metrics read asked for it

  clock.ms += 15 * 60_000;
  await sweep.pass(h);
  expect(reads()).toBe(3);
});

test("the hub's own login is the person's, and only its reviews and merges count", async () => {
  const { hub: h } = hub();
  checkout(h);
  await sweep.sweepRepo(h, new GitHubSource(new Recorded()), REPO, ms(NOW));

  const ids = store.identities(h.db.conn);
  const touches = store.touches(h.db.conn, 0, Number.MAX_SAFE_INTEGER);
  // The account gh reads GitHub as.
  expect(ids).toEqual(["ada-lovelace"]);
  const known = new human.Identities(ids);
  const counted = (kind: string) =>
    touches
      .filter((t) => t.kind === kind)
      .map((t) => [t.prNumber, t.keyId, human.attributed(t, known)] as const)
      .sort((a, b) => (a[0] ?? 0) - (b[0] ?? 0) || String(a[1]).localeCompare(String(b[1])));
  // Two reviews of #43: the person's counts, a colleague's on the same PR doesn't.
  expect(counted("host.review")).toEqual([
    [41, "ada-lovelace", true],
    [43, "ada-lovelace", true],
    [43, "grace-hopper", false],
  ]);
  // The PRs the person merged by hand, fleetd's #43 and the outside #41, #30 and #48, are theirs by the merger's login.
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

  // An hour on, main has one more commit, dated 1 October: long before the last read.
  gh.latePush = true;
  await sweep.sweepRepo(h, source, REPO, ms(NOW) + HOUR);
  expect(routes(h)[`commit:${sha("c7")}`]).toEqual(route("direct"));
  const history = gh
    .runs()
    .filter((r) => r.includes("history("))
    .at(-1)!;
  // Read back to the last head, not by date.
  expect(history).not.toContain(" since=");
  const head = h.db.conn.query<{ s: string }, [string]>("SELECT commits_cursor_sha AS s FROM metric_repos WHERE repo = ?1").get(REPO)?.s;
  expect(head).toBe(sha("c7"));
});

test("the default branch is read back to the last head, or by date once that head is gone", () => {
  const commit = (tag: string, at: string, parent?: string): LandedCommit => ({
    sha: sha(tag),
    atMs: ms(at),
    title: "",
    ...(parent === undefined ? {} : { firstParent: sha(parent) }),
    prs: [],
    bot: false,
  });
  const commits = [commit("c7", "2026-10-01T09:00:00Z", "50"), commit("50", "2026-10-24T12:00:00Z", "41"), commit("41", "2026-10-24T10:00:00Z")];
  const shas = (cs: LandedCommit[]) => cs.map((c) => c.sha.slice(0, 2));
  const since = ms("2026-10-24T11:00:00Z");
  expect(shas(sweep.landedSince(commits, sha("50"), since))).toEqual(["c7"]);
  // Nothing new.
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
  // On #43, T7's agent commented at 10:30 during its run, and the person at 12:30. On #45 the train left its comment,
  // marked, and one from before it marked them.
  expect(comments).toEqual([
    [43, ms("2026-10-23T12:30:00Z")],
    [41, ms("2026-10-24T09:40:00Z")],
  ]);
  const act = (at: string): HostAct => ({
    kind: "comment",
    id: "1",
    prNumber: 43,
    atMs: ms(at),
    login: "ada-lovelace",
    bot: false,
    head: "slot/1/fleetd/T7-checkout",
  });
  const agents = (at: string) => sweep.agentsAct(h.db, REPO, act(at), ms(NOW));
  expect(agents("2026-10-23T10:35:00Z")).toBe(true);
  // Between its two runs.
  expect(agents("2026-10-23T11:00:00Z")).toBe(false);
  expect(agents("2026-10-23T11:45:00Z")).toBe(true);
  expect(agents("2026-10-23T12:00:00Z")).toBe(false);
  // Another fleet's `fleetd/T7-…` on a repo none of this hub's projects has is not this hub's T7.
  expect(sweep.agentsAct(h.db, "github.com/other/web", act("2026-10-23T10:30:00Z"), ms(NOW))).toBe(false);
});

/** A task's act on its PR, through `gh` under the person's login. */
const taskAct = (task: number, at: string): HostAct => ({
  kind: "comment",
  id: "1",
  prNumber: 90 + task,
  atMs: ms(at),
  login: "ada-lovelace",
  bot: false,
  head: `fleetd/T${task}-x`,
});

function taskRow(h: H, n: number, state: string, started: string, ended: string | null) {
  sql(
    h,
    `INSERT INTO tasks (n, machine_id, project_id, workstream_id, state, ended_at, data)
     VALUES (?1, 'devbox', 'web', 'W1', ?2, ?3, ?4)`,
    n,
    state,
    ended,
    JSON.stringify({ taskId: `T${n}`, createdAt: started, startedAt: started }),
  );
}

test("an act during a run still open, or past the span retention, is the agent's", () => {
  const { hub: h } = hub();
  checkout(h);
  const agents = (n: number, at: string) => sweep.agentsAct(h.db, REPO, taskAct(n, at), ms(NOW));

  // T8 first ran on the 20th, and was continued at 09:00 today: that run is open, and its spans come only when it ends.
  taskRow(h, 8, "running", "2026-10-20T08:00:00.000Z", null);
  sql(
    h,
    "INSERT INTO events (created_ms, type, machine_id, data) VALUES (?1, 'task.started', 'devbox', ?2)",
    ms("2026-10-25T09:00:00Z"),
    JSON.stringify({ type: "task.started", data: { taskId: "T8" } }),
  );
  // During the open run.
  expect(agents(8, "2026-10-25T10:00:00Z")).toBe(true);
  // Before this attempt, with no span for the last.
  expect(agents(8, "2026-10-25T08:30:00Z")).toBe(false);

  // T9 ran on 1 September, past the 30 days its spans are kept: its own start and end stand in.
  taskRow(h, 9, "done", "2026-09-01T10:00:00.000Z", "2026-09-01T12:00:00.000Z");
  expect(agents(9, "2026-09-01T11:00:00Z")).toBe(true);
  expect(agents(9, "2026-09-01T13:00:00Z")).toBe(false);
  // A task within the retention with no span covering the act: between runs, the person's.
  taskRow(h, 10, "done", "2026-10-24T10:00:00.000Z", "2026-10-24T12:00:00.000Z");
  expect(agents(10, "2026-10-24T11:00:00Z")).toBe(false);
});

test("a review between two runs of the same task is the person's", async () => {
  const { hub: h } = hub();
  checkout(h);
  await sweep.sweepRepo(h, new GitHubSource(new Recorded()), REPO, ms(NOW));
  const reviews = store
    .touches(h.db.conn, 0, Number.MAX_SAFE_INTEGER)
    .filter((t) => t.kind === "host.review" && t.prNumber === 43)
    .map((t) => [t.atMs, t.keyId]);
  // T7 was continued: its task spans 10:00 to 11:50, but it ran only until 10:35 and from 11:40. The person's review at
  // 11:00 and a colleague's at 11:30 fall between the runs.
  expect(reviews).toEqual([
    [ms("2026-10-23T11:00:00Z"), "ada-lovelace"],
    [ms("2026-10-23T11:30:00Z"), "grace-hopper"],
  ]);
});

/** GitHub's reads with the merged PRs cut short after the first page, as the page cap does to a busy repo. */
class CutShort implements GitHostSource {
  readonly afters: (string | undefined)[] = [];
  constructor(private readonly inner: GitHubSource) {}

  signedIn() {
    return this.inner.signedIn();
  }

  repoInfo(repo: RepoRef) {
    return this.inner.repoInfo(repo);
  }

  async mergedSince(repo: RepoRef, sinceMs: number, after?: string): Promise<MergedRead> {
    this.afters.push(after);
    const all = (await this.inner.mergedSince(repo, sinceMs)).pulls;
    const first = (p: MergedPr) => p.updatedMs >= ms("2026-10-20T09:00:00Z");
    // A read from the cursor of a later pass fits in a page.
    if (after === undefined && sinceMs >= ms("2026-10-20T09:00:00Z")) return { pulls: all };
    if (after === undefined) return { pulls: all.filter(first), rest: ["page-2", ms("2026-10-20T09:00:00Z")] };
    return { pulls: all.filter((p) => !first(p)) };
  }

  defaultCommits(repo: RepoRef, branch: string, sinceMs: number, stopAt?: string) {
    return this.inner.defaultCommits(repo, branch, sinceMs, stopAt);
  }

  prsOfCommit(repo: RepoRef, sha: string) {
    return this.inner.prsOfCommit(repo, sha);
  }

  acts() {
    return this.inner.acts();
  }
}

test("a read the page cap cut short goes on at the next, and shows partly read until done", async () => {
  const { hub: h } = hub();
  checkout(h);
  const source = new CutShort(new GitHubSource(new Recorded()));
  await sweep.sweepRepo(h, source, REPO, ms(NOW));
  // On the page not read yet.
  expect(routes(h)["pr:30"]).toBeUndefined();
  const coverage = (out: MetricsGetOutput) => {
    const c = out.coverage.repos[0]!;
    return [c.partlyRead ?? null, c.knownSince ?? null];
  };
  const read = () => get(h, admin(), { since: isoMs(ms(NOW) - 7 * DAY), tz: "UTC" });
  // Known only as far as the read reached.
  expect(coverage(await read())).toEqual([true, isoMs(ms("2026-10-20T09:00:00Z"))]);

  await sweep.sweepRepo(h, source, REPO, ms(NOW) + HOUR);
  // The next read goes on from where the cap stopped.
  expect(source.afters).toEqual([undefined, undefined, "page-2"]);
  expect(routes(h)["pr:30"]).toEqual(route("outside"));
  expect(coverage(await read())).toEqual([null, isoMs(ms(NOW) - 90 * DAY)]);
});

// A repo whose host fleetd can't read (no_host_tests.rs).
const GIT_REPO = "git.internal/srv/web";

/** `git` in `dir` as a person at `at`, failing the test on an error; its stdout. */
function gitAt(dir: string, at: string, args: string[]): string {
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: "Sam",
    GIT_AUTHOR_EMAIL: "sam@example.com",
    GIT_COMMITTER_NAME: "Sam",
    GIT_COMMITTER_EMAIL: "sam@example.com",
    GIT_AUTHOR_DATE: at,
    GIT_COMMITTER_DATE: at,
  };
  const out = Bun.spawnSync(["git", "-C", dir, "-c", "commit.gpgsign=false", "-c", "init.defaultBranch=main", ...args], { env });
  if (out.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${out.stderr.toString()}`);
  return out.stdout.toString().trim();
}

/** A bare origin, a person's working clone that lands work on it, and the project's checkout of it. */
class Origin {
  readonly dir = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "fleetd-bun-origin-"));
  readonly work = join(this.dir, "work");
  readonly checkout = join(this.dir, "checkout");

  constructor() {
    const bare = join(this.dir, "web.git");
    const old = "2026-04-01T12:00:00Z";
    gitAt(this.dir, old, ["init", "-q", "--bare", "-b", "main", bare]);
    gitAt(this.dir, old, ["clone", "-q", bare, this.work]);
    // Older than the 90 days a first read goes back.
    this.commit(old, "init.txt", "init", "Sam");
    this.push(old);
    gitAt(this.dir, old, ["clone", "-q", bare, this.checkout]);
  }

  /** A commit on the working clone's current branch; its sha. */
  commit(at: string, file: string, message: string, author: string): string {
    writeFileSync(join(this.work, file), `${message}\n`);
    gitAt(this.work, at, ["add", "."]);
    gitAt(this.work, at, ["commit", "-q", "--author", `${author} <sam@example.com>`, "-m", message]);
    return gitAt(this.work, at, ["rev-parse", "HEAD"]);
  }

  /** Merges `branch` into main with a merge commit; its sha. */
  merge(at: string, branch: string, message: string): string {
    gitAt(this.work, at, ["checkout", "-q", "main"]);
    gitAt(this.work, at, ["merge", "-q", "--no-ff", branch, "-m", message]);
    return gitAt(this.work, at, ["rev-parse", "HEAD"]);
  }

  branch(at: string, name: string) {
    gitAt(this.work, at, ["checkout", "-q", "-b", name, "main"]);
  }

  push(at: string) {
    gitAt(this.work, at, ["push", "-q", "origin", "main"]);
  }

  done() {
    rmSync(this.dir, { recursive: true, force: true });
  }
}

/** The node's `landed_log` on the project's checkout, as the node runs it. */
const checkoutLog = (root: string, connected = true): GitLog => ({
  canRead: (_hub, machine) => connected && machine === "devbox",
  read: (_hub, _at, branch, sinceMs, stopAt) => landedLog(root, branch, sinceMs, stopAt),
});

/** The project devbox/web with the repo checked out; X50 and X60 are Changes the train merged, T3 and T4 tasks of W2. */
function project(h: H) {
  orders(h);
  change(h, 50, 50, "W1", "T50", "merged", "2026-10-20T08:00:00.000Z");
  change(h, 60, 60, "W2", undefined, "merged", "2026-10-21T08:00:00.000Z");
  for (const n of [3, 4, 5]) {
    sql(h, "INSERT INTO tasks (n, machine_id, project_id, workstream_id, state, data) VALUES (?1, 'devbox', 'web', 'W2', 'done', '{}')", n);
  }
  sql(h, "INSERT INTO projects (machine_id, project_id, search, last_activity_at, data) VALUES ('devbox', 'web', '', '', '{}')");
  sql(h, "INSERT INTO metric_project_repos (machine_id, project_id, repo, checked_ms) VALUES ('devbox', 'web', ?1, ?2)", GIT_REPO, ms(NOW));
  sql(h, "INSERT INTO metric_repos (repo, host, default_branch) VALUES (?1, 'git', 'main')", GIT_REPO);
}

/** unit key → [route, task, workstream, PR]. */
const gitRoutes = (h: H) =>
  Object.fromEntries(rows(h).map((r) => [r.unitKey, [r.route, r.taskId ?? null, r.workstreamId ?? null, r.prNumber ?? null]]));

test("a repo with no host tells the train's merges, hand merges and direct pushes apart from git alone", async () => {
  const { hub: h, clock } = hub();
  project(h);
  const origin = new Origin();
  try {
    sweep.sweepArea(h).git = checkoutLog(origin.checkout);

    // The train's squash, with its trailer.
    const train = origin.commit("2026-10-20T12:00:00Z", "docs.md", "docs (#50)\n\nAdds the docs.\n\nFleetd-Change: X50 (T50, W1)", "Sam");
    // A squash the train made before it wrote trailers: known by the Change's merge sha.
    const olderTrain = origin.commit("2026-10-21T12:00:00Z", "old.md", "old squash (#60)", "Sam");
    sql(h, "UPDATE changes SET data = json_set(data, '$.mergedSha', ?1) WHERE n = 60", olderTrain);
    // A person's PR merged by hand on the host: a merge commit, no trailer.
    origin.branch("2026-10-22T09:00:00Z", "feature");
    origin.commit("2026-10-22T09:00:00Z", "feature.txt", "a feature", "Sam");
    const hand = origin.merge("2026-10-22T10:00:00Z", "feature", "Merge pull request #9 from acme/feature");
    // fleetd's work merged by hand: a merge that brings in an agent's commits.
    origin.branch("2026-10-22T11:00:00Z", "topic");
    origin.commit("2026-10-22T11:00:00Z", "t3.txt", "fix totals\n\nFleetd-Task: T3", "Sam");
    const fleetdMerge = origin.merge("2026-10-22T12:00:00Z", "topic", "Merge branch 'topic'");
    // ...and rebased onto main by hand: two of T4's commits in a row are one change.
    origin.commit("2026-10-23T09:00:00Z", "t4a.txt", "t4 one\n\nFleetd-Task: T4", "Sam");
    const rebased = origin.commit("2026-10-23T09:00:00Z", "t4b.txt", "t4 two\n\nFleetd-Task: T4", "Sam");
    // An agent's branch merged by hand in a repo whose commits carry no trailer: known by the branch the merge names.
    origin.branch("2026-10-23T10:00:00Z", "fleetd/T5-more");
    origin.commit("2026-10-23T10:00:00Z", "t5.txt", "more totals", "Sam");
    const byBranch = origin.merge("2026-10-23T11:00:00Z", "fleetd/T5-more", "Merge pull request #11 from acme/fleetd/T5-more");
    // Pushed straight to main, and a bot's push.
    const direct = origin.commit("2026-10-24T09:00:00Z", "direct.txt", "hotfix", "Sam");
    const bot = origin.commit("2026-10-24T10:00:00Z", "deps.txt", "bump deps", "renovate[bot]");
    origin.push("2026-10-24T10:00:00Z");

    await sweep.pass(h);
    expect(store.repos(h.db.conn).filter((r) => r.repo === GIT_REPO).map((r) => r.lastError ?? null)).toEqual([null]);
    const want = {
      "pr:50": ["train", "T50", "W1", 50],
      "pr:60": ["train", null, "W2", 60],
      [`commit:${hand}`]: ["outside", null, null, 9],
      [`commit:${fleetdMerge}`]: ["fleetd_by_hand", "T3", "W2", null],
      [`commit:${rebased}`]: ["fleetd_by_hand", "T4", "W2", null],
      [`commit:${direct}`]: ["direct", null, null, null],
      [`commit:${byBranch}`]: ["fleetd_by_hand", "T5", "W2", 11],
      [`commit:${bot}`]: ["skipped", null, null, null],
    };
    expect(gitRoutes(h)).toEqual(want);
    const stored = rows(h);
    const trainRow = stored.find((r) => r.unitKey === "pr:50")!;
    expect([trainRow.mergedSha, trainRow.mergedMs, trainRow.src]).toEqual([train, ms("2026-10-20T12:00:00.000Z"), "git"]);
    // Timed from its order.
    expect(trainRow.requestedMs).toBeDefined();
    // Git doesn't say who merged.
    expect(stored.filter((r) => r.route !== "train").every((r) => r.mergedByKind === undefined)).toBe(true);

    // The next read starts at the head this one saw: only the new push.
    const late = origin.commit("2026-10-25T09:00:00Z", "late.txt", "late fix", "Sam");
    origin.push("2026-10-25T09:00:00Z");
    // The node reuses a fetch under 30 s old; a quarter of an hour on, as here, it fetches again.
    gitAt(origin.checkout, NOW, ["fetch", "-q", "origin"]);
    clock.ms += sweep.QUIET_EVERY_MS;
    await sweep.pass(h);
    const after = gitRoutes(h);
    expect(Object.keys(after).length).toBe(Object.keys(want).length + 1);
    expect(after[`commit:${late}`]?.[0]).toBe("direct");

    // The view: the routes counted, and what git alone can't say.
    const out = await get(h, admin(), { since: "2026-10-19T00:00:00.000Z", tz: "UTC" });
    const by = out.tiles.merged.byRoute;
    expect([by.train, by.fleetdByHand, by.outside, by.direct]).toEqual([2, 3, 1, 2]);
    expect(out.merges.every((m) => m.route === "train" || m.mergedBy === undefined)).toBe(true);
    const repo = out.coverage.repos.find((r) => r.repo === GIT_REPO)!;
    expect(repo.host).toBe("git");
    expect(repo.unknown).toEqual(GIT_UNKNOWN);
    expect(repo.unknown![0]!.startsWith("Who merged")).toBe(true);
    // fleetd's work merged by hand that git doesn't name is said to be unknowable, not silently counted as outside.
    expect(repo.unknown!.some((l) => l.startsWith("fleetd's work you merged by hand"))).toBe(true);
    expect(out.coverage.stale.filter((s) => s.repo === GIT_REPO)).toEqual([]);
  } finally {
    origin.done();
  }
});

test("a repo with no host and no connected checkout says so, never a silent zero", async () => {
  const { hub: h } = hub();
  project(h);
  const origin = new Origin();
  try {
    sweep.sweepArea(h).git = checkoutLog(origin.checkout, false);
    await sweep.pass(h);
    const out = await get(h, admin(), { since: "2026-10-19T00:00:00.000Z", tz: "UTC" });
    expect(out.coverage.stale.filter((s) => s.repo === GIT_REPO).map((s) => s.reason)).toEqual([
      "Its git log not read yet: no machine with it checked out is connected to read its git log",
    ]);
    const repo = out.coverage.repos.find((r) => r.repo === GIT_REPO)!;
    expect([repo.host, repo.unknown !== undefined]).toEqual(["git", true]);
  } finally {
    origin.done();
  }
});

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

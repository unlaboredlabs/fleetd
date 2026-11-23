// Issues are orders (W834): a GitHub issue in one of a bot's repos that a person with write access labels `fleetd`
// opens one order in that bot, with the issue as its text (rules.ts says how it reads). The issue gets a comment when
// the order opens and one when each of its PRs lands; the PR's description says `Fixes #N` (fleetd adds the line when
// it is missing) and so does the squash that lands it, so GitHub closes the issue even when the PR landed in a batch.
// An issue closed while its order is open and nothing of it landed, by the train's record or GitHub's, tells the lead,
// who asks the person whether to stop.
//
// A self-hosted hub gets no webhooks (its App asks for no events, and the hub is on loopback or a tailnet), so it
// reads each watched repo's open `fleetd` issues once a minute: one call per repo, which GitHub answers 304 for free
// while nothing changed. fleetd's cloud, which GitHub's App sends webhooks, hands each one to `take` instead
// (rules.ts `fromWebhook`): the same decisions, rows and comments.
//
// Per bot, one switch (`project_settings_set` issueOrders), on by default for a bot with a GitHub repo. Only the
// bot's own repos are watched, only a labeller with write access counts, and one issue has one open order at most:
// `issue_orders` remembers each issue's labelling, so a second poll, a restart or a webhook delivered twice does
// nothing again.
import type { ProjectRef } from "../../shared/contracts.ts";
import type { Hub } from "../api/hub.ts";
import { leadWakes } from "../api/leads.ts";
import { leads } from "../leads/index.ts";
import { intake } from "../leads/workstreams.ts";
import { workstreamGet } from "../orders/workstreams.ts";
import * as projectSettings from "../project_lead/store.ts";
import * as repos from "../repos/store.ts";
import { events } from "../store/events.ts";
import { store } from "../store/hub_store.ts";
import { every } from "../sweep/index.ts";
import { changeRecords } from "../train/index.ts";
import { isClosed } from "../leads/records.ts";
import {
  closedLine,
  closes,
  fixesLine,
  type IssueEvent,
  type IssueRow,
  type IssueSeen,
  type Labelling,
  labelledFleetd,
  landedComment,
  orderText,
  refusal,
  startedComment,
  triage,
  withFixes,
} from "./rules.ts";

export { fromWebhook, ISSUE_LABEL } from "./rules.ts";

/** How often a self-hosted hub reads its watched repos. */
export const POLL_MS = 60_000;
/** The issues whose close the poll looks for at most per repo and pass: the oldest open orders first. */
const CLOSE_CHECKS = 20;

/** What the issues area asks of GitHub (github.ts on the hub's `gh`; a fake in tests). Each throws why it failed. */
export interface IssueGitHub {
  /** The repo's open issues labelled `fleetd`, newest update first. */
  labelledOpen(repo: string): Promise<IssueSeen[]>;
  /** One issue as it is now, with who closed it; undefined when GitHub has none (deleted, or a PR). */
  issue(repo: string, n: number): Promise<{ issue: IssueSeen; closedBy?: string } | undefined>;
  /** The times the issue was labelled `fleetd`, oldest first. */
  labellings(repo: string, n: number): Promise<Labelling[]>;
  /** Whether `login` may push to the repo. */
  canWrite(repo: string, login: string): Promise<boolean>;
  comment(repo: string, n: number, body: string): Promise<void>;
  pullBody(repo: string, n: number): Promise<string>;
  setPullBody(repo: string, n: number, body: string): Promise<void>;
  /** A PR's merge on GitHub, with its commit; undefined while it isn't merged. */
  pullMerge(repo: string, n: number): Promise<{ sha?: string } | undefined>;
}

type Row = { repo: string; number: number; machine_id: string; project_id: string; workstream_id: string | null; data: string };
type Kept = { repo: string; number: number; projectRef: ProjectRef; row: IssueRow };

const keyOf = (r: ProjectRef) => `${r.machineId}/${r.projectId}`;

export class IssueOrders {
  /** Set by loops.ts: the hub's `gh`. Undefined, nothing reaches GitHub (the area answers as if it saw nothing). */
  github: IssueGitHub | undefined;
  /** Each repo's last failed read, so a poll that keeps failing (gh logged out) says it once, not every minute. */
  private readonly failing = new Map<string, string>();
  /** One pass, take or event at a time, so two never decide the same issue at once. */
  private chain: Promise<void> = Promise.resolve();

  constructor(private readonly hub: Hub) {}

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn);
    this.chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  // --- rows ---

  private get(repo: string, n: number): Kept | undefined {
    const row = this.hub.db.conn.query<Row, [string, number]>("SELECT * FROM issue_orders WHERE repo = ? AND number = ?").get(repo, n);
    return row ? kept(row) : undefined;
  }

  private put(k: Kept): void {
    this.hub.db.conn
      .query(
        `INSERT INTO issue_orders (repo, number, machine_id, project_id, workstream_id, data) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
           ON CONFLICT (repo, number) DO UPDATE SET machine_id = ?3, project_id = ?4, workstream_id = ?5, data = ?6`,
      )
      .run(k.repo, k.number, k.projectRef.machineId, k.projectRef.projectId, k.row.workstreamId ?? null, JSON.stringify(k.row));
  }

  private byWorkstream(w: string): Kept | undefined {
    const row = this.hub.db.conn.query<Row, [string]>("SELECT * FROM issue_orders WHERE workstream_id = ? LIMIT 1").get(w);
    return row ? kept(row) : undefined;
  }

  /** When the hub began watching `repo`, set now the first time. */
  private since(repo: string): number {
    const now = this.hub.clock.now();
    this.hub.db.conn.query("INSERT INTO issue_watch (repo, since_ms) VALUES (?, ?) ON CONFLICT (repo) DO NOTHING").run(repo, now);
    return this.hub.db.conn.query<{ since_ms: number }, [string]>("SELECT since_ms FROM issue_watch WHERE repo = ?").get(repo)?.since_ms ?? now;
  }

  /** A bot's switch turned on: labels its repos got while it was off are old, as on a first watch. */
  rewatch(r: ProjectRef): void {
    for (const repo of githubRepos(this.hub, r)) this.hub.db.conn.query("DELETE FROM issue_watch WHERE repo = ?").run(repo);
  }

  private orderOpen(w: string | undefined): boolean {
    if (w === undefined) return false;
    const ws = workstreamGet(this.hub.db.conn, w);
    return ws !== undefined && !isClosed(ws.state);
  }

  // --- which bot ---

  /**
   * The repos the hub watches, each with the bot an issue there goes to: a bot with the switch on that isn't archived,
   * the one whose own directory is the repo first. Never a checkout another bot holds as one of its repos: it is
   * archived read-only by that (projects/repos.ts `holder`) with no archive time, its lead refused every start, and the
   * bot that holds it takes the issue.
   */
  watched(): Map<string, ProjectRef> {
    const out = new Map<string, { r: ProjectRef; own: boolean }>();
    for (const r of repos.cachedProjects(this.hub.db.conn)) {
      if (!on(this.hub, r) || projectSettings.kept(this.hub.db.conn, r)?.archivedAt !== undefined) continue;
      if (repos.holders(this.hub.db.conn, r).length > 0) continue;
      const ownKey = repos.own(this.hub.db.conn, r)?.repoKey;
      for (const repo of githubRepos(this.hub, r)) {
        const own = ownKey === `github.com/${repo}`;
        const was = out.get(repo);
        if (!was || (own && !was.own)) out.set(repo, { r, own });
      }
    }
    return new Map([...out].map(([repo, v]) => [repo, v.r]));
  }

  /** The bot `repo` belongs to for issues, or undefined when none watches it. */
  botFor(repo: string): ProjectRef | undefined {
    return this.watched().get(repo.toLowerCase());
  }

  // --- deciding ---

  /**
   * One event about an issue, from the poll or a webhook. `fresh`: it happened just now (a webhook), so it needs no
   * check against when the hub began watching. What it did, for logs and tests.
   */
  take(event: IssueEvent, fresh = false): Promise<string> {
    return this.serial(() => (event.kind === "labelled" ? this.labelled(event.issue, event.labelling, fresh) : this.closed(event.issue, event.by)));
  }

  private async labelled(issue: IssueSeen, labelling: Labelling, fresh: boolean): Promise<string> {
    const gh = this.github;
    const repo = issue.repo;
    const r = this.botFor(repo);
    if (!gh || !r) return "not watched";
    const was = this.get(repo, issue.number);
    const seen = triage(was?.row, labelling, fresh ? Number.NEGATIVE_INFINITY : this.since(repo), this.orderOpen(was?.row.workstreamId));
    if (seen === "again") {
      // Kept as seen at this update, so the poll doesn't read its labellings again until it moves.
      if (was && issue.updatedAt !== undefined && was.row.seenAt !== issue.updatedAt) this.put({ ...was, row: { ...was.row, seenAt: issue.updatedAt } });
      return "again";
    }
    const leave = (why: string): string => {
      // A row of an order keeps its order: the newer labelling is only noted as left.
      const row: IssueRow = {
        ...(was?.row ?? {}),
        state: was?.row.state === "order" ? "order" : "left",
        labellingId: labelling.id,
        labelledAt: labelling.at,
        labelledBy: labelling.actor,
        why,
        ...seenAt(issue),
      };
      this.put({ repo, number: issue.number, projectRef: was?.projectRef ?? r, row });
      return `left: ${why}`;
    };
    if (seen === "old") return leave("it was labelled before fleetd watched the repo");
    const writes = !labelling.actorIsBot && (await gh.canWrite(repo, labelling.actor));
    const why = refusal(issue, labelling, writes, on(this.hub, r));
    if (why !== undefined) return leave(why);
    const { workstreamId } = intake(this.hub).intake({
      projectRef: r,
      text: orderText(issue, labelling),
      clientRequestId: `issue:${repo}#${issue.number}:${labelling.id}`,
      channel: "issue",
      by: `github:${labelling.actor}`,
    });
    this.put({ repo, number: issue.number, projectRef: r, row: { state: "order", labellingId: labelling.id, labelledAt: labelling.at, labelledBy: labelling.actor, workstreamId, ...seenAt(issue) } });
    void leads(this.hub)
      .autoStart(r)
      .catch((error) => console.warn(`issues: the lead of ${keyOf(r)} not started for ${workstreamId}:`, (error as Error).message));
    await this.tellStarted(repo, issue.number);
    return `opened ${workstreamId}`;
  }

  /** The started comment, once; a failure is tried again on the next pass. */
  private async tellStarted(repo: string, n: number): Promise<void> {
    const k = this.get(repo, n);
    const w = k?.row.workstreamId;
    if (!k || !this.github || k.row.state !== "order" || k.row.started || w === undefined) return;
    const bot = store(this.hub).projectGet(k.projectRef)?.title ?? k.projectRef.projectId;
    try {
      await this.github.comment(repo, n, startedComment({ number: n }, w, bot));
    } catch (error) {
      console.warn(`issues: ${repo}#${n} not told its order started:`, (error as Error).message);
      return;
    }
    this.put({ ...k, row: { ...k.row, started: true } });
  }

  private async closed(issue: IssueSeen, by: string | undefined): Promise<string> {
    const k = this.get(issue.repo, issue.number);
    const w = k?.row.workstreamId;
    if (!k || k.row.state !== "order" || w === undefined || k.row.closedTold) return "not an open order";
    if (!this.orderOpen(w)) return "its order is closed";
    // A person's merge on GitHub closes it by the PR's `Fixes` line, maybe before the train reads the merge: that
    // PR's landing comment goes now.
    if ((k.row.landed ?? []).length === 0) await this.landedOnGitHub(k.projectRef, w);
    const now = this.get(issue.repo, issue.number) ?? k;
    // Closed by its own PR's `Fixes` line, or after part of the work landed: the lead sees the landing already.
    this.put({ ...now, row: { ...now.row, closedTold: true } });
    if ((now.row.landed ?? []).length > 0) return "landed already";
    leadWakes(this.hub).trigger(k.projectRef, { kind: "line", line: "issue", text: closedLine(issue, w, by) });
    return `told the lead of ${w}`;
  }

  /** The order's PRs the train hasn't seen merge that GitHub says merged, each given its landing comment. */
  private async landedOnGitHub(r: ProjectRef, w: string): Promise<void> {
    const gh = this.github;
    if (!gh) return;
    for (const c of changeRecords(this.hub).ofWorkstream(r, w)) {
      if (c.state === "merged") continue;
      let merge: { sha?: string } | undefined;
      try {
        merge = await gh.pullMerge(c.repo, c.prNumber);
      } catch (error) {
        console.warn(`issues: ${c.repo}#${c.prNumber} not read:`, (error as Error).message);
        continue;
      }
      if (merge) await this.merged({ workstreamId: w, repo: c.repo, prNumber: c.prNumber, ...(merge.sha ? { mergedSha: merge.sha } : {}) });
    }
  }

  // --- the train's side ---

  /** The `Fixes` line for a PR of `workstreamId` in `prRepo`, or undefined when the order isn't an issue's. */
  fixesFor(workstreamId: string, prRepo: string): string | undefined {
    const k = this.byWorkstream(workstreamId);
    return k && k.row.state === "order" ? fixesLine(k, prRepo) : undefined;
  }

  /** A PR of an issue's order joined the train: its description gets the `Fixes` line if it lacks it. */
  private async queued(workstreamId: string, prRepo: string, pr: number): Promise<void> {
    const k = this.byWorkstream(workstreamId);
    if (!k || k.row.state !== "order" || !this.github) return;
    const body = await this.github.pullBody(prRepo, pr);
    if (closes(body, k, prRepo)) return;
    await this.github.setPullBody(prRepo, pr, withFixes(body, k, prRepo));
  }

  /** A PR of an issue's order landed: one comment on the issue for it. */
  private async merged(data: { workstreamId: string; repo: string; prNumber: number; mergedSha?: string; batchPr?: number }): Promise<void> {
    const k = this.byWorkstream(data.workstreamId);
    if (!k || k.row.state !== "order" || !this.github) return;
    const url = `https://github.com/${data.repo}/pull/${data.prNumber}`;
    if ((k.row.landed ?? []).includes(url)) return;
    await this.github.comment(k.repo, k.number, landedComment(data.repo, k.repo, data.prNumber, data.mergedSha, data.batchPr));
    this.put({ ...k, row: { ...k.row, landed: [...(k.row.landed ?? []), url] } });
  }

  /** The hub's events the area follows: a PR of an issue's order joining the train, and landing. */
  follow(): void {
    const unsubscribe = events(this.hub).subscribe((event) => {
      if (event.type !== "change.queued" && event.type !== "pr.merged") return;
      const d = (event.data ?? {}) as { workstreamId?: unknown; repo?: unknown; prNumber?: unknown; mergedSha?: unknown; batchPr?: unknown };
      if (typeof d.workstreamId !== "string" || typeof d.repo !== "string" || typeof d.prNumber !== "number") return;
      const data = {
        workstreamId: d.workstreamId,
        repo: d.repo,
        prNumber: d.prNumber,
        ...(typeof d.mergedSha === "string" ? { mergedSha: d.mergedSha } : {}),
        ...(typeof d.batchPr === "number" ? { batchPr: d.batchPr } : {}),
      };
      const what = event.type === "change.queued" ? "its Fixes line" : "its landing comment";
      void this.serial(() => (event.type === "change.queued" ? this.queued(data.workstreamId, data.repo, data.prNumber) : this.merged(data))).catch((error) =>
        console.warn(`issues: ${data.repo}#${data.prNumber} not given ${what}:`, (error as Error).message),
      );
    });
    this.hub.shutdown.signal.addEventListener("abort", unsubscribe, { once: true });
  }

  // --- the self-hosted poll ---

  /** One pass over every watched repo: new labellings, started comments still owed, and closes. */
  poll(): Promise<void> {
    return this.serial(async () => {
      const gh = this.github;
      if (!gh) return;
      for (const repo of this.watched().keys()) {
        try {
          await this.pollRepo(gh, repo);
          this.failing.delete(repo);
        } catch (error) {
          const why = (error as Error).message;
          if (this.failing.get(repo) !== why) console.warn(`issues: ${repo} not read:`, why);
          this.failing.set(repo, why);
        }
      }
    });
  }

  private async pollRepo(gh: IssueGitHub, repo: string): Promise<void> {
    // The first pass over a repo starts its watch: labels from before it are old.
    this.since(repo);
    const open = (await gh.labelledOpen(repo)).filter((i) => labelledFleetd(i.labels));
    for (const issue of open) {
      const was = this.get(repo, issue.number);
      // Nothing new can be on an issue whose order runs; one already left waits for a newer labelling, so it is read
      // only when GitHub's update time moved past the labelling it was left on.
      if (was && was.row.state === "order" && this.orderOpen(was.row.workstreamId)) {
        if (!was.row.started) await this.tellStarted(repo, issue.number);
        continue;
      }
      if (was && issue.updatedAt !== undefined && was.row.seenAt === issue.updatedAt) continue;
      const latest = (await gh.labellings(repo, issue.number)).at(-1);
      if (latest) await this.labelled(issue, latest, false);
    }
    const shown = new Set(open.map((i) => i.number));
    const rows = this.hub.db.conn
      .query<Row, [string]>("SELECT * FROM issue_orders WHERE repo = ? AND workstream_id IS NOT NULL ORDER BY number")
      .all(repo)
      .map(kept)
      .filter((k) => k.row.state === "order" && !k.row.closedTold && !shown.has(k.number) && this.orderOpen(k.row.workstreamId));
    for (const k of rows.slice(0, CLOSE_CHECKS)) {
      const now = await gh.issue(repo, k.number);
      if (now?.issue.state === "closed") await this.closed(now.issue, now.closedBy);
    }
  }

  /** Resolves once every pass, take and event begun so far has run. */
  settled(): Promise<void> {
    return this.chain;
  }

  /** Starts the poll and the event follower until the hub stops. `poll` false: webhooks feed `take` instead. */
  start(poll: boolean): void {
    this.follow();
    if (poll) every(this.hub, POLL_MS, () => this.poll());
  }
}

const seenAt = (issue: IssueSeen) => (issue.updatedAt !== undefined ? { seenAt: issue.updatedAt } : {});

function kept(row: Row): Kept {
  return {
    repo: row.repo,
    number: row.number,
    projectRef: { machineId: row.machine_id, projectId: row.project_id },
    row: JSON.parse(row.data) as IssueRow,
  };
}

/** The bot's repos on GitHub, `owner/name` lowercased. */
export function githubRepos(hub: Hub, r: ProjectRef): string[] {
  const out: string[] = [];
  for (const x of repos.of(hub.db.conn, r)) {
    const key = x.repoKey;
    if (key?.startsWith("github.com/") && key.split("/").length === 3) {
      const repo = key.slice("github.com/".length);
      if (!out.includes(repo)) out.push(repo);
    }
  }
  return out;
}

/** Whether the bot's switch is on: on unless a person turned it off. */
export function on(hub: Hub, r: ProjectRef): boolean {
  return projectSettings.issueOrdersOn(hub.db.conn, r);
}

/** The hub's issues area, `hub.area("issues")`. */
export const issueOrders = (hub: Hub) => hub.area("issues", (h) => new IssueOrders(h));

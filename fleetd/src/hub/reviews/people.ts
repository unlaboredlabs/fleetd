// People's reviews on GitHub, on the PRs in the train. One GraphQL query reads every open Change's PR of a repo (20 to
// a query): each person's latest say on it and its review threads. A person's say is open, as GitHub counts it, while
// their latest review that approves, requests changes or was dismissed requests changes; a thread is open while it is
// unresolved and a person started it. A person is the repo's owner, a member of its organization or a collaborator, as
// GitHub counts a review: anyone else's say, on a public repo, is no finding. Bots, and what fleetd itself posted
// (marked), are never a person's. A plain
// comment, or a review that only comments, is no finding: only its line comments are, as threads. The writer replies as
// the PR's author, so the author's later comments on a thread are shown with it but never sent as new: nothing loops.
//
// The gate (service.ts) holds a Change while any is open and sends each new one to its writer as review findings.
// A read that fails backs off, doubling, and holds nothing: what the last good read found stays.
import type { Database } from "bun:sqlite";
import type { Change, ChangeState } from "../../shared/contracts.ts";
import { redact } from "../../shared/redact.ts";
import { TRAIN_MARK } from "../train/github.ts";
import { Repeats, warnHourly } from "../train/repeats.ts";
import { clip } from "../train/seams.ts";
import type { Train } from "../train/service.ts";
import { prKey } from "./verdicts.ts";

/** The hidden line on the agent's review fleetd posts on a PR (post.ts): never read back as a person's. */
export const REVIEW_MARK = "<!-- fleetd:review -->";
/** The start of a Change's `lastError` while people's reviews on GitHub hold it. */
export const PEOPLE_HOLD = "waiting for people's reviews on GitHub: ";

/** The Changes whose PRs are read: in review, in the train, or back with their writer. */
export const WATCHED: ChangeState[] = ["reviewing", "ready", "rebasing", "ci", "merging", "needs_rebase", "ci_failed"];
/** How often each repo is read. */
export const POLL_MS = 60_000;
/** The read the gate takes before it calls a Change ready is at most this old. */
export const FRESH_MS = 30_000;
const BACKOFF_FIRST_MS = 60_000;
const BACKOFF_MAX_MS = 30 * 60_000;
/** PRs per query: GitHub's cost stays a few points a query. */
const CHUNK = 20;
const THREADS = 50;
const COMMENTS = 20;
const TEXT_MAX = 1500;

/** One open finding of a person's: a review that requests changes, or an unresolved thread they started. */
export type PersonFinding = {
  kind: "changes" | "thread";
  /** Who started it. */
  by: string;
  url: string;
  /** A thread's file and line (`line` absent once the line is gone from the diff). */
  path?: string;
  line?: number;
  outdated?: boolean;
  /** The review's body, or each person's comment on the thread, oldest first. */
  said: { by: string; text: string }[];
  /** What GitHub calls the review (`review:<id>`) and each comment (`comment:<id>`): sent once each. */
  keys: string[];
  /** A thread's first comment, which a reply answers. */
  replyTo?: number;
};

type Author = { login?: unknown; __typename?: unknown } | null | undefined;

/** A bot (GitHub Apps, Dependabot, Copilot), or an account that is gone. */
export function isBot(author: Author): boolean {
  const login = typeof author?.login === "string" ? author.login : "";
  return login === "" || author?.__typename === "Bot" || login.endsWith("[bot]");
}

/** Whom GitHub lets review the repo: its owner, its organization's members, its collaborators. */
const REVIEWERS = ["OWNER", "MEMBER", "COLLABORATOR"];

/** A person who reviews the repo, not a bot or a passer-by. */
const reviewer = (n: { author?: Author; authorAssociation?: unknown }) => !isBot(n.author) && REVIEWERS.includes(text(n.authorAssociation));

/** What fleetd posted itself: the agent's review, the train's comments. */
const ours = (body: string) => body.includes(REVIEW_MARK) || body.includes(TRAIN_MARK);

/** The query for PRs `numbers` of the repo in `$owner/$name`. */
export function peopleQuery(numbers: number[]): string {
  const prs = numbers.map((n) => `p${n}: pullRequest(number: ${Math.trunc(n)}) { ...F }`).join(" ");
  return (
    `query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { ${prs} } } ` +
    "fragment F on PullRequest { author { login } reviews(last: 100) { nodes { databaseId state body url authorAssociation author { login __typename } } } " +
    `reviewThreads(last: ${THREADS}) { nodes { isResolved isOutdated path line originalLine ` +
    `comments(first: ${COMMENTS}) { nodes { databaseId body url authorAssociation author { login __typename } } } } } }`
  );
}

type ReviewNode = { databaseId?: unknown; state?: unknown; body?: unknown; url?: unknown; authorAssociation?: unknown; author?: Author };
type CommentNode = { databaseId?: unknown; body?: unknown; url?: unknown; authorAssociation?: unknown; author?: Author };
type ThreadNode = { isResolved?: unknown; isOutdated?: unknown; path?: unknown; line?: unknown; originalLine?: unknown; comments?: { nodes?: CommentNode[] } };
type PullNode = { author?: Author; reviews?: { nodes?: ReviewNode[] }; reviewThreads?: { nodes?: ThreadNode[] } } | null;

const text = (v: unknown) => (typeof v === "string" ? v : "");
const num = (v: unknown) => (typeof v === "number" && Number.isInteger(v) ? v : undefined);
const said = (by: string, body: string) => ({ by, text: clip(redact(body.trim()), TEXT_MAX) });

/** Each PR's open findings, from the query's `data`: none for a PR GitHub didn't return. */
export function readPeople(data: unknown, numbers: number[]): Map<number, PersonFinding[]> {
  const repo = (data as { repository?: Record<string, PullNode> } | null)?.repository ?? {};
  const out = new Map<number, PersonFinding[]>();
  for (const n of numbers) out.set(n, openFindings(repo[`p${n}`] ?? null));
  return out;
}

/** A PR's open findings: each person's request for changes still standing, then their unresolved threads. */
export function openFindings(pull: PullNode): PersonFinding[] {
  const out: PersonFinding[] = [];
  // Each person's latest say, in the order GitHub gave the reviews: a review that only comments says nothing.
  const latest = new Map<string, ReviewNode>();
  for (const r of pull?.reviews?.nodes ?? []) {
    if (!r || !reviewer(r) || ours(text(r.body))) continue;
    if (r.state === "APPROVED" || r.state === "CHANGES_REQUESTED" || r.state === "DISMISSED") latest.set(text(r.author?.login), r);
  }
  for (const [by, r] of latest) {
    const id = num(r.databaseId);
    if (r.state !== "CHANGES_REQUESTED" || id === undefined) continue;
    out.push({ kind: "changes", by, url: text(r.url), said: text(r.body).trim() === "" ? [] : [said(by, text(r.body))], keys: [`review:${id}`] });
  }
  for (const t of pull?.reviewThreads?.nodes ?? []) {
    if (!t || t.isResolved !== false) continue;
    const comments = (t.comments?.nodes ?? []).filter((c): c is CommentNode => c != null);
    const first = comments[0];
    if (!first || !reviewer(first) || ours(text(first.body))) continue;
    const people = comments.filter((c) => reviewer(c) && !ours(text(c.body)) && num(c.databaseId) !== undefined);
    const author = text(pull?.author?.login);
    const sent = people.filter((c, i) => i === 0 || author === "" || text(c.author?.login) !== author);
    const line = num(t.line);
    const f: PersonFinding = {
      kind: "thread",
      by: text(first.author?.login),
      url: text(first.url),
      path: text(t.path),
      said: people.map((c) => said(text(c.author?.login), text(c.body))),
      keys: sent.map((c) => `comment:${num(c.databaseId)}`),
    };
    if (line !== undefined) f.line = line;
    else if (num(t.originalLine) !== undefined) f.line = num(t.originalLine);
    if (t.isOutdated === true || line === undefined) f.outdated = true;
    const replyTo = num(first.databaseId);
    if (replyTo !== undefined) f.replyTo = replyTo;
    out.push(f);
  }
  return out;
}

/** "@ana requested changes; 2 unresolved threads (@ana, @ben)". */
export function holdWhy(findings: PersonFinding[]): string {
  const asked = [...new Set(findings.filter((f) => f.kind === "changes").map((f) => `@${f.by}`))];
  const threads = findings.filter((f) => f.kind === "thread");
  const parts: string[] = [];
  if (asked.length > 0) parts.push(`${asked.join(", ")} requested changes`);
  if (threads.length > 0) {
    const who = [...new Set(threads.map((f) => `@${f.by}`))].join(", ");
    parts.push(`${threads.length} unresolved review ${threads.length === 1 ? "thread" : "threads"} (${who})`);
  }
  return parts.join("; ");
}

/** Where a finding is, as a reviewer names it. */
function where(f: PersonFinding): string {
  if (f.kind === "changes") return "the whole PR";
  const at = f.line === undefined ? f.path ?? "" : `${f.path}:${f.line}`;
  return f.outdated ? `${at} (outdated: the line changed since)` : at;
}

/** The findings as the writer gets them: each with where it is, who said it, what they said, and how to answer. */
export function findingsText(change: Change, findings: PersonFinding[]): string {
  const blocks = findings.map((f) => {
    const head = `- ${where(f)}, ${f.kind === "changes" ? `@${f.by} requested changes` : `thread by @${f.by}`} (blocking) ${f.url}`;
    const lines = f.said.map((s) => `  @${s.by}: ${s.text.split("\n").join("\n    ")}`);
    if (f.kind === "thread" && f.replyTo !== undefined) {
      lines.push(`  Reply: gh api repos/${change.repo}/pulls/${change.prNumber}/comments/${f.replyTo}/replies -f body='…'`);
    }
    if (f.kind === "changes") lines.push(`  Reply: gh pr comment ${change.prNumber} --repo ${change.repo} --body '…'`);
    return [head, ...lines].join("\n");
  });
  return (
    `People reviewed it on GitHub; each of these is a blocking finding:\n\n${blocks.join("\n\n")}\n\n` +
    "Fix each one and push, then answer it on GitHub: reply on its thread (or on the PR, for a review) saying what " +
    "you changed, or why you didn't. Never resolve a person's thread or dismiss their review: the merge waits until " +
    "they resolve it, approve, or dismiss it themselves. `review_read` lists what is still open."
  );
}

// --- what each read found, kept per PR ---

/** The PR's open findings as its last good read found them. */
export function openOf(db: Database, pr: string): PersonFinding[] {
  let row: { data: string } | null;
  try {
    row = db.query<{ data: string }, [string]>("SELECT data FROM review_people WHERE pr_key = ?1").get(prKey(pr));
  } catch {
    return [];
  }
  try {
    return row ? (JSON.parse(row.data) as PersonFinding[]) : [];
  } catch {
    return [];
  }
}

/** Reads people's reviews on the train's PRs; each repo at most once in its interval, backing off after a failure. */
export class People {
  /** When each repo was last read whole. */
  private readonly readAt = new Map<string, number>();
  private readonly backoff = new Map<string, { failures: number; untilMs: number }>();
  private readonly repeats = new Repeats();

  constructor(private readonly train: Train) {}

  private get db(): Database {
    return this.train.records.db.conn;
  }

  /**
   * Reads the repo's watched PRs unless its last read is under `maxAgeMs` old, or it is backing off. Whether what is
   * kept is that fresh now; a failed read changes nothing kept.
   */
  async read(repo: string, maxAgeMs: number): Promise<boolean> {
    const key = repo.toLowerCase();
    const now = this.train.nowMs();
    const last = this.readAt.get(key);
    if (last !== undefined && now - last < maxAgeMs) return true;
    const off = this.backoff.get(key);
    if (off && now < off.untilMs) return false;
    const changes = this.train.records.inTrain(repo, WATCHED);
    const numbers = [...new Set(changes.map((c) => c.prNumber))];
    const [owner, name] = changes[0]?.repo.split("/") ?? key.split("/");
    try {
      for (let i = 0; i < numbers.length; i += CHUNK) {
        const chunk = numbers.slice(i, i + CHUNK);
        const data = await this.train.github.graphql(peopleQuery(chunk), [
          ["owner", owner ?? ""],
          ["name", name ?? ""],
        ]);
        for (const [n, found] of readPeople(data, chunk)) {
          const change = changes.find((c) => c.prNumber === n)!;
          this.db
            .query("INSERT OR REPLACE INTO review_people (pr_key, read_ms, data) VALUES (?1, ?2, ?3)")
            .run(prKey(change.prUrl), now, JSON.stringify(found));
        }
      }
    } catch (error) {
      const failures = (off?.failures ?? 0) + 1;
      const wait = Math.min(BACKOFF_FIRST_MS * 2 ** Math.min(failures - 1, 10), BACKOFF_MAX_MS);
      this.backoff.set(key, { failures, untilMs: now + wait });
      const why = (error as Error)?.message ?? String(error);
      warnHourly(this.repeats, now, ["reviews: people's reviews not read", key], why, `reviews: people's reviews on ${repo} not read (next try in ${wait / 1000} s): ${why}`);
      return false;
    }
    this.backoff.delete(key);
    this.repeats.clear(["reviews: people's reviews not read", key].join(" "));
    this.readAt.set(key, now);
    return true;
  }

  open(pr: string): PersonFinding[] {
    return openOf(this.db, pr);
  }

  /** The findings with something not sent to the writer yet. */
  unsent(pr: string, findings: PersonFinding[]): PersonFinding[] {
    const sent = new Set(
      this.db
        .query<{ key: string }, [string]>("SELECT key FROM review_people_sent WHERE pr_key = ?1")
        .all(prKey(pr))
        .map((r) => r.key),
    );
    return findings.filter((f) => f.keys.some((k) => !sent.has(k)));
  }

  markSent(pr: string, findings: PersonFinding[]): void {
    const q = this.db.query("INSERT OR IGNORE INTO review_people_sent (pr_key, key) VALUES (?1, ?2)");
    for (const f of findings) for (const k of f.keys) q.run(prKey(pr), k);
  }
}

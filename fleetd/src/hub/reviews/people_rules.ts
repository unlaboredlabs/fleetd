// People's reviews on GitHub as the review gate reads them, without gh or the database (people.ts reads and keeps
// them): which states are watched and how often, the query and its answer read, which findings are open and from
// whom, and the words that hold a PR on them.
import type { Change, ChangeState } from "../../shared/contracts.ts";
import { redact } from "../../shared/redact.ts";
import { clip, TRAIN_MARK } from "../train/text.ts";

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
export const THREADS = 50;
export const COMMENTS = 20;
export const TEXT_MAX = 1500;

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

export type Author = { login?: unknown; __typename?: unknown } | null | undefined;

/** A bot (GitHub Apps, Dependabot, Copilot), or an account that is gone. */
export function isBot(author: Author): boolean {
  const login = typeof author?.login === "string" ? author.login : "";
  return login === "" || author?.__typename === "Bot" || login.endsWith("[bot]");
}

/** Whom GitHub lets review the repo: its owner, its organization's members, its collaborators. */
export const REVIEWERS = ["OWNER", "MEMBER", "COLLABORATOR"];

/** A person who reviews the repo, not a bot or a passer-by. */
export const reviewer = (n: { author?: Author; authorAssociation?: unknown }) => !isBot(n.author) && REVIEWERS.includes(text(n.authorAssociation));

/** What fleetd posted itself: the agent's review, the train's comments. */
export const ours = (body: string) => body.includes(REVIEW_MARK) || body.includes(TRAIN_MARK);

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

export type ReviewNode = { databaseId?: unknown; state?: unknown; body?: unknown; url?: unknown; authorAssociation?: unknown; author?: Author };
export type CommentNode = { databaseId?: unknown; body?: unknown; url?: unknown; authorAssociation?: unknown; author?: Author };
export type ThreadNode = { isResolved?: unknown; isOutdated?: unknown; path?: unknown; line?: unknown; originalLine?: unknown; comments?: { nodes?: CommentNode[] } };
export type PullNode = { author?: Author; reviews?: { nodes?: ReviewNode[] }; reviewThreads?: { nodes?: ThreadNode[] } } | null;

export const text = (v: unknown) => (typeof v === "string" ? v : "");
export const num = (v: unknown) => (typeof v === "number" && Number.isInteger(v) ? v : undefined);
export const said = (by: string, body: string) => ({ by, text: clip(redact(body.trim()), TEXT_MAX) });

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
export function where(f: PersonFinding): string {
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

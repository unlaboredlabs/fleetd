// The PR screens' words: a PR's state and where it is on its way to main, its checks and reviews, and who wrote it.
// Plain and state first. fleetd's merge queue shows only as where the PR is ("3rd in line to merge"), never by name,
// and never as the hub's raw states.
import type { AgentRole, ChangeState } from "../../../shared/contracts";
import type { ChecksSummary, PrAuthor, PrCheck, PrReviewEntry, PrRow } from "../../../shared/contracts";
import { profileWord } from "../../ui/primitives/profiles";
import { ROLE_WORD } from "../../ui/primitives/roles";

/** A state word's colour: the ui kit's status tones. */
export type Tone = "needs-you" | "failed" | "working" | "quiet" | "idle" | "done";

export interface StateLine {
  /** A word or two, for a list row. */
  readonly word: string;
  /** One sentence, for the PR's header. */
  readonly sentence: string;
  readonly tone: Tone;
}

const ordinal = (n: number): string => {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return `${n}th`;
  return `${n}${["th", "st", "nd", "rd"][n % 10] ?? "th"}`;
};

/** What each merge-queue state is, as a word and as the move it was (the PR's history). */
interface QueueWords {
  readonly word: string;
  readonly moved: string;
  readonly tone: Tone;
}

// Keyed by any string: a newer hub can send a state this build doesn't know.
const QUEUE: Readonly<Partial<Record<string, QueueWords>>> = {
  queued: { word: "waiting to merge", moved: "Lined up to merge", tone: "working" },
  reviewing: { word: "in review", moved: "Went to review", tone: "working" },
  ready: { word: "ready to merge", moved: "Passed review", tone: "working" },
  rebasing: { word: "updating", moved: "Updating to the latest main", tone: "working" },
  ci: { word: "final checks", moved: "Final checks started", tone: "working" },
  merging: { word: "merging", moved: "Merging", tone: "working" },
  merged: { word: "merged", moved: "Merged", tone: "done" },
  needs_rebase: { word: "conflicts", moved: "Conflicted with main", tone: "failed" },
  ci_failed: { word: "checks failed", moved: "Checks failed", tone: "failed" },
  refused: { word: "not merged", moved: "Turned away", tone: "failed" },
  abandoned: { word: "dropped", moved: "Dropped", tone: "idle" },
} satisfies Record<ChangeState, QueueWords>;

// The states a PR waits in line in: the list row and the PR's sentence both give its place only in these.
const IN_LINE: ReadonlySet<string> = new Set<ChangeState>(["queued", "reviewing", "ready"]);

/** Its 0-based place in line, when it is waiting in one. */
const lineAt = (q: PrRow["queue"]): number | undefined => (q?.position === undefined || !IN_LINE.has(q.state) ? undefined : q.position);

const queueSentence = (q: NonNullable<PrRow["queue"]>): string => {
  const at = lineAt(q);
  const place = at === undefined ? "" : q.length > 1 ? `, ${ordinal(at + 1)} of ${q.length} in line` : ", next in line";
  switch (q.state) {
    case "queued":
      return `Waiting to merge${place}.`;
    case "reviewing":
      return `In review${place}. It merges once its reviews and checks pass.`;
    case "ready":
      return `Ready to merge${place}.`;
    case "rebasing":
      return "Updating to the latest main before it merges.";
    case "ci":
      return "Running its checks on the latest main before it merges.";
    case "merging":
      return "Merging now.";
    case "merged":
      return "Merged.";
    case "needs_rebase":
      return "Conflicts with main. It merges once an agent updates it.";
    case "ci_failed":
      return "Checks failed, so it won't merge until they pass.";
    case "refused":
      return "Turned away before merging.";
    case "abandoned":
      return "Dropped. It won't merge.";
  }
};

/** Where the PR is on its way to main: GitHub's state, then fleetd's queue for an open PR. */
export const stateLine = (pr: Pick<PrRow, "state" | "queue">): StateLine => {
  if (pr.state === "merged") return { word: "merged", sentence: "Merged.", tone: "done" };
  if (pr.state === "closed") return { word: "closed", sentence: "Closed without merging.", tone: "idle" };
  if (pr.state === "draft") return { word: "draft", sentence: "A draft, not ready for review yet.", tone: "quiet" };
  const q = pr.queue;
  const known = q === undefined ? undefined : QUEUE[q.state];
  if (q === undefined || known === undefined) return { word: "open", sentence: "Open. fleetd isn't merging it.", tone: "quiet" };
  return { word: known.word, sentence: queueSentence(q), tone: known.tone };
};

export const isOpen = (r: Pick<PrRow, "state">): boolean => r.state === "open" || r.state === "draft";

export const openCount = (rows: readonly Pick<PrRow, "state">[]): number => rows.filter(isOpen).length;

/**
 * What a list GitHub didn't answer is missing. Checks come only from GitHub, so a row with them means the hub kept
 * an earlier answer (a rate limit, a blip): the list is GitHub's, maybe out of date. Without any, it is fleetd's own.
 */
export const githubLine = (rows: readonly Pick<PrRow, "checks">[]): string =>
  rows.some((r) => r.checks !== undefined)
    ? "GitHub didn’t answer just now, so checks and reviews may be out of date."
    : "GitHub couldn’t be reached, so these are only the PRs fleetd made, without checks.";

/** A history step, "Checks failed"; undefined for a state this build doesn't know. */
export const movedWords = (to: string): string | undefined => QUEUE[to]?.moved;

/** "All 9 checks passed", "2 checks failed", "3 checks running"; undefined when none ran. */
export const checksWord = (c: ChecksSummary): { readonly text: string; readonly tone: Tone } | undefined => {
  if (c.failed > 0) return { text: `${c.failed} ${c.failed === 1 ? "check" : "checks"} failed`, tone: "failed" };
  if (c.pending > 0) return { text: `${c.pending} ${c.pending === 1 ? "check" : "checks"} running`, tone: "working" };
  if (c.passed > 0) return { text: c.passed === 1 ? "1 check passed" : `All ${c.passed} checks passed`, tone: "done" };
  return undefined;
};

/** A list row's checks, short beside their icon: "2 failed", "1 running", "6 passed"; undefined when none ran. */
export const checksShort = (c: ChecksSummary): { readonly text: string; readonly tone: Tone } | undefined => {
  if (c.failed > 0) return { text: `${c.failed} failed`, tone: "failed" };
  if (c.pending > 0) return { text: `${c.pending} running`, tone: "working" };
  if (c.passed > 0) return { text: `${c.passed} passed`, tone: "done" };
  return undefined;
};

/** An open PR's place in line to merge: "next in line", "3rd in line"; undefined when it isn't waiting in it. */
export const placeWord = (q: PrRow["queue"]): string | undefined => {
  const at = lineAt(q);
  if (at === undefined) return undefined;
  return at === 0 ? "next in line" : `${ordinal(at + 1)} in line`;
};

/** "7 passed · 2 failed · 1 running". */
export const checksDetail = (c: ChecksSummary): string =>
  [c.passed > 0 ? `${c.passed} passed` : "", c.failed > 0 ? `${c.failed} failed` : "", c.pending > 0 ? `${c.pending} running` : ""]
    .filter(Boolean)
    .join(" · ");

/** A check's word: GitHub's conclusion when it says more than the state ("skipped", "timed out"). */
export const checkWord = (c: PrCheck): { readonly text: string; readonly tone: Tone } => {
  const conclusion = c.conclusion?.replaceAll("_", " ");
  if (c.state === "failing") return { text: conclusion !== undefined && conclusion !== "failure" ? conclusion : "failed", tone: "failed" };
  if (c.state === "pending") return { text: "running", tone: "working" };
  if (c.state === "passing") return { text: conclusion !== undefined && conclusion !== "success" ? conclusion : "passed", tone: "done" };
  return { text: conclusion ?? "didn't run", tone: "idle" };
};

const CHECK_RANK: Readonly<Record<string, number>> = { failing: 0, pending: 1, passing: 2, none: 3 };

/** Failed first, then running, then passed, then the rest; in GitHub's order within each. */
export const sortChecks = (checks: readonly PrCheck[]): PrCheck[] =>
  checks
    .map((c, i) => ({ c, i }))
    .sort((a, b) => (CHECK_RANK[a.c.state] ?? 4) - (CHECK_RANK[b.c.state] ?? 4) || a.i - b.i)
    .map(({ c }) => c);

/** How long a check took, when it finished. */
export const checkTook = (c: PrCheck): string | undefined => {
  const start = c.startedAt === undefined ? Number.NaN : Date.parse(c.startedAt);
  const end = c.completedAt === undefined ? Number.NaN : Date.parse(c.completedAt);
  return Number.isNaN(start) || Number.isNaN(end) || end < start ? undefined : duration(end - start);
};

/** "Reviews 1 of 3", "Approved"; undefined when nothing asks for a review. */
export const reviewsWord = (r: PrRow["review"]): { readonly text: string; readonly tone: Tone } | undefined => {
  if (r.state === "changes_requested") return { text: "Changes asked for", tone: "failed" };
  if (r.needed > 0 && r.done < r.needed) return { text: `Reviews ${r.done} of ${r.needed}`, tone: "working" };
  if (r.state === "approved" || (r.needed > 0 && r.done >= r.needed)) return { text: "Approved", tone: "done" };
  if (r.state === "pending") return { text: "Review asked for", tone: "working" };
  return undefined;
};

// The app's one word per role (ui ROLE_WORD), with the article a line starts with.
const ROLE: Readonly<Partial<Record<string, string>>> = {
  lead: `The ${ROLE_WORD.lead}`,
  implementer: `A ${ROLE_WORD.implementer}`,
  reader: `A ${ROLE_WORD.reader}`,
  reviewer: `A ${ROLE_WORD.reviewer}`,
  verifier: `A ${ROLE_WORD.verifier}`,
  qa: `A ${ROLE_WORD.qa} agent`,
} satisfies Record<AgentRole, string>;

const agentWords = (a: PrAuthor): string | undefined => {
  if (a.role === undefined) return undefined;
  const who = ROLE[a.role] ?? "An agent";
  return a.profile === undefined ? who : `${who} (${profileWord(a.profile)})`;
};

/** To start a line: "A writer (high)", or a login as GitHub spells it, "sam on GitHub"; undefined when the hub knows neither. */
export const authorWords = (a: PrAuthor): string | undefined => agentWords(a) ?? (a.login === undefined ? undefined : `${a.login} on GitHub`);

/** To start a line: "A reviewer (high)", "sam on GitHub", "Someone on GitHub". */
export const reviewerWords = (r: PrReviewEntry): string =>
  (r.agent === undefined ? undefined : agentWords(r.agent)) ?? (r.login === undefined ? "Someone on GitHub" : `${r.login} on GitHub`);

export const VERDICT_WORD: Readonly<Record<string, { readonly text: string; readonly tone: Tone }>> = {
  approved: { text: "approved", tone: "done" },
  changes_requested: { text: "asked for changes", tone: "failed" },
  commented: { text: "commented", tone: "quiet" },
  dismissed: { text: "dismissed", tone: "idle" },
};

export const verdictWord = (r: PrReviewEntry): { readonly text: string; readonly tone: Tone } =>
  VERDICT_WORD[r.verdict] ?? { text: "reviewed", tone: "quiet" };

/** "2 blocking, 1 suggestion"; empty for a person's review and a clean one. */
export const findingsWord = (r: PrReviewEntry): string => {
  const blocking = r.blocking ?? 0;
  const other = r.nonBlocking ?? 0;
  return [blocking > 0 ? `${blocking} blocking` : "", other > 0 ? `${other} ${other === 1 ? "suggestion" : "suggestions"}` : ""].filter(Boolean).join(", ");
};

/** "1h 05m", "14m", "40s". */
export const duration = (ms: number): string => {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
};

/** "+1.2k": a diff stat's figure. */
export const stat = (n: number): string => {
  if (n < 1000) return String(n);
  if (n < 10_000) return `${(Math.floor(n / 100) / 10).toFixed(1).replace(/\.0$/u, "")}k`;
  return `${Math.round(n / 1000)}k`;
};

const formats = new Map<string, Intl.DateTimeFormat>();
const format = (opts: Intl.DateTimeFormatOptions, timeZone: string | undefined): Intl.DateTimeFormat => {
  const key = `${JSON.stringify(opts)}${timeZone ?? ""}`;
  let f = formats.get(key);
  if (f === undefined) {
    f = new Intl.DateTimeFormat("en-GB", { ...opts, ...(timeZone === undefined ? {} : { timeZone }) });
    formats.set(key, f);
  }
  return f;
};

/** "09:46" today, "Sat 09:46" this week, "12 Oct" before; in local time. */
export const when = (iso: string, nowMs: number, timeZone?: string): string => {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return "";
  const day = (t: number) => format({ year: "numeric", month: "2-digit", day: "2-digit" }, timeZone).format(t);
  const hm = { hour: "2-digit", minute: "2-digit", hourCycle: "h23" } as const;
  if (day(ms) === day(nowMs)) return format(hm, timeZone).format(ms);
  if (ms <= nowMs && nowMs - ms < 6 * 86_400_000) return format({ weekday: "short", ...hm }, timeZone).format(ms);
  return format({ day: "numeric", month: "short" }, timeZone).format(ms);
};

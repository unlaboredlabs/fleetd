// What watchers decide without the hub: their presets and frequencies, the evidence a preset's run is given (from
// GitHub's answers), whether it changed since the last look, the session's message, its answer read as quiet or one
// line to post, and a watcher's last day of runs. index.ts gathers the evidence, runs the sessions and keeps the runs.
import type { AutomationRun, AutomationUsage, AutomationWatch, KnownWatchEvery, KnownWatchKind } from "../../shared/contracts.ts";
import { ToolError } from "../../shared/errors.ts";
import { isoMs, parseMs } from "../store/time.ts";

export const WATCH_KINDS: readonly KnownWatchKind[] = ["main_ci", "deploys", "other", "checkin"];
export const PRESETS: readonly KnownWatchKind[] = ["main_ci", "deploys"];
export const EVERY: readonly KnownWatchEvery[] = ["15m", "hour", "day"];

/** Each frequency's cron, in the person's zone: a day's look is at 09:00. */
export const EVERY_CRON: Record<KnownWatchEvery, string> = { "15m": "*/15 * * * *", hour: "0 * * * *", day: "0 9 * * *" };

/** A preset's name, which its row and chat line show. */
export const PRESET_NAME: Record<string, string> = { main_ci: "Main's CI", deploys: "Deploys", checkin: "Daily check-in" };

/** A run's session is stopped and the run failed after this long. */
export const RUN_LIMIT_MS = 10 * 60_000;
/** The longest line a watcher posts. */
export const LINE_MAX = 300;
/** A run that hasn't finished in this long counts again once it has run another stretch as long (`seenKey`). */
const SLOW_STEP_MS = 30 * 60_000;
const DAY_MS = 86_400_000;
/** The checks a preset's evidence lists one by one; the rest are counted. */
const LISTED = 20;

const invalid = (message: string, fix: string) => new ToolError("invalid", message, fix);

/** The watch as given, checked: a kind and a frequency this hub knows. */
export function checkWatch(w: AutomationWatch): AutomationWatch {
  if (!WATCH_KINDS.includes(w.kind as KnownWatchKind)) {
    throw invalid(`'${w.kind}' is not something a watcher watches.`, "Use main_ci, deploys, or other with one plain sentence as the prompt.");
  }
  if (!EVERY.includes(w.every as KnownWatchEvery)) throw invalid(`'${w.every}' is not a watcher's frequency.`, "Use 15m, hour or day.");
  // The daily check-in is daily.
  if (w.kind === "checkin" && w.every !== "day") throw invalid("The daily check-in runs once a day.", "Use every day.");
  return { kind: w.kind, every: w.every, ...(w.profile === undefined ? {} : { profile: w.profile }) };
}

export const cronOf = (w: AutomationWatch) => EVERY_CRON[w.every as KnownWatchEvery] ?? EVERY_CRON.hour;

/** What a preset's name and prompt are; `other` keeps the person's sentence, named by its start. */
export function named(w: AutomationWatch, sentence: string): { name: string; prompt: string } {
  const preset = PRESET_NAME[w.kind];
  if (preset !== undefined) return { name: preset, prompt: preset };
  const flat = sentence.split(/\s+/).filter(Boolean).join(" ");
  const chars = [...flat];
  return { name: chars.length > 60 ? `${chars.slice(0, 59).join("")}…` : flat, prompt: flat };
}

// ---- evidence --------------------------------------------------------------------------------------------------------

/** What a run looks at: its text, and a key that is the same while nothing worth a new look has changed. */
export type Evidence = { text: string; key: string };

export type Check = { name: string; status: string; conclusion?: string | null; startedAt?: string | null; completedAt?: string | null; url?: string | null };
export type Status = { context: string; state: string; url?: string | null };
export type Head = { sha: string; at?: string; message?: string };

const ago = (now: number, at: string | null | undefined): string => {
  const ms = at == null ? undefined : parseMs(at);
  if (ms === undefined) return "";
  const min = Math.max(0, Math.round((now - ms) / 60_000));
  const span = min < 60 ? `${min} min` : min < 2880 ? `${Math.round(min / 60)} h` : `${Math.round(min / 1440)} d`;
  return `${isoMs(ms).slice(0, 16).replace("T", " ")} UTC, ${span} ago`;
};

/** How long an unfinished thing has gone, in SLOW_STEP_MS steps: a key that moves on only while it keeps going. */
const step = (now: number, at: string | null | undefined) => {
  const ms = at == null ? undefined : parseMs(at);
  return ms === undefined ? 0 : Math.floor(Math.max(0, now - ms) / SLOW_STEP_MS);
};

const oneLine = (s: string | undefined, max: number) => {
  const flat = (s ?? "").split(/\s+/).filter(Boolean).join(" ");
  const chars = [...flat];
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : flat;
};

/** Main's CI: the default branch's head, every check run and commit status on it. */
export function mainCi(repo: string, branch: string, head: Head, checks: Check[], statuses: Status[], now: number): Evidence {
  const lines = [`${repo} ${branch} is at ${head.sha.slice(0, 12)}${head.at ? `, committed ${ago(now, head.at)}` : ""}${head.message ? `: "${oneLine(head.message, 120)}"` : ""}.`];
  const done = (c: Check) => c.status === "completed";
  const fine = (c: Check) => done(c) && ["success", "neutral", "skipped"].includes(c.conclusion ?? "");
  const odd = checks.filter((c) => !fine(c)).sort((a, b) => a.name.localeCompare(b.name));
  lines.push(checks.length === 0 ? "No check runs on it." : `Check runs on it: ${checks.length}, ${checks.length - odd.length} passed.`);
  for (const c of odd.slice(0, LISTED)) {
    const when = done(c) ? `finished ${ago(now, c.completedAt)}` : c.startedAt ? `started ${ago(now, c.startedAt)}` : "not started";
    lines.push(`- ${c.name}: ${done(c) ? (c.conclusion ?? "completed") : c.status}, ${when}${c.url ? ` (${c.url})` : ""}`);
  }
  if (odd.length > LISTED) lines.push(`- and ${odd.length - LISTED} more not passed`);
  const badStatus = statuses.filter((s) => s.state !== "success");
  if (statuses.length > 0) lines.push(`Commit statuses: ${statuses.length}, ${statuses.length - badStatus.length} success.`);
  for (const s of badStatus.slice(0, LISTED)) lines.push(`- ${s.context}: ${s.state}${s.url ? ` (${s.url})` : ""}`);
  const key = [
    head.sha,
    ...checks.map((c) => `${c.name}:${c.status}:${c.conclusion ?? ""}:${done(c) ? 0 : step(now, c.startedAt ?? head.at)}`).sort(),
    ...statuses.map((s) => `${s.context}:${s.state}`).sort(),
  ].join("\n");
  return { text: lines.join("\n"), key };
}

export type Deployment = { id: number; environment: string; ref?: string; sha?: string; createdAt?: string; state?: string; stateAt?: string; description?: string; url?: string };

/** Deploys: each environment's newest deployment and its latest status. */
export function deploys(repo: string, latest: Deployment[], now: number): Evidence {
  if (latest.length === 0) return { text: `${repo} has no GitHub deployments.`, key: "none" };
  const lines = [`${repo}'s newest deployment in each environment (${latest.length}):`];
  for (const d of latest) {
    const state = d.state ?? "no status yet";
    lines.push(
      `- ${d.environment}: ${state}${d.stateAt ? ` since ${ago(now, d.stateAt)}` : ""}; ${d.ref ?? "?"}${d.sha ? ` at ${d.sha.slice(0, 12)}` : ""}, made ${ago(now, d.createdAt)}` +
        `${d.description ? `: "${oneLine(d.description, 120)}"` : ""}${d.url ? ` (${d.url})` : ""}`,
    );
  }
  const pending = (s?: string) => s === undefined || ["queued", "pending", "in_progress"].includes(s);
  const key = latest
    .map((d) => `${d.environment}:${d.id}:${d.state ?? ""}:${pending(d.state) ? step(now, d.stateAt ?? d.createdAt) : 0}`)
    .sort()
    .join("\n");
  return { text: lines.join("\n"), key };
}

// ---- the session -----------------------------------------------------------------------------------------------------

const CHECKS: Record<string, string> = {
  main_ci:
    "Something is off when a check on the head failed, timed out, was cancelled or needs action; when a commit status " +
    "is failure or error; when a check has run or waited for over an hour; or when the head has no checks at all though " +
    "it was committed over an hour ago. A check still running within the hour is fine.",
  deploys:
    "Something is off when an environment's newest deployment failed or errored; when one has been queued, pending or in " +
    "progress for over 30 minutes; or when one has no status at all an hour after it was made.",
};

const ANSWER =
  `When you are done, end with one line and nothing after it: OK when nothing is off; otherwise, in at most ${LINE_MAX} ` +
  "characters, what is off and its evidence (names, times, a link), in plain words and no markdown, for the person " +
  "who owns this software. " +
  "One problem per line: name the worst one, and only when there are others, how many more.";

/** The run's message: what to watch, its evidence or the tools it has, and how to answer. */
export function message(w: AutomationWatch, prompt: string, evidence: Evidence | undefined, tools: string[]): string {
  if (evidence !== undefined) {
    return [
      `You are a watcher: one look at ${PRESET_NAME[w.kind] ?? w.kind} for this bot's software. Read the evidence below and decide whether anything is off. You have no tools and change nothing.`,
      CHECKS[w.kind] ?? "",
      `Evidence, read by fleetd just now:\n${evidence.text}`,
      ANSWER,
    ]
      .filter(Boolean)
      .join("\n\n");
  }
  const can =
    tools.length === 0
      ? "You have no connections' tools, only WebFetch and WebSearch: if they can't show it, say so in your line."
      : `Your tools only read: WebFetch, WebSearch and ${tools.join(", ")}.`;
  return [
    "You are a watcher: one read-only look at one thing about this bot's software. Look, change nothing, open nothing, and ask no one.",
    `What to watch, as the person said it: ${prompt}`,
    `${can} Look for what is broken, failing, erroring, down or slower than usual now, not for things to improve.`,
    ANSWER,
  ].join("\n\n");
}

/** The session's last line: undefined when it said OK, else the line to post. */
export function verdict(text: string | undefined): string | undefined {
  const lines = (text ?? "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const last = lines.at(-1);
  if (last === undefined) return "It ended without an answer.";
  const bare = last.replace(/^[*_`#>\s-]+|[*_`.!\s]+$/g, "");
  if (/^ok$/i.test(bare)) return undefined;
  return oneLine(last.replace(/^[*_`#>\s-]+/, "").replace(/[*_`\s]+$/, ""), LINE_MAX);
}

/** The runs at or after `sinceMs` as a watcher's usage: how many ran a session or a look, spoke, and their cost. */
export function usage(runs: AutomationRun[], sinceMs: number): AutomationUsage {
  let costUsd = 0;
  let n = 0;
  let spoke = 0;
  for (const r of runs) {
    const at = parseMs(r.at);
    if (at === undefined || at < sinceMs || r.state === "skipped") continue;
    n += 1;
    if (r.said !== undefined) spoke += 1;
    costUsd += r.costUsd ?? 0;
  }
  return { runs: n, spoke, costUsd: Math.round(costUsd * 10_000) / 10_000 };
}

export const lastDay = (runs: AutomationRun[], now: number) => usage(runs, now - DAY_MS);
export { DAY_MS };

/** "$1.24", "$0.0042": a cost as its row and the day's line show it. */
export function dollars(usd: number): string {
  if (usd === 0) return "$0";
  return usd >= 0.1 ? `$${usd.toFixed(2)}` : `$${usd.toFixed(4)}`;
}

/** The line a watcher's first day ends with, once. */
export function firstDayLine(name: string, u: AutomationUsage): string {
  return `${name} watcher, first day: ${u.runs} look${u.runs === 1 ? "" : "s"}, spoke up ${u.spoke} time${u.spoke === 1 ? "" : "s"}, cost ${dollars(u.costUsd)}.`;
}

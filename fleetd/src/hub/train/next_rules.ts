// What the train decides about the `fleetd:next` label, re-runs and merge order without GitHub or the database
// (next.ts acts on it): which checks a repo's workflows gate on the label or skip on a batch, what proves a skip,
// re-run budgets, the `after` PRs as keyed, and whether one waits back on a PR.
import type { Change } from "../../shared/contracts.ts";
import { parseMs } from "../store/time.ts";
import { type CheckRun, workflowRun } from "./checks.ts";
import { BLOCKED_PREFIX, timedOut } from "./notes.ts";
import { parsePrUrl } from "./states.ts";
import { NEXT_LABEL } from "./text.ts";

export const LABEL_COLOR = "1d76db";
export const LABEL_ABOUT = "The fleetd merge train merges this next";

/** How long a PR merged alone waits for the run its label starts before the train tells the lead. */
export const LABEL_HOLD_MS = 3 * 60_000;
/** How long whether a repo's workflows name the label is trusted. */
export const USES_TTL_MS = 10 * 60_000;
/** How long a head's checks may sit queued before its Changes say they wait for runners. */
export const RUNNER_WAIT_MS = 5 * 60_000;
/** The start of the note on a Change in CI whose checks have waited `RUNNER_WAIT_MS` for runners. */
export const WAITING_FOR_RUNNERS = "waiting for CI runners";
/** The start of the hold on a ready Change whose `after` PRs haven't all merged. */
export const WAITING_ON = "held: waiting on ";
/** How long GitHub's answer for an upstream PR with no open Change is trusted. */
export const UPSTREAM_TTL_MS = 10_000;

export type UpstreamPull = { kind: "merged" } | { kind: "open" } | { kind: "closed" } | { kind: "unread"; message: string };

/** The first of a Change's `after` PRs that hasn't merged: the hold, and whether it failed (the lead hears). */
export type Waiting = { note: string; failed: boolean };

/** Whether where an upstream PR stands needs GitHub's read of it: its newest Change (`latest`) was refused or abandoned, or there is none. */
export const asksGitHub = (latest: Change | undefined) => {
  const s = latest?.state;
  return s === "refused" || s === "abandoned" || s === undefined;
};

/**
 * Where the upstream PR `repo`#`n` stands, from its newest Change on the train and, when `asksGitHub`, GitHub's read
 * of it: undefined once it merged.
 */
export function upstreamOf(repo: string, n: number, latest: Change | undefined, read: UpstreamPull | undefined): Waiting | undefined {
  let why: string;
  let failed: boolean;
  const s = latest?.state;
  if (s === "merged") return undefined;
  if (s === "ci_failed" && timedOut(latest!)) [why, failed] = ["its CI ran past the timeout", false];
  else if (s === "ci_failed") [why, failed] = ["its CI failed", true];
  else if (s === "needs_rebase") [why, failed] = ["it conflicts with its base and is back with its writer", false];
  else if (s === "reviewing" && latest!.lastError?.startsWith(BLOCKED_PREFIX)) [why, failed] = ["its review found blocking issues", true];
  else if (asksGitHub(latest)) {
    if (read === undefined) throw new Error(`upstreamOf: ${repo}#${n} needs GitHub's read of it`);
    if (read.kind === "merged") return undefined;
    if (read.kind === "closed") [why, failed] = ["it was closed without merging", true];
    else if (read.kind === "open") {
      if (s === "refused") [why, failed] = ["the train refused it", true];
      else if (s !== undefined) [why, failed] = ["it left the train unmerged", true];
      else [why, failed] = ["it is not on the train yet", false];
    } else [why, failed] = [`it could not be read: GitHub: ${read.message}`, false];
  } else [why, failed] = ["it hasn't merged yet", false];
  return { note: `${WAITING_ON}${repo}#${n}: ${why}`, failed };
}

/** `after` as the train keys it: each PR's URL with its repo lowercased, once. */
export function upstreams(after: string[]): string[] {
  const out: string[] = [];
  for (const url of after) {
    const p = parsePrUrl(url);
    if (!p) continue;
    const key = `https://github.com/${p.repo.toLowerCase()}/pull/${p.number}`;
    if (!out.includes(key)) out.push(key);
  }
  return out;
}

/** A check the batch PR skips: the checks of the jobs it `needs` must have passed on a PR's own head. */
export type BatchSkip = { name: string; needs: string[] };

/** What the train reads from a repo's workflows on one base. */
export type Workflows = { label: string[]; batch: BatchSkip[]; jobs: string[] };

export const batchNames = (w: Workflows) => w.batch.map((b) => b.name);

/** Per job the train re-ran for being cancelled, by workflow run and check name, what it did. */
export type Rerun = { times: number; seen: number; refused: number; at: number };
export type Reruns = Map<string, Rerun>;
export const rerunKey = (run: number, name: string) => `${run}\u0000${name}`;

/** Whether the train re-ran `run`, the newest run of its check, as the run it saw. */
export function reran(reruns: Reruns, run: CheckRun): boolean {
  const w = workflowRun(run);
  if (w === undefined) return false;
  const r = reruns.get(rerunKey(w, run.name));
  return r !== undefined && r.times > 0 && r.seen === run.id;
}

/** What `rerunJobs` came to, over every job it was given. */
export type Reran = { now: boolean; pending: boolean; busy: boolean; refused: boolean; spent: boolean; gaveUp: boolean; unknown: boolean };
export const noRerun = (): Reran => ({ now: false, pending: false, busy: false, refused: false, spent: false, gaveUp: false, unknown: false });

/** How many times the train asks GitHub to re-run a cancelled job before it stops asking. */
export const RERUN_TRIES = 3;
export const RERUN_BACKOFF_MS = 60_000;

/** What putting the label on a PR came to: on at a time, on before (a restart), or refused. */
export type Labelled = { kind: "at"; at: number } | { kind: "before" } | { kind: "failed" };

/** The checks the label runs in a repo's CI: by name, or unknown while its workflows can't be read. */
export type Gate = { kind: "checks"; names: string[] } | { kind: "unknown" };

/** A PR the train merges alone in a repo whose CI may run checks on the label. */
export type Lone = { label: Labelled; gate: Gate };

export const loneSince = (lone: Lone, start: number) => (lone.label.kind === "at" ? Math.max(lone.label.at, start) : start);

/** The skipped checks that don't count as passing for a PR merged alone. */
export function unprovenSkips(runs: CheckRun[], lone: Lone): CheckRun[] {
  return runs
    .filter((r) => r.conclusion === "skipped")
    .filter((r) => (lone.gate.kind === "checks" ? lone.gate.names.some((n) => gatedName(n, r.name)) : true))
    .filter((r) => (lone.label.kind === "at" ? skippedBy(r, lone.label.at) : lone.label.kind === "failed"));
}

/** Whether the check `name` is the job `pattern` names; each `${{ … }}` in it matches any text. */
export function gatedName(pattern: string, name: string): boolean {
  const parts: string[] = [];
  let rest = pattern;
  for (;;) {
    const at = rest.indexOf("${{");
    if (at < 0) break;
    parts.push(rest.slice(0, at));
    const after = rest.slice(at + 3);
    const end = after.indexOf("}}");
    rest = end < 0 ? "" : after.slice(end + 2);
  }
  parts.push(rest);
  if (parts.length < 2) return pattern === name;
  const head = parts[0]!;
  const tail = parts.at(-1)!;
  // Byte lengths, as Rust's `str::len`.
  const len = (s: string) => Buffer.byteLength(s);
  if (len(name) < len(head) + len(tail) || !name.startsWith(head) || !name.endsWith(tail)) return false;
  let inner = name.slice(head.length, name.length - tail.length);
  for (const literal of parts.slice(1, -1)) {
    const at = inner.indexOf(literal);
    if (at < 0) return false;
    inner = inner.slice(at + literal.length);
  }
  return true;
}

type Yaml = unknown;
const parseYaml = (text: string): Yaml | undefined => {
  try {
    return Bun.YAML.parse(text);
  } catch {
    return undefined;
  }
};
const obj = (v: unknown): Record<string, unknown> | undefined =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
const str = (v: unknown) => (typeof v === "string" ? v : undefined);

/** A workflow's `on:` (YAML 1.1 reads the bare key as `true`). */
function on(doc: Yaml): unknown {
  const map = obj(doc);
  if (!map) return undefined;
  return "on" in map ? map.on : map.true;
}

/** The checks the label runs, from the repo's workflow files: in a workflow the label triggers, each job whose `if:` names it. */
export function labelGated(files: [string, string][]): string[] {
  const parsed = files.flatMap(([path, text]) => {
    const doc = parseYaml(text);
    return doc === undefined ? [] : [[path, text, doc] as const];
  });
  const reacts = (doc: Yaml, text: string) => {
    if (!text.includes(NEXT_LABEL)) return false;
    const o = obj(on(doc));
    return (
      o !== undefined &&
      ["pull_request", "pull_request_target"].some((event) => {
        const types = obj(o[event])?.types;
        return Array.isArray(types) && types.some((t) => t === "labeled");
      })
    );
  };
  const started: string[] = parsed
    .filter(([, text, doc]) => reacts(doc, text))
    .flatMap(([, text]) => {
      const out: string[] = [];
      let at = 0;
      for (;;) {
        const i = text.indexOf("workflow run ", at);
        if (i < 0) break;
        at = i + 1;
        const word = text.slice(i + "workflow run ".length).trimStart().split(/\s+/)[0];
        if (word) out.push(word.replace(/^["']+|["']+$/g, ""));
      }
      return out;
    });
  const triggered = (path: string, text: string, doc: Yaml) => {
    const file = path.split("/").at(-1) ?? path;
    const name = str(obj(doc)?.name);
    return reacts(doc, text) || started.some((s) => s === file || s === name);
  };
  const names: string[] = [];
  for (const [path, text, doc] of parsed) {
    if (!triggered(path, text, doc)) continue;
    const jobs = obj(obj(doc)?.jobs);
    if (!jobs) continue;
    for (const [id, job] of Object.entries(jobs)) {
      const gated = str(obj(job)?.if)?.includes(NEXT_LABEL) ?? false;
      const name = str(obj(job)?.name) ?? id;
      if (gated && !names.includes(name)) names.push(name);
    }
  }
  return names;
}

/** The checks each job of the workflow files reports, as patterns `gatedName` reads. */
export function jobChecks(files: [string, string][]): string[] {
  const names: string[] = [];
  for (const [, text] of files) {
    const jobs = obj(obj(parseYaml(text))?.jobs);
    if (!jobs) continue;
    for (const [id, raw] of Object.entries(jobs)) {
      const job = obj(raw) ?? {};
      const base = str(job.name) ?? id;
      const matrix = obj(job.strategy)?.matrix !== undefined;
      const name = job.uses !== undefined ? `${base} / \${{ job }}` : matrix && !base.includes("${{") ? `${base} (\${{ matrix }})` : base;
      if (!names.includes(name)) names.push(name);
    }
  }
  return names;
}

/** How a job's `if:` skips it on the train's batch PR, spaces left out. */
const SKIPPED_ON_BATCH = "!endsWith(github.head_ref,'train/batch')";

/** The checks the train's batch PR skips, from the repo's workflow files, with the checks of the jobs each `needs`. */
export function batchSkipped(files: [string, string][]): BatchSkip[] {
  const runsOnPushes = (doc: Yaml) => {
    const o = on(doc);
    if (typeof o === "string") return o === "pull_request";
    if (Array.isArray(o)) return o.some((e) => e === "pull_request");
    const m = obj(o);
    if (!m || !("pull_request" in m)) return false;
    const types = obj(m.pull_request)?.types;
    return !Array.isArray(types) || ["opened", "synchronize"].every((t) => types.some((x) => x === t));
  };
  const skips: BatchSkip[] = [];
  for (const [, text] of files) {
    const doc = parseYaml(text);
    if (doc === undefined || !runsOnPushes(doc)) continue;
    const jobs = obj(obj(doc)?.jobs);
    if (!jobs) continue;
    const check = (id: string, job: unknown) => str(obj(job)?.name) ?? id;
    for (const [id, raw] of Object.entries(jobs)) {
      const job = obj(raw) ?? {};
      const cond = str(job.if);
      const skipped = cond !== undefined && cond.split(/\s+/).join("").replaceAll('"', "'").includes(SKIPPED_ON_BATCH);
      const needs = typeof job.needs === "string" ? [job.needs] : Array.isArray(job.needs) ? job.needs.filter((n): n is string => typeof n === "string") : [];
      const needed = needs.filter((n) => n in jobs).map((n) => check(n, jobs[n]));
      const name = check(id, job);
      if (skipped && !skips.some((s) => s.name === name)) skips.push({ name, needs: needed });
    }
  }
  return skips;
}

/** The skipped runs of the checks the batch skips whose skip nothing proves (a needed job didn't pass on the head). */
export function unprovenBatchSkips(runs: CheckRun[], batch: BatchSkip[]): CheckRun[] {
  return runs
    .filter((r) => r.conclusion === "skipped")
    .filter((r) => {
      const skip = batch.find((b) => gatedName(b.name, r.name));
      if (!skip || skip.needs.length === 0) return false;
      const needed = skip.needs.map((n) => runs.find((x) => gatedName(n, x.name))).filter((x): x is CheckRun => x !== undefined);
      return !(needed.length === skip.needs.length && needed.every((x) => x.conclusion === "success"));
    });
}

/** `runs` without the checks the batch skips whose skip on this head nothing proves. */
export function provenRuns(runs: CheckRun[], batch: BatchSkip[]): CheckRun[] {
  const unproven = unprovenBatchSkips(runs, batch).map((r) => r.name);
  return runs.filter((r) => !unproven.includes(r.name));
}

function skippedBy(run: CheckRun, at: number): boolean {
  const second = Math.floor(at / 1000) * 1000;
  const done = run.completed_at ? parseMs(run.completed_at) : undefined;
  return done !== undefined && done < second + 1000;
}

/** The head's checks that wait for a runner. */
export const queued = (runs: CheckRun[]) => runs.filter((r) => r.status !== "completed" && r.status !== "in_progress").length;

/** The train's knowledge of the label and of each repo's workflows. */
export class NextLabels {
  /** Per repo, the PRs that carry the label and when the train put it on (undefined: found on it). */
  readonly labelled = new Map<string, Map<number, number | undefined>>();
  /** The repos whose label exists and whose labelled PRs were read. */
  readonly known = new Set<string>();
  /** The repos whose labelling failure is logged. */
  readonly warned = new Set<string>();
  /** Per repo and base, what its workflows say, and when they were read. */
  readonly gated = new Map<string, [number, Workflows]>();
  /** Per repo and head in the line, the train's re-runs of its batch-skipped checks and its tree's jobs. */
  readonly heads = new Map<string, { reruns: Reruns; jobs?: string[] }>();

  prs(repo: string): Map<number, number | undefined> {
    let m = this.labelled.get(repo);
    if (!m) {
      m = new Map();
      this.labelled.set(repo, m);
    }
    return m;
  }
}

/** `list` with each PR of `after` it lacks added at its end. */
export function mergeAfter(list: string[] | undefined, after: string[]): string[] {
  const out = [...(list ?? [])];
  for (const u of after) if (!out.includes(u)) out.push(u);
  return out;
}

/** The PR in `after` that already waits, through the `after` of the open Change `afterOf` gives each PR, on `prUrl`. */
export function loopsBackVia(prUrl: string, after: string[], afterOf: (repo: string, n: number) => string[] | undefined): string | undefined {
  for (const start of after) {
    const seen = new Set<string>();
    const todo = [start];
    while (todo.length > 0) {
      const url = todo.pop()!;
      if (url === prUrl) return start;
      if (seen.has(url)) continue;
      seen.add(url);
      const p = parsePrUrl(url);
      if (!p) continue;
      todo.push(...(afterOf(p.repo, p.number) ?? []));
    }
  }
  return undefined;
}

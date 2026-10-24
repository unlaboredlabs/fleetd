// `scripts/bench-vs`: the controlled head-to-head speed bench. Each run starts from a
// fresh clone of the task's frozen base (bench/<task>/base in the lab repo, checked against the sha in task.json),
// runs one contender with the task text and no human input until it says it is finished (or the timeout), applies the
// task's hidden checks, runs a blind blocker-only review, and writes the metrics as JSON to <bench>/results/<run>.json.
//
//   scripts/bench-vs --suite [--tasks a,b] [--contenders claude-p,claude-p+gate,fleetd] [--repeat N]   # in sequence, then --table
//   scripts/bench-vs --task tinyhttp-six --contender claude-p
//   scripts/bench-vs --task tinyhttp-six --contender claude-p+gate  # claude -p, then PR, fleetd's review, CI, merge
//   scripts/bench-vs --task tinyhttp-six --contender fleetd [--slot 9] [--max-agents 40]
//   scripts/bench-vs --task tinyhttp-six --contender t3             # prepares a clone, prints the task, exits
//   scripts/bench-vs --arm <run-dir>                                # right before the T3 thread gets the task: load, hide
//   scripts/bench-vs --finish <run-dir> --start <iso> --end <iso> [--logs <dir>]...   # imports the T3 Code run
//   scripts/bench-vs --task tinyhttp-six --contender reference      # the known-good solution: tests the harness
//   scripts/bench-vs --table [--since <iso>]                        # the results table, also <bench>/results/TABLE.md
//   scripts/bench-vs --list | --publish | --unhide
//
// Hidden checks live outside every repo, in <bench>/checks/<task>/check.ts (FLEETD_BENCH_HOME, default
// ~/src/fleetd-lab/bench), and are never copied into a contender's tree; while a contender runs, <bench>/checks and
// <bench>/ref are made unreadable. Runs live under /tmp/fleetd-bench (FLEETD_BENCH_TMP); each claude contender gets
// its own HOME there with a copy of the user's ~/.claude setup (env.ts), every claude pinned to one model and effort,
// and its API calls going through a logging proxy that proves it.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { type Efficiency, efficiencyOfArchive, PRICE, type Tokens, totalOf } from "./accounting.ts";
import { activeSetup, busy, claudeVersion, cliVersion, copyClaudeSetup, EFFORT, type LoadSnapshot, loadSnapshot, MODEL, sampleLoad, upstreamUrl } from "./env.ts";
import { readProxyLog, startProxy } from "./proxy.ts";
import { filesIn, jsonlFiles, type Pinning, pinningOf, type Usage, usageOf, type Window } from "./usage.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, "../../..");
export const BENCH = path.resolve(process.env.FLEETD_BENCH_HOME ?? path.join(os.homedir(), "src/fleetd-lab/bench"));
export const TMP = path.resolve(process.env.FLEETD_BENCH_TMP ?? "/tmp/fleetd-bench");
export const LAB_REPO = process.env.FLEETD_BENCH_REPO ?? "unlaboredlabs/fleetd-lab";
/** The local repo holding every task's base commit; `--publish` pushes them to the lab repo. */
const SNAPSHOT = path.join(BENCH, "src/snap-tinyhttp");
/** What a contender must not read while it runs: the hidden checks and the known-good solutions. */
const HIDDEN = [path.join(BENCH, "checks"), path.join(BENCH, "ref")];
const CONTENDERS = ["claude-p", "claude-p+gate", "fleetd", "t3", "reference"] as const;
type Contender = (typeof CONTENDERS)[number];
/** Session lines this close outside an imported run's start and end still count as the run's. */
const WINDOW_SLACK_MS = 60_000;

for (const dir of [TMP, BENCH]) {
  for (const forbidden of [".fleetd", ".claude", ".t3"]) {
    if (dir.startsWith(path.join(os.homedir(), forbidden))) throw new Error(`refusing: ${dir} is inside ~/${forbidden}`);
  }
}

const t0 = Date.now();
export const log = (line: string) => process.stdout.write(`[${((Date.now() - t0) / 1000).toFixed(1).padStart(7)}s] ${line}\n`);

export interface TaskDef {
  readonly name: string;
  readonly title: string;
  readonly kind: string;
  readonly base: string;
  /** The commit every contender starts from; the base branch must point here. */
  readonly baseSha: string;
  readonly timeoutMin: number;
  readonly text: string;
}

export const loadTask = (name: string): TaskDef => {
  const dir = path.join(HERE, "tasks", name);
  if (!fs.existsSync(path.join(dir, "task.json"))) {
    throw new Error(`unknown task ${name}; known: ${fs.readdirSync(path.join(HERE, "tasks")).join(", ")}`);
  }
  const meta = JSON.parse(fs.readFileSync(path.join(dir, "task.json"), "utf8")) as Omit<TaskDef, "name" | "text">;
  return { ...meta, name, text: fs.readFileSync(path.join(dir, "task.md"), "utf8").trim() };
};

/** The measured tasks: every task but the harness smoke test. */
const measuredTasks = () => fs.readdirSync(path.join(HERE, "tasks")).filter((t) => t !== "smoke").sort();

/** What one run knows about itself, kept in <run-dir>/run.json so `--finish` can pick it up later. */
export interface RunInfo {
  readonly runId: string;
  readonly task: string;
  readonly contender: Contender;
  readonly runDir: string;
  /** The contender's checkout. */
  readonly work: string;
  /** The commit every contender starts from. */
  readonly baseSha: string;
  /** Directories whose claude session JSONL is the contender's usage. */
  usageDirs: Array<string>;
  startedAt?: string;
  loadStart?: LoadSnapshot;
}

const stamp = () => new Date().toISOString().slice(0, 19).replace(/\D/gu, "");
const run = (cmd: string, args: ReadonlyArray<string>, cwd?: string, env?: NodeJS.ProcessEnv) =>
  execFileSync(cmd, args, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 << 20 }).trim();
export const git = (cwd: string, ...args: Array<string>) => run("git", args, cwd);
export const gh = (...args: Array<string>) => run("gh", args, TMP);
const labUrl = () => `https://github.com/${LAB_REPO}.git`;

/** A clone of `branch` of the lab repo at `dir`. */
export const cloneBranch = (branch: string, dir: string) => {
  fs.rmSync(dir, { recursive: true, force: true });
  run("git", ["clone", "-q", "--single-branch", "-b", branch, labUrl(), dir]);
};

/**
 * Makes sure the task's base branch is on the lab repo at its frozen sha, pushing it from the local snapshot repo when
 * it is missing (lab resets may delete it). A branch that moved is an error: every contender must start from one sha.
 */
export const ensureBase = (task: TaskDef) => {
  fs.mkdirSync(TMP, { recursive: true });
  const remote = run("git", ["ls-remote", labUrl(), `refs/heads/${task.base}`], TMP).split(/\s/u)[0] ?? "";
  if (remote === task.baseSha) return;
  if (remote !== "") throw new Error(`${task.base} on ${LAB_REPO} is at ${remote}, not ${task.baseSha}: the frozen base moved`);
  run("git", ["push", "-q", labUrl(), `${task.baseSha}:refs/heads/${task.base}`], SNAPSHOT);
  log(`published ${task.base} at ${task.baseSha.slice(0, 7)} from ${SNAPSHOT}`);
};

/** The hidden checks and reference solutions, unreadable while a contender runs (it has the whole filesystem). */
const hideHidden = () => {
  for (const dir of HIDDEN) if (fs.existsSync(dir)) fs.chmodSync(dir, 0o000);
};
const unhideHidden = () => {
  for (const dir of HIDDEN) if (fs.existsSync(dir)) fs.chmodSync(dir, 0o755);
};

// ---- isolated homes ----

/**
 * A HOME for one claude contender: the user's claude setup copied and pinned (env.ts), and a .gitconfig with their
 * git identity. `scrubHome` removes the copied login when the run ends.
 */
export const prepareClaudeHome = (home: string, proxyUrl: string) => {
  copyClaudeSetup(home, proxyUrl);
  const get = (key: string, fallback: string) => spawnSync("git", ["config", "--global", key], { encoding: "utf8" }).stdout.trim() || fallback;
  fs.writeFileSync(path.join(home, ".gitconfig"), `[user]\n\tname = ${get("user.name", "bench")}\n\temail = ${get("user.email", "bench@localhost")}\n[init]\n\tdefaultBranch = main\n`);
};

export const scrubHome = (home: string) => {
  for (const f of [".claude/settings.json", ".claude/.credentials.json", ".claude.json"]) fs.rmSync(path.join(home, f), { force: true });
  fs.rmSync(path.join(home, ".config/gh"), { recursive: true, force: true });
};

/** One logging proxy per run, in front of the user's endpoint; its log is the run's per-request record. */
export const runProxy = (runDir: string) => startProxy(upstreamUrl(), path.join(runDir, "requests.jsonl"));

/** HOME, PATH, USER and LANG only; never this session's CLAUDE* variables. */
export const baseEnv = (home: string): NodeJS.ProcessEnv => ({
  ...Object.fromEntries(["PATH", "USER", "LANG", "TERM"].flatMap((k) => (process.env[k] === undefined ? [] : [[k, process.env[k]!]]))),
  HOME: home,
  // On macOS claude keys its Keychain login to CLAUDE_CONFIG_DIR only when it is set.
  ...(process.platform === "darwin" ? { CLAUDE_CONFIG_DIR: path.join(home, ".claude") } : {}),
});

// ---- processes this run starts ----

/**
 * Runs `cmd` in its own process group, so a timeout stops it and everything it spawned (by the group of the PID
 * captured here, nothing found by name). Resolves with the exit code, or "timeout".
 */
export const runGroup = (cmd: string, args: ReadonlyArray<string>, opts: { cwd: string; env: NodeJS.ProcessEnv; out: string; timeoutMs: number; stdin?: string }) =>
  new Promise<{ code: number | null; timedOut: boolean }>((resolve) => {
    const out = fs.openSync(opts.out, "a");
    const child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env, stdio: [opts.stdin === undefined ? "ignore" : "pipe", out, out], detached: true });
    log(`started ${path.basename(cmd)} pid=${child.pid} (group)`);
    if (opts.stdin !== undefined) child.stdin!.end(opts.stdin);
    let timedOut = false;
    const kill = (signal: NodeJS.Signals) => {
      try {
        process.kill(-child.pid!, signal);
      } catch {
        // Already gone.
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill("SIGTERM");
      setTimeout(() => kill("SIGKILL"), 10_000).unref();
    }, opts.timeoutMs);
    const onSignal = () => kill("SIGTERM");
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
    child.on("exit", (code) => {
      clearTimeout(timer);
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
      // Stragglers the contender left in its group (a dev server, a watcher).
      kill("SIGTERM");
      fs.closeSync(out);
      resolve({ code, timedOut });
    });
  });

// ---- contenders ----

export interface Outcome {
  wallMs: number;
  doneBy: "finished" | "timeout" | "stalled" | "error";
  humanFree: boolean;
  /** The tree the checks run on. */
  resultTree: string;
  extra?: Record<string, unknown>;
}

export const prepareLocal = (task: TaskDef, contender: Contender, runDir: string): RunInfo => {
  const work = path.join(runDir, "work");
  cloneBranch(task.base, work);
  const head = git(work, "rev-parse", "HEAD");
  if (head !== task.baseSha) throw new Error(`${task.base} cloned at ${head}, not the frozen ${task.baseSha}`);
  // Nothing to push to: the base stays frozen, and the work stays in this clone.
  git(work, "remote", "remove", "origin");
  return { runId: path.basename(runDir), task: task.name, contender, runDir, work, baseSha: head, usageDirs: [] };
};

/**
 * One pinned `claude -p` in `cwd` with `prompt` on stdin, its stream appended to `stream`; `resume` continues that
 * session. Resolves when the process exits, with its result event and session id.
 */
export const claudeSession = async (opts: { home: string; cwd: string; prompt: string; stream: string; timeoutMs: number; resume?: string }) => {
  const from = fs.existsSync(opts.stream) ? fs.statSync(opts.stream).size : 0;
  const { code, timedOut } = await runGroup(
    "claude",
    ["-p", "--model", MODEL, "--effort", EFFORT, "--dangerously-skip-permissions", "--output-format", "stream-json", "--verbose", ...(opts.resume === undefined ? [] : ["--resume", opts.resume])],
    { cwd: opts.cwd, env: baseEnv(opts.home), out: opts.stream, timeoutMs: opts.timeoutMs, stdin: opts.prompt },
  );
  const events = fs
    .readFileSync(opts.stream, "utf8")
    .slice(from)
    .split("\n")
    .flatMap((l) => {
      try {
        return l.startsWith("{") ? [JSON.parse(l) as Record<string, any>] : [];
      } catch {
        return [];
      }
    });
  const result = events.findLast((e) => e.type === "result");
  const finished = !timedOut && code === 0 && result?.subtype === "success";
  return { code, timedOut, finished, result, sessionId: (result?.session_id ?? events.find((e) => e.session_id !== undefined)?.session_id) as string | undefined };
};

const claudeP = async (task: TaskDef, info: RunInfo, timeoutMs: number, proxyUrl: string): Promise<Outcome> => {
  const home = path.join(info.runDir, "home");
  prepareClaudeHome(home, proxyUrl);
  info.usageDirs.push(path.join(home, ".claude/projects"));
  const started = Date.now();
  info.startedAt = new Date(started).toISOString();
  try {
    const s = await claudeSession({ home, cwd: info.work, prompt: task.text, stream: path.join(info.runDir, "claude-p.stream.jsonl"), timeoutMs });
    return {
      // The process exit is claude-p's own done event.
      wallMs: Date.now() - started,
      doneBy: s.timedOut ? "timeout" : s.finished ? "finished" : "error",
      humanFree: s.finished,
      resultTree: info.work,
      extra: { exitCode: s.code, cliCostUsd: s.result?.total_cost_usd, numTurns: s.result?.num_turns, finalText: String(s.result?.result ?? "").slice(-2000) },
    };
  } finally {
    scrubHome(home);
  }
};

/** The task's known-good solution (<bench>/ref/<task>), copied over the clone: exercises the harness for free. */
const reference = async (info: RunInfo): Promise<Outcome> => {
  const ref = path.join(BENCH, "ref", info.task);
  if (!fs.existsSync(ref)) throw new Error(`no reference solution at ${ref}`);
  const started = Date.now();
  info.startedAt = new Date(started).toISOString();
  run("rsync", ["-a", "--delete", "--exclude=.git", "--exclude=node_modules", "--exclude=dist", "--exclude=*.tsbuildinfo", `${ref}/`, `${info.work}/`]);
  return { wallMs: Date.now() - started, doneBy: "finished", humanFree: true, resultTree: info.work };
};

// ---- checks, review, result ----

/** Runs the hidden checks on `tree`: <bench>/checks/<task>/check.ts prints {"pass", "checks"} as its last line. */
export const hiddenChecks = (task: string, tree: string, scratch: string) => {
  const script = path.join(BENCH, "checks", task, "check.ts");
  if (!fs.existsSync(script)) throw new Error(`no hidden checks at ${script}`);
  const started = Date.now();
  const out = spawnSync(process.execPath, [script, tree, scratch], { encoding: "utf8", maxBuffer: 64 << 20, timeout: 30 * 60_000 });
  process.stderr.write(out.stderr ?? "");
  const last = (out.stdout ?? "").trim().split("\n").at(-1) ?? "";
  try {
    const parsed = JSON.parse(last) as { pass: boolean; checks: Array<{ name: string; pass: boolean; detail?: string }> };
    return { ...parsed, ms: Date.now() - started };
  } catch {
    return { pass: false, checks: [{ name: "check script", pass: false, detail: `${out.stdout}\n${out.stderr}`.slice(-2000) }], ms: Date.now() - started };
  }
};

/**
 * A repository for the blind review: the base tree committed and tagged `bench-base`, then the result tree on top as
 * one commit, so nothing in it says who made the change.
 */
const reviewRepo = (info: RunInfo, tree: string, dir: string) => {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const env = { ...process.env, GIT_AUTHOR_NAME: "bench", GIT_AUTHOR_EMAIL: "bench@localhost", GIT_COMMITTER_NAME: "bench", GIT_COMMITTER_EMAIL: "bench@localhost" };
  const g = (...args: Array<string>) => run("git", args, dir, env);
  g("init", "-q", "-b", "main");
  const archive = spawnSync("git", ["archive", info.baseSha], { cwd: tree, maxBuffer: 1 << 30 });
  if (archive.status !== 0) throw new Error(`git archive ${info.baseSha} in ${tree}: ${archive.stderr}`);
  execFileSync("tar", ["-x", "-C", dir], { input: archive.stdout });
  g("add", "-A");
  g("commit", "-q", "--no-verify", "-m", "base");
  g("tag", "bench-base");
  run("rsync", ["-a", "--delete", "--exclude=.git", "--exclude=node_modules", "--exclude=dist", "--exclude=*.tsbuildinfo", "--exclude=coverage", `${tree}/`, `${dir}/`]);
  g("add", "-A");
  g("commit", "-q", "--no-verify", "--allow-empty", "-m", "change");
  return g("diff", "bench-base", "HEAD");
};

type Blocker = { file?: string; why: string };

/** The review's verdict: the last `{"blockers": [...]}` object in its reply, fenced or not; null when there is none. */
export const verdictOf = (text: string): Array<Blocker> | null => {
  const starts = [...text.matchAll(/\{\s*"blockers"\s*:/gu)].map((m) => m.index).reverse();
  for (const start of starts) {
    const tail = text.slice(start);
    for (let end = tail.lastIndexOf("}"); end > 0; end = tail.lastIndexOf("}", end - 1)) {
      try {
        const parsed = JSON.parse(tail.slice(0, end + 1)) as { blockers?: unknown };
        if (Array.isArray(parsed.blockers)) return parsed.blockers as Array<Blocker>;
      } catch {
        // Not this closing brace.
      }
    }
  }
  return null;
};

const review = async (task: TaskDef, info: RunInfo, tree: string) => {
  const dir = path.join(info.runDir, "review");
  const patch = reviewRepo(info, tree, dir);
  const home = path.join(info.runDir, "review-home");
  const requests = path.join(info.runDir, "review-requests.jsonl");
  const proxy = await startProxy(upstreamUrl(), requests);
  prepareClaudeHome(home, proxy.url);
  const prompt = fs.readFileSync(path.join(HERE, "review.md"), "utf8").replace("{{TASK}}", task.text);
  const out = path.join(info.runDir, "review.json");
  const started = Date.now();
  let result: { code: number | null; timedOut: boolean };
  try {
    result = await runGroup("claude", ["-p", "--model", MODEL, "--effort", EFFORT, "--dangerously-skip-permissions", "--output-format", "json"], {
      cwd: dir,
      env: baseEnv(home),
      out,
      timeoutMs: 45 * 60_000,
      stdin: prompt,
    });
  } finally {
    await proxy.close();
    scrubHome(home);
  }
  const sessionFiles = jsonlFiles(path.join(home, ".claude/projects"));
  const usage = usageOf(sessionFiles);
  const pinning = pinningOf(sessionFiles, readProxyLog(requests), { model: MODEL, effort: EFFORT, cli: cliVersion() });
  let text = "";
  try {
    text = String((JSON.parse(fs.readFileSync(out, "utf8").trim().split("\n").at(-1) ?? "{}") as { result?: string }).result ?? "");
  } catch {
    // Not JSON: the review failed.
  }
  const blockers = verdictOf(text);
  return {
    blockers,
    ok: blockers !== null && !result.timedOut && result.code === 0,
    ms: Date.now() - started,
    usd: usage.usd,
    tokens: usage.totalTokens,
    pinned: pinning.valid,
    pinViolations: pinning.violations,
    patchBytes: patch.length,
    patch,
    text: text.slice(-4000),
  };
};

/** Copies the session files a run used into the archive, keeping their place under each usage dir. */
const archiveSessions = (dirs: ReadonlyArray<string>, files: ReadonlyArray<string>, to: string) => {
  for (const file of files) {
    const i = dirs.findIndex((d) => file.startsWith(`${d}${path.sep}`));
    const dest = path.join(to, `sessions-${i}`, i === -1 ? path.basename(file) : path.relative(dirs[i]!, file));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(file, dest);
  }
};

type LoadSummary = ReturnType<ReturnType<typeof sampleLoad>["stop"]>;

export interface Result {
  /** 2 for results this harness wrote; the table skips anything else (the 2026-10-22 trial runs). */
  schema: 2;
  runId: string;
  task: string;
  contender: Contender;
  startedAt: string | undefined;
  wallMs: number;
  /** Start to all checks green: the wall time when the run passed, else null. */
  wallToGreenMs: number | null;
  doneBy: Outcome["doneBy"];
  humanFree: boolean;
  pass: boolean;
  checks: ReturnType<typeof hiddenChecks>;
  review: Omit<Awaited<ReturnType<typeof review>>, "patch" | "text"> | null;
  usage: Usage | null;
  /** Usage by token type, agent role and request (accounting.ts); the table recomputes it from the run's archive. */
  efficiency?: Efficiency | null;
  /** Every request and session message on MODEL at EFFORT from the same claude CLI; `valid: false` does not count. */
  pinning: Pinning | null;
  /** False when the pinning check failed or found nothing to check: the run is reported but does not count. */
  valid: boolean;
  env: {
    claudeVersion: string;
    setup: ReturnType<typeof activeSetup>;
    loadStart: LoadSnapshot;
    loadEnd: LoadSnapshot;
    /** Sampled every 30 s while the contender ran; null for an imported run. */
    load: LoadSummary | null;
    busy: boolean;
  };
  agents: number | null;
  model: string;
  effort: string;
  fleetdSha: string;
  notes: string | null;
  extra?: Record<string, unknown>;
}

interface FinishOpts {
  review: boolean;
  agents?: number;
  keep: boolean;
  loadStart: LoadSnapshot;
  load: LoadSummary | null;
  proxyLog: string | null;
  /** An imported run's span: only session lines inside it count. */
  window?: Window;
  note?: string;
}

const finish = async (task: TaskDef, info: RunInfo, outcome: Outcome, opts: FinishOpts) => {
  const loadEnd = loadSnapshot();
  unhideHidden();
  log(`${info.contender} done (${outcome.doneBy}) after ${(outcome.wallMs / 1000).toFixed(0)} s; hidden checks`);
  const checks = hiddenChecks(task.name, outcome.resultTree, path.join(info.runDir, "checks"));
  log(`hidden checks: ${checks.pass ? "PASS" : "FAIL"} (${checks.checks.filter((c) => c.pass).length}/${checks.checks.length})`);
  let rev: Awaited<ReturnType<typeof review>> | null = null;
  if (opts.review) {
    log("blind review");
    rev = await review(task, info, outcome.resultTree);
    log(`review: ${rev.blockers === null ? "no verdict" : `${rev.blockers.length} blocker(s)`}`);
  }
  const allFiles = info.usageDirs.flatMap(jsonlFiles);
  const sessionFiles = opts.window === undefined ? allFiles : filesIn(allFiles, opts.window);
  const usage = sessionFiles.length > 0 ? usageOf(sessionFiles, opts.window) : null;
  const measured = info.contender !== "reference";
  const pinning = measured ? pinningOf(sessionFiles, opts.proxyLog === null ? null : readProxyLog(opts.proxyLog), { model: MODEL, effort: EFFORT, cli: cliVersion() }, opts.window) : null;
  if (pinning !== null) log(`pinning: ${pinning.valid ? "every call on" : "NOT all on"} ${MODEL} ${EFFORT}, claude ${cliVersion()}${pinning.valid ? "" : `: ${pinning.violations.join("; ")}`}`);
  const pass = checks.pass && (rev === null || (rev.ok && rev.blockers!.length === 0));
  const machineBusy = busy(opts.loadStart) || busy(loadEnd) || (opts.load !== null && busy({ loadavg1: opts.load.meanLoadavg1, cpus: loadEnd.cpus }));
  const archive = path.join(BENCH, "runs", info.runId);
  fs.mkdirSync(archive, { recursive: true });
  archiveSessions(info.usageDirs, sessionFiles, archive);
  if (rev !== null) {
    fs.writeFileSync(path.join(archive, "result.patch"), rev.patch);
    fs.writeFileSync(path.join(archive, "review.txt"), rev.text);
  }
  for (const f of fs.existsSync(info.runDir) ? fs.readdirSync(info.runDir).filter((f) => /^reviewer-\d+\.stream\.jsonl$/u.test(f)) : []) {
    fs.copyFileSync(path.join(info.runDir, f), path.join(archive, f));
  }
  for (const f of ["run.json", "claude-p.stream.jsonl", "review.json", "chat.json", "requests.jsonl", "review-requests.jsonl", "shim.log"]) {
    if (fs.existsSync(path.join(info.runDir, f))) fs.copyFileSync(path.join(info.runDir, f), path.join(archive, f));
  }
  const efficiency = info.contender === "reference" ? null : efficiencyOfArchive(archive, opts.window);
  const result: Result = {
    schema: 2,
    runId: info.runId,
    task: task.name,
    contender: info.contender,
    startedAt: info.startedAt,
    wallMs: outcome.wallMs,
    wallToGreenMs: pass ? outcome.wallMs : null,
    doneBy: outcome.doneBy,
    humanFree: outcome.humanFree,
    pass,
    checks,
    review: rev === null ? null : (({ patch: _patch, text: _text, ...kept }) => kept)(rev),
    usage,
    efficiency,
    pinning,
    valid: pinning !== null && pinning.valid && (rev === null || rev.pinned),
    env: { claudeVersion: claudeVersion(), setup: activeSetup(), loadStart: opts.loadStart, loadEnd, load: opts.load, busy: machineBusy },
    agents: opts.agents ?? usage?.sessions ?? null,
    model: MODEL,
    effort: EFFORT,
    fleetdSha: spawnSync("git", ["rev-parse", "--short", "HEAD"], { cwd: REPO_ROOT, encoding: "utf8" }).stdout.trim(),
    notes: opts.note ?? null,
    ...(outcome.extra === undefined ? {} : { extra: outcome.extra }),
  };
  fs.mkdirSync(path.join(BENCH, "results"), { recursive: true });
  const file = path.join(BENCH, "results", `${info.runId}.json`);
  fs.writeFileSync(file, `${JSON.stringify(result, null, 2)}\n`);
  log(`${pass ? "PASS" : "FAIL"}${result.valid ? "" : " (INVALID)"}${machineBusy ? " (busy machine)" : ""} ${task.name} ${info.contender}: wall ${(outcome.wallMs / 60_000).toFixed(1)} min, ${efficiency == null ? "usage n/a" : `$${efficiency.total.usd.toFixed(2)} (${efficiency.source})`}, agents ${result.agents ?? "n/a"}`);
  log(`result: ${file}`);
  if (!opts.keep) fs.rmSync(info.runDir, { recursive: true, force: true });
  return result;
};

const writeInfo = (info: RunInfo) => fs.writeFileSync(path.join(info.runDir, "run.json"), `${JSON.stringify(info, null, 2)}\n`);

// ---- the table ----

const median = (xs: ReadonlyArray<number>) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length === 0 ? null : s.length % 2 === 1 ? s[(s.length - 1) / 2]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2;
};
const minutes = (ms: number | null) => (ms === null ? "n/a" : (ms / 60_000).toFixed(1));
const tok = (t: number | null) => (t === null ? "n/a" : t < 1000 ? String(Math.round(t)) : t < 1e6 ? `${(t / 1e3).toFixed(1)}k` : `${(t / 1e6).toFixed(2)}M`);

/** Every result this harness wrote, oldest first. */
export const readResults = (since?: string) =>
  fs.existsSync(path.join(BENCH, "results"))
    ? fs
        .readdirSync(path.join(BENCH, "results"))
        .filter((f) => f.endsWith(".json"))
        .map((f) => JSON.parse(fs.readFileSync(path.join(BENCH, "results", f), "utf8")) as Result)
        .filter((r) => r.schema === 2 && (since === undefined || (r.startedAt ?? "") >= since))
        .sort((a, b) => (a.startedAt ?? "").localeCompare(b.startedAt ?? ""))
    : [];

/** An imported run's span: its session files may hold other work too. */
const windowOf = (r: Result): Window | undefined =>
  r.contender !== "t3" || r.startedAt === undefined ? undefined : { from: Date.parse(r.startedAt) - WINDOW_SLACK_MS, to: Date.parse(r.startedAt) + r.wallMs + WINDOW_SLACK_MS };

/** The results with their efficiency recomputed from each run's archive, so runs from every round count alike. */
export const withEfficiency = (results: ReadonlyArray<Result>): Array<Result> =>
  results.map((r) => {
    if (r.contender === "reference") return r;
    const fresh = efficiencyOfArchive(path.join(BENCH, "runs", r.runId), windowOf(r));
    return fresh === null ? r : { ...r, efficiency: fresh };
  });

/**
 * What the table calls each contender. `claude-p` and `t3` land their work as local commits with no PR, review or CI;
 * `claude-p+gate` and `fleetd` land it through a PR, one fresh review per head, green CI and a merge.
 */
const LABEL: Record<Contender, string> = {
  "claude-p": "claude-p (ungated)",
  "claude-p+gate": "claude-p+gate",
  fleetd: "fleetd",
  t3: "t3 (ungated)",
  reference: "reference",
};
/** The contenders the per-task summary lists: the bar fleetd is held to first, fleetd last. */
const SUMMARY: ReadonlyArray<Contender> = ["claude-p+gate", "claude-p", "t3", "fleetd"];
/** Within this wall-time ratio of the bar, fleetd counts as the same speed. */
const PARITY = 0.15;

const TOKEN_KEYS = ["input", "cacheRead", "cacheWrite5m", "cacheWrite1h", "output"] as const satisfies ReadonlyArray<keyof Tokens>;

/**
 * The plain verdict for one task: fleetd's median wall time and API $ per finished task against the bar's, both over
 * valid runs that passed the hidden checks and the blind review.
 */
export const verdict = (fleetd: { wallMs: number; usd: number }, bar: { wallMs: number; usd: number }, barName: string) => {
  const speed = fleetd.wallMs / bar.wallMs;
  const usage = fleetd.usd / bar.usd;
  const pace = speed < 1 - PARITY ? `faster (${speed.toFixed(2)}x the wall time)` : speed <= 1 + PARITY ? `similar speed (${speed.toFixed(2)}x the wall time)` : `slower (${speed.toFixed(2)}x the wall time)`;
  const spend = usage < 1 ? `${Math.round((1 - usage) * 100)}% less usage` : usage < 2 ? `${Math.round((usage - 1) * 100)}% more usage` : `${usage.toFixed(1)}x the usage`;
  return `fleetd vs ${barName}: ${pace}, ${spend} ($${fleetd.usd.toFixed(2)} vs $${bar.usd.toFixed(2)} per finished task)`;
};

const usdOfResult = (r: Result) => r.efficiency?.total.usd ?? r.usage?.usd ?? null;

/** One run's usage diagnostics: tokens by type, $ by agent role, first-request size, tool schema, idle rewrites. */
const usageRow = (r: Result, e: Efficiency) => {
  const t = e.total;
  const roles = Object.entries(e.byRole).sort(([, a], [, b]) => b.usd - a.usd);
  const byRole = roles.map(([name, u]) => `${name}${u.agents > 1 ? ` ×${u.agents}` : ""} $${u.usd.toFixed(2)} (${Math.round((u.usd / Math.max(t.usd, 1e-9)) * 100)}%)`).join("; ");
  const start = roles.filter(([, u]) => u.startContext.length > 0).map(([name, u]) => `${name} ${tok(median(u.startContext))}`).join("; ");
  const tools = roles.filter(([, u]) => u.toolsBytes !== null).map(([name, u]) => `${name} ${(u.toolsBytes! / 1024).toFixed(1)}`).join("; ");
  const idle = e.idle.gapsOverIdle === 0 ? "0" : `${e.idle.rewrites} of ${e.idle.gapsOverIdle} gaps (${tok(e.idle.rewriteTokens)}, +$${e.idle.rewriteExtraUsd.toFixed(2)})`;
  const c = e.crossCheck;
  const check =
    e.source === "proxy"
      ? `proxy; sessions ${c.sessionMessages} msgs, ${c.proxyOnly} proxy-only, ${c.sessionOnly} session-only, Δ ${tok(c.delta === null ? 0 : totalOf(c.delta))} tok`
      : `sessions; proxy ${c.proxyRequests === null ? "n/a" : `${c.proxyRequests} req`} vs ${c.sessionMessages} msgs`;
  return `| ${r.task} | ${LABEL[r.contender] ?? r.contender} | ${(r.startedAt ?? "").slice(0, 16).replace("T", " ")} | ${t.requests} | ${tok(t.input)} | ${tok(t.cacheRead)} | ${tok(t.cacheWrite5m)} | ${tok(t.cacheWrite1h)} | ${tok(t.output)} | ${t.usd.toFixed(2)} | ${byRole} | ${start} | ${tools} | ${idle} | ${check} |`;
};

/**
 * The results as markdown: one row per run; per run its usage by token type and agent role with the cache and prompt
 * diagnostics; then per task the medians of each contender's valid passing runs, their ratio to claude-p+gate, and
 * one verdict line. Reference and smoke runs are listed but never summarized.
 */
export const renderTable = (results: ReadonlyArray<Result>) => {
  const rows = results.map((r) => {
    const checks = `${r.checks.checks.filter((c) => c.pass).length}/${r.checks.checks.length}`;
    const rev = r.review === null ? "-" : r.review.blockers === null ? "no verdict" : `${r.review.blockers.length}`;
    const e = r.efficiency;
    const tokens = e != null ? (totalOf(e.total) / 1e6).toFixed(1) : r.usage === null ? "n/a" : (r.usage.totalTokens / 1e6).toFixed(1);
    const output = e != null ? `${Math.round(e.total.output / 1000)}k` : r.usage === null ? "n/a" : `${Math.round(Object.values(r.usage.byModel).reduce((n, m) => n + m.output, 0) / 1000)}k`;
    const usd = usdOfResult(r)?.toFixed(2) ?? "n/a";
    const valid = r.contender === "reference" ? "n/a" : r.valid ? "yes" : `NO: ${r.pinning?.violations[0] ?? "review not pinned"}`;
    const cli = r.pinning === null ? r.env.claudeVersion.split(" ")[0] : Object.keys(r.pinning.cliVersions).join(",") || "?";
    const peak = r.env.load === null ? "" : `, peak ${r.env.load.maxLoadavg1}`;
    const load = `${r.env.loadStart.loadavg1}→${r.env.loadEnd.loadavg1}${peak} /${r.env.loadStart.cpus}${r.env.busy ? " BUSY" : ""}`;
    const notes = [r.doneBy === "finished" ? "" : r.doneBy, r.notes ?? ""].filter(Boolean).join("; ");
    return `| ${r.task} | ${LABEL[r.contender] ?? r.contender} | ${(r.startedAt ?? "").slice(0, 16).replace("T", " ")} | ${minutes(r.wallMs)} | ${r.pass ? "PASS" : "FAIL"} | ${checks} | ${rev} | ${r.humanFree ? "yes" : "no"} | ${r.agents ?? "n/a"} | ${tokens} | ${output} | ${usd} | ${valid} | ${cli} | ${load} | ${notes} |`;
  });
  const lines = [
    "| Task | Contender | Started (UTC) | Wall (min) | Pass | Checks | Blockers | Human-free | Agents | Tokens (M) | Output | API $ | Valid | CLI | Load start→end, peak /cpus | Notes |",
    "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|",
    ...rows,
    "",
    `API $: API-equivalent dollars at claude-opus-5-5 list prices per million tokens: uncached input $${PRICE.input}, cache read $${PRICE.cacheRead.toFixed(2)},`,
    `5 min cache write $${PRICE.cacheWrite5m}, 1 h cache write $${PRICE.cacheWrite1h}, output $${PRICE.output}. Counted from the proxy's logged API responses where the run has them,`,
    "else from the claude session files (rounds 1 and 2), recomputed from each run's archive. The blind review is the bench's, not the contender's.",
    "",
    "### Usage per run",
    "",
    "Tokens by type; $ by agent role (fix: the work after a `Fix your PR` message); each role's median first-request prompt;",
    "the tool schema per request (KB, by role); cache rewrites after a gap over 5 min on the same session; where the count came from.",
    "",
    "| Task | Contender | Started (UTC) | Requests | Uncached in | Cache read | Write 5m | Write 1h | Output | API $ | $ by role | First request | Tools KB/req | Idle rewrites | Source |",
    "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|",
    ...results.flatMap((r) => (r.efficiency == null ? [] : [usageRow(r, r.efficiency)])),
    "",
    "### Per task",
    "",
    "Medians over valid runs that passed the hidden checks and the blind review (equal quality). The bar is claude-p+gate:",
    `speed parity is within ${Math.round(PARITY * 100)}% of its wall time; usage is API $ per finished task.`,
    "",
    "| Task | Contender | Passed/valid | Wall (min) | Wall vs gate | Requests | Uncached in | Cache read | Write 5m | Write 1h | Output | API $ | $ vs gate |",
    "|---|---|---|---|---|---|---|---|---|---|---|---|---|",
  ];
  const verdicts: Array<string> = [];
  for (const task of [...new Set(results.map((r) => r.task))].filter((t) => t !== "smoke").sort()) {
    const valid = (c: Contender) => results.filter((r) => r.task === task && r.contender === c && r.valid);
    const passed = (c: Contender) => valid(c).filter((r) => r.pass && usdOfResult(r) !== null);
    const med = (c: Contender) => {
      const runs = passed(c);
      if (runs.length === 0) return null;
      const of = (k: keyof Tokens) => median(runs.map((r) => r.efficiency?.total[k] ?? Number.NaN).filter(Number.isFinite));
      return { wallMs: median(runs.map((r) => r.wallMs))!, usd: median(runs.map((r) => usdOfResult(r)!))!, requests: of("requests"), ...Object.fromEntries(TOKEN_KEYS.map((k) => [k, of(k)])) };
    };
    const gate = med("claude-p+gate");
    for (const c of SUMMARY) {
      const m = med(c);
      if (valid(c).length === 0) continue;
      const ratio = (a: number | undefined, b: number | undefined) => (a === undefined || b === undefined ? "n/a" : `${(a / b).toFixed(2)}x`);
      const t = m as (Record<string, number | null> & { wallMs: number; usd: number }) | null;
      lines.push(
        `| ${task} | ${LABEL[c]} | ${passed(c).length}/${valid(c).length} | ${minutes(m?.wallMs ?? null)} | ${ratio(m?.wallMs, gate?.wallMs)} | ${tok(t?.requests ?? null)} | ${TOKEN_KEYS.map((k) => tok(t?.[k] ?? null)).join(" | ")} | ${m?.usd.toFixed(2) ?? "n/a"} | ${ratio(m?.usd, gate?.usd)} |`,
      );
    }
    const fleetd = med("fleetd");
    const ungated = med("claude-p");
    verdicts.push(
      `- ${task}: ${
        fleetd !== null && gate !== null
          ? verdict(fleetd, gate, "claude-p+gate")
          : fleetd !== null && ungated !== null
            ? `no passing claude-p+gate run yet; ${verdict(fleetd, ungated, "claude-p (ungated)")}`
            : `no verdict: needs a passing run of fleetd (${passed("fleetd").length}) and of claude-p+gate (${passed("claude-p+gate").length})`
      }.`,
    );
  }
  lines.push("", ...verdicts);
  return `${lines.join("\n")}\n`;
};

const writeTable = (since?: string) => {
  const table = renderTable(withEfficiency(readResults(since)));
  fs.mkdirSync(path.join(BENCH, "results"), { recursive: true });
  fs.writeFileSync(path.join(BENCH, "results", "TABLE.md"), table);
  process.stdout.write(table);
  log(`table: ${path.join(BENCH, "results", "TABLE.md")}`);
};

// ---- entry ----

const usage = `usage:
  bench-vs --suite [--tasks a,b] [--contenders claude-p,fleetd] [--repeat N] [--slot N] [--max-agents N]
  bench-vs --task <task> --contender <${CONTENDERS.join("|")}> [--timeout-min N] [--note text]
  bench-vs --arm <run-dir>   # right before a T3 Code thread gets the task
  bench-vs --finish <run-dir> --start <iso> --end <iso> [--logs <dir>]... [--tree <dir>] [--note text]
  bench-vs --table [--since <iso>] | --list | --publish | --unhide`;

/** Runs every task x contender in sequence, each in its own process, then writes the table. */
const suite = (args: { tasks?: string; contenders?: string; repeat?: string; slot: string; "max-agents": string; "no-review": boolean; keep: boolean }) => {
  const tasks = args.tasks === undefined ? measuredTasks() : args.tasks.split(",");
  const contenders = (args.contenders ?? "claude-p,fleetd").split(",");
  for (const c of contenders) {
    if (c === "t3") throw new Error("t3 is driven outside this script: --contender t3, then --finish");
    if (!(CONTENDERS as ReadonlyArray<string>).includes(c)) throw new Error(`unknown contender ${c}`);
  }
  for (const t of tasks) ensureBase(loadTask(t));
  const since = new Date().toISOString();
  const runs = Array.from({ length: Number(args.repeat ?? 1) }, () => tasks.flatMap((task) => contenders.map((contender) => ({ task, contender })))).flat();
  for (const [i, r] of runs.entries()) {
    log(`suite ${i + 1}/${runs.length}: ${r.task} ${r.contender}`);
    const child = spawnSync(
      process.execPath,
      [fileURLToPath(import.meta.url), "--task", r.task, "--contender", r.contender, "--slot", args.slot, "--max-agents", args["max-agents"], ...(args["no-review"] ? ["--no-review"] : []), ...(args.keep ? ["--keep"] : [])],
      { stdio: "inherit" },
    );
    if (child.status !== 0) log(`suite: ${r.task} ${r.contender} exited ${child.status ?? child.signal}; going on`);
  }
  writeTable(since);
};

async function main() {
  const { values: args } = parseArgs({
    options: {
      task: { type: "string" },
      contender: { type: "string" },
      "timeout-min": { type: "string" },
      slot: { type: "string", default: "9" },
      "max-agents": { type: "string", default: "40" },
      suite: { type: "boolean", default: false },
      tasks: { type: "string" },
      contenders: { type: "string" },
      repeat: { type: "string" },
      finish: { type: "string" },
      arm: { type: "string" },
      start: { type: "string" },
      end: { type: "string" },
      "wall-sec": { type: "string" },
      logs: { type: "string", multiple: true },
      tree: { type: "string" },
      agents: { type: "string" },
      note: { type: "string" },
      "no-review": { type: "boolean", default: false },
      keep: { type: "boolean", default: false },
      list: { type: "boolean", default: false },
      table: { type: "boolean", default: false },
      since: { type: "string" },
      publish: { type: "boolean", default: false },
      unhide: { type: "boolean", default: false },
    },
  });
  if (args.list) {
    for (const t of fs.readdirSync(path.join(HERE, "tasks")).sort()) console.log(`${t}: ${loadTask(t).title} (${loadTask(t).kind})`);
    return;
  }
  if (args.table) return writeTable(args.since);
  if (args.unhide) return unhideHidden();
  if (args.publish) {
    for (const t of fs.readdirSync(path.join(HERE, "tasks"))) ensureBase(loadTask(t));
    return log("every base is on the lab repo at its frozen sha");
  }
  if (args.suite) return suite(args);
  if (args.arm !== undefined) {
    // Just before a T3 Code thread gets its task: the load at its real start, and the checks hidden again (an
    // earlier --finish or run unhid them).
    const info = JSON.parse(fs.readFileSync(path.join(args.arm, "run.json"), "utf8")) as RunInfo;
    info.loadStart = loadSnapshot();
    writeInfo(info);
    hideHidden();
    return log(`armed ${info.runId}: load ${info.loadStart.loadavg1} on ${info.loadStart.cpus} cpus, ${info.loadStart.claudeProcesses ?? "?"} claude processes; checks hidden`);
  }
  const opts = { review: !args["no-review"], keep: args.keep, agents: args.agents === undefined ? undefined : Number(args.agents), note: args.note };

  if (args.finish !== undefined) {
    // The T3 Code run, driven outside this script: its span comes from the caller, its usage and pinning from the
    // claude session files T3 Code's claude wrote (by default the ones for the clone, under ~/.claude/projects, read
    // only), cut to that span.
    const info = JSON.parse(fs.readFileSync(path.join(args.finish, "run.json"), "utf8")) as RunInfo;
    const startMs = args.start === undefined ? Number.NaN : Date.parse(args.start);
    const endMs = args.end === undefined ? Number.NaN : Date.parse(args.end);
    let wallMs: number;
    let window: Window | undefined;
    if (Number.isFinite(startMs) && Number.isFinite(endMs) && endMs > startMs) {
      wallMs = endMs - startMs;
      window = { from: startMs - WINDOW_SLACK_MS, to: endMs + WINDOW_SLACK_MS };
      info.startedAt = new Date(startMs).toISOString();
    } else if (args["wall-sec"] !== undefined) {
      wallMs = Number(args["wall-sec"]) * 1000;
    } else {
      throw new Error("--finish needs --start <iso> and --end <iso> (sending the task to the thread saying it is done), or --wall-sec");
    }
    const logs = args.logs ?? [path.join(os.homedir(), ".claude/projects", info.work.replace(/[^a-zA-Z0-9]/gu, "-"))];
    info.usageDirs.push(...logs.map((p) => path.resolve(p)));
    if (info.usageDirs.flatMap(jsonlFiles).length === 0) throw new Error(`no claude session files under ${info.usageDirs.join(", ")}: pass --logs <dir>`);
    await finish(
      loadTask(info.task),
      info,
      { wallMs, doneBy: "finished", humanFree: true, resultTree: path.resolve(args.tree ?? info.work) },
      { ...opts, loadStart: info.loadStart ?? loadSnapshot(), load: null, proxyLog: null, ...(window === undefined ? {} : { window }) },
    );
    return;
  }

  if (args.task === undefined || !(CONTENDERS as ReadonlyArray<string>).includes(args.contender ?? "")) throw new Error(usage);
  const task = loadTask(args.task);
  const contender = args.contender as Contender;
  const timeoutMs = Number(args["timeout-min"] ?? task.timeoutMin) * 60_000;
  const runId = `${task.name}-${contender}-${stamp()}`;
  const runDir = path.join(TMP, runId);
  fs.mkdirSync(runDir, { recursive: true });
  log(`run ${runId} in ${runDir}`);
  ensureBase(task);

  const loadStart = loadSnapshot();
  log(`load at start: ${loadStart.loadavg1} on ${loadStart.cpus} cpus, ${loadStart.claudeProcesses ?? "?"} claude processes${busy(loadStart) ? " (BUSY: this run will be flagged)" : ""}`);
  const proxyLog = path.join(runDir, "requests.jsonl");

  if (contender === "reference") {
    const info = prepareLocal(task, contender, runDir);
    await finish(task, info, await reference(info), { ...opts, loadStart, load: null, proxyLog: null });
    return;
  }
  if (contender === "t3") {
    const info = { ...prepareLocal(task, contender, runDir), loadStart };
    writeInfo(info);
    hideHidden();
    console.log(`\nRight before sending the task: scripts/bench-vs --arm ${runDir}\n\nWorking directory:\n  ${info.work}\n\nTask text (send it as the first message of one new T3 Code thread in that directory, claude ${MODEL} at effort ${EFFORT}):\n-----\n${task.text}\n-----\n`);
    console.log(
      `Hidden checks are unreadable until --finish. When the thread says it is finished, import it with:\n  scripts/bench-vs --finish ${runDir} --start <when the task was sent, ISO> --end <when the thread finished, ISO> [--logs <its claude session dir>]\n`,
    );
    return;
  }

  const load = sampleLoad();
  const proxy = await runProxy(runDir);
  hideHidden();
  try {
    if (contender === "fleetd") {
      const { runFleetd } = await import("./fleetd.ts");
      const { info, outcome, agents } = await runFleetd({ task, runDir, runId, slot: Number(args.slot), maxAgents: Number(args["max-agents"]), timeoutMs, proxyUrl: proxy.url });
      await proxy.close();
      await finish(task, info, outcome, { ...opts, agents: opts.agents ?? agents, loadStart, load: load.stop(), proxyLog });
      return;
    }
    const info = prepareLocal(task, contender, runDir);
    writeInfo(info);
    if (contender === "claude-p+gate") {
      const { runGated } = await import("./gate.ts");
      const { agents, ...outcome } = await runGated({ task, info, timeoutMs, proxyUrl: proxy.url });
      await proxy.close();
      await finish(task, info, outcome, { ...opts, agents: opts.agents ?? agents, loadStart, load: load.stop(), proxyLog });
      return;
    }
    const outcome = await claudeP(task, info, timeoutMs, proxy.url);
    await proxy.close();
    await finish(task, info, outcome, { ...opts, loadStart, load: load.stop(), proxyLog });
  } finally {
    unhideHidden();
    await proxy.close();
  }
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main()
    .catch((error: unknown) => {
      unhideHidden();
      log(`FAIL ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
      process.exitCode = 1;
    })
    // A socket a contender left open (an upstream stream, a client) must not hold the suite's next run.
    .finally(() => process.exit());
}

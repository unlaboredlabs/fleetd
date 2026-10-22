// `scripts/bench-vs`: one contender on one bench task, measured the same way for everyone. Each run starts from a
// fresh clone of the task's frozen base branch in the lab repo (bench/<task>/base), runs the contender with the task
// text and no human input until it says it is finished (or the timeout), applies the task's hidden checks, runs a
// blind blocker-only review, and writes the metrics as JSON to <bench>/results/<run>.json. See docs/build/BENCH.md.
//
//   scripts/bench-vs --task tinyhttp-six --contender claude-p
//   scripts/bench-vs --task tinyhttp-six --contender fleetd [--slot 9] [--max-agents 40]
//   scripts/bench-vs --task tinyhttp-six --contender t3             # prepares a clone, prints the task, exits
//   scripts/bench-vs --finish <run-dir> --wall-sec 1234 [--usage <dir-or-jsonl>]...   # checks a t3 run
//   scripts/bench-vs --task tinyhttp-six --contender reference      # the known-good solution: tests the harness
//
// Hidden checks live outside every repo, in <bench>/checks/<task>/check.ts (FLEETD_BENCH_HOME, default
// ~/src/fleetd-lab/bench), and are never copied into a contender's tree. Runs live under /tmp/fleetd-bench
// (FLEETD_BENCH_TMP); each contender gets its own HOME there with a copy of the user's ~/.claude setup (env.ts), every
// claude pinned to one model and effort, and its API calls going through a logging proxy that proves it.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { activeSetup, busy, claudeVersion, copyClaudeSetup, EFFORT, loadSnapshot, MODEL, upstreamUrl } from "./env.ts";
import { readProxyLog, startProxy } from "./proxy.ts";
import { jsonlFiles, type Pinning, pinningOf, type Usage, usageOf } from "./usage.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, "../../..");
export const BENCH = path.resolve(process.env.FLEETD_BENCH_HOME ?? path.join(os.homedir(), "src/fleetd-lab/bench"));
export const TMP = path.resolve(process.env.FLEETD_BENCH_TMP ?? "/tmp/fleetd-bench");
export const LAB_REPO = process.env.FLEETD_BENCH_REPO ?? "unlaboredlabs/fleetd-lab";
const CONTENDERS = ["claude-p", "fleetd", "t3", "reference"] as const;
type Contender = (typeof CONTENDERS)[number];

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
}

const stamp = () => new Date().toISOString().slice(0, 19).replace(/\D/gu, "");
const run = (cmd: string, args: ReadonlyArray<string>, cwd?: string, env?: NodeJS.ProcessEnv) =>
  execFileSync(cmd, args, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 << 20 }).trim();
export const git = (cwd: string, ...args: Array<string>) => run("git", args, cwd);
export const gh = (...args: Array<string>) => run("gh", args, TMP);

/** A clone of `branch` of the lab repo at `dir`. */
export const cloneBranch = (branch: string, dir: string) => {
  fs.rmSync(dir, { recursive: true, force: true });
  run("git", ["clone", "-q", "--single-branch", "-b", branch, `https://github.com/${LAB_REPO}.git`, dir]);
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

interface Outcome {
  wallMs: number;
  doneBy: "finished" | "timeout" | "stalled" | "error";
  humanFree: boolean;
  /** The tree the checks run on. */
  resultTree: string;
  extra?: Record<string, unknown>;
}

const prepareLocal = (task: TaskDef, contender: Contender, runDir: string): RunInfo => {
  const work = path.join(runDir, "work");
  cloneBranch(task.base, work);
  // Nothing to push to: the base stays frozen, and the work stays in this clone.
  git(work, "remote", "remove", "origin");
  const info: RunInfo = { runId: path.basename(runDir), task: task.name, contender, runDir, work, baseSha: git(work, "rev-parse", "HEAD"), usageDirs: [] };
  return info;
};

const claudeP = async (task: TaskDef, info: RunInfo, timeoutMs: number, proxyUrl: string): Promise<Outcome> => {
  const home = path.join(info.runDir, "home");
  prepareClaudeHome(home, proxyUrl);
  info.usageDirs.push(path.join(home, ".claude/projects"));
  const started = Date.now();
  info.startedAt = new Date(started).toISOString();
  const { code, timedOut } = await runGroup(
    "claude",
    ["-p", "--model", MODEL, "--effort", EFFORT, "--dangerously-skip-permissions", "--output-format", "stream-json", "--verbose"],
    { cwd: info.work, env: baseEnv(home), out: path.join(info.runDir, "claude-p.stream.jsonl"), timeoutMs, stdin: task.text },
  );
  const wallMs = Date.now() - started;
  const lines = fs.readFileSync(path.join(info.runDir, "claude-p.stream.jsonl"), "utf8").split("\n").filter((l) => l.startsWith("{"));
  const result = lines.map((l) => JSON.parse(l) as Record<string, any>).findLast((e) => e.type === "result");
  const finished = !timedOut && code === 0 && result?.subtype === "success";
  scrubHome(home);
  return {
    wallMs,
    doneBy: timedOut ? "timeout" : finished ? "finished" : "error",
    humanFree: finished,
    resultTree: info.work,
    extra: { exitCode: code, cliCostUsd: result?.total_cost_usd, numTurns: result?.num_turns, finalText: String(result?.result ?? "").slice(-2000) },
  };
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

const review = async (task: TaskDef, info: RunInfo, tree: string) => {
  const dir = path.join(info.runDir, "review");
  const patch = reviewRepo(info, tree, dir);
  const home = path.join(info.runDir, "review-home");
  const proxy = await startProxy(upstreamUrl(), path.join(info.runDir, "review-requests.jsonl"));
  prepareClaudeHome(home, proxy.url);
  const prompt = fs.readFileSync(path.join(HERE, "review.md"), "utf8").replace("{{TASK}}", task.text);
  const out = path.join(info.runDir, "review.json");
  const started = Date.now();
  const { code, timedOut } = await runGroup("claude", ["-p", "--model", MODEL, "--effort", EFFORT, "--dangerously-skip-permissions", "--output-format", "json"], {
    cwd: dir,
    env: baseEnv(home),
    out,
    timeoutMs: 45 * 60_000,
    stdin: prompt,
  });
  await proxy.close();
  const sessionFiles = jsonlFiles(path.join(home, ".claude/projects"));
  const usage = usageOf(sessionFiles);
  const pinning = pinningOf(sessionFiles, readProxyLog(path.join(info.runDir, "review-requests.jsonl")), MODEL, EFFORT);
  scrubHome(home);
  let text = "";
  try {
    text = String((JSON.parse(fs.readFileSync(out, "utf8").trim().split("\n").at(-1) ?? "{}") as { result?: string }).result ?? "");
  } catch {
    // Not JSON: the review failed.
  }
  const verdict = /\{"blockers":\s*\[[\s\S]*\]\s*\}\s*$/u.exec(text.trim())?.[0];
  let blockers: Array<{ file?: string; why: string }> | null = null;
  try {
    blockers = verdict === undefined ? null : ((JSON.parse(verdict) as { blockers: Array<{ file?: string; why: string }> }).blockers ?? null);
  } catch {
    blockers = null;
  }
  return { blockers, ok: blockers !== null && !timedOut && code === 0, ms: Date.now() - started, usd: usage.usd, pinned: pinning.valid, patchBytes: patch.length, patch, text: text.slice(-4000) };
};

const archiveSessions = (dirs: ReadonlyArray<string>, to: string) => {
  for (const [i, dir] of dirs.entries()) {
    if (fs.existsSync(dir)) fs.cpSync(dir, path.join(to, `sessions-${i}`), { recursive: true });
  }
};

export interface Result {
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
  review: { blockers: Array<{ file?: string; why: string }> | null; ok: boolean; ms: number; usd: number; pinned: boolean; patchBytes: number } | null;
  usage: Usage | null;
  /** Every request and session message on MODEL at EFFORT; a run with `valid: false` does not count. */
  pinning: Pinning | null;
  /** False when the pinning check failed: the run is reported but does not count. `env.busy` flags a loaded machine. */
  valid: boolean;
  env: { claudeVersion: string; setup: ReturnType<typeof activeSetup>; loadStart: ReturnType<typeof loadSnapshot>; loadEnd: ReturnType<typeof loadSnapshot>; busy: boolean };
  agents: number | null;
  model: string;
  effort: string;
  fleetdSha: string;
  extra?: Record<string, unknown>;
}

const finish = async (task: TaskDef, info: RunInfo, outcome: Outcome, opts: { review: boolean; agents?: number; keep: boolean; loadStart: ReturnType<typeof loadSnapshot>; proxyLog: string | null }) => {
  const loadEnd = loadSnapshot();
  log(`${info.contender} done (${outcome.doneBy}) after ${(outcome.wallMs / 1000).toFixed(0)} s; hidden checks`);
  const checks = hiddenChecks(task.name, outcome.resultTree, path.join(info.runDir, "checks"));
  log(`hidden checks: ${checks.pass ? "PASS" : "FAIL"} (${checks.checks.filter((c) => c.pass).length}/${checks.checks.length})`);
  let rev: Awaited<ReturnType<typeof review>> | null = null;
  if (opts.review) {
    log("blind review");
    rev = await review(task, info, outcome.resultTree);
    log(`review: ${rev.blockers === null ? "no verdict" : `${rev.blockers.length} blocker(s)`}`);
  }
  const sessionFiles = info.usageDirs.flatMap(jsonlFiles);
  const usage = sessionFiles.length > 0 ? usageOf(sessionFiles) : null;
  const pinning = sessionFiles.length > 0 ? pinningOf(sessionFiles, opts.proxyLog === null ? null : readProxyLog(opts.proxyLog), MODEL, EFFORT) : null;
  if (pinning !== null) log(`pinning: ${pinning.valid ? "every call on" : "NOT all on"} ${MODEL} ${EFFORT}${pinning.valid ? "" : `: ${pinning.violations.join("; ")}`}`);
  const pass = checks.pass && (rev === null || (rev.ok && rev.blockers!.length === 0));
  const machineBusy = busy(opts.loadStart) || busy(loadEnd);
  const archive = path.join(BENCH, "runs", info.runId);
  fs.mkdirSync(archive, { recursive: true });
  archiveSessions(info.usageDirs, archive);
  if (rev !== null) fs.writeFileSync(path.join(archive, "result.patch"), rev.patch);
  for (const f of ["claude-p.stream.jsonl", "review.json", "chat.json", "requests.jsonl", "review-requests.jsonl", "shim.log"]) {
    if (fs.existsSync(path.join(info.runDir, f))) fs.copyFileSync(path.join(info.runDir, f), path.join(archive, f));
  }
  const result: Result = {
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
    review: rev === null ? null : { blockers: rev.blockers, ok: rev.ok, ms: rev.ms, usd: rev.usd, pinned: rev.pinned, patchBytes: rev.patchBytes },
    usage,
    pinning,
    valid: pinning?.valid !== false && (rev === null || rev.pinned),
    env: { claudeVersion: claudeVersion(), setup: activeSetup(), loadStart: opts.loadStart, loadEnd, busy: machineBusy },
    agents: opts.agents ?? usage?.sessions ?? null,
    model: MODEL,
    effort: EFFORT,
    fleetdSha: spawnSync("git", ["rev-parse", "--short", "HEAD"], { cwd: REPO_ROOT, encoding: "utf8" }).stdout.trim(),
    ...(outcome.extra === undefined ? {} : { extra: outcome.extra }),
  };
  fs.mkdirSync(path.join(BENCH, "results"), { recursive: true });
  const file = path.join(BENCH, "results", `${info.runId}.json`);
  fs.writeFileSync(file, `${JSON.stringify(result, null, 2)}\n`);
  log(`${pass ? "PASS" : "FAIL"}${result.valid ? "" : " (INVALID)"}${machineBusy ? " (busy machine)" : ""} ${task.name} ${info.contender}: wall ${(outcome.wallMs / 60_000).toFixed(1)} min, ${usage === null ? "usage n/a" : `$${usage.usd.toFixed(2)}`}, agents ${result.agents ?? "n/a"}`);
  log(`result: ${file}`);
  if (!opts.keep) fs.rmSync(info.runDir, { recursive: true, force: true });
  return result;
};

const writeInfo = (info: RunInfo) => fs.writeFileSync(path.join(info.runDir, "run.json"), `${JSON.stringify(info, null, 2)}\n`);

async function main() {
  const { values: args } = parseArgs({
    options: {
      task: { type: "string" },
      contender: { type: "string" },
      "timeout-min": { type: "string" },
      slot: { type: "string", default: "9" },
      "max-agents": { type: "string", default: "40" },
      finish: { type: "string" },
      "wall-sec": { type: "string" },
      usage: { type: "string", multiple: true },
      agents: { type: "string" },
      "no-review": { type: "boolean", default: false },
      keep: { type: "boolean", default: false },
      list: { type: "boolean", default: false },
    },
  });
  if (args.list) {
    for (const t of fs.readdirSync(path.join(HERE, "tasks"))) console.log(`${t}: ${loadTask(t).title}`);
    return;
  }
  const opts = { review: !args["no-review"], keep: args.keep, agents: args.agents === undefined ? undefined : Number(args.agents) };

  if (args.finish !== undefined) {
    // A run whose contender ran outside this script (T3 Code): its wall time and usage come from the caller.
    const info = JSON.parse(fs.readFileSync(path.join(args.finish, "run.json"), "utf8")) as RunInfo;
    if (args["wall-sec"] === undefined) throw new Error("--finish needs --wall-sec <seconds from sending the task to the agent saying it is done>");
    info.usageDirs.push(...(args.usage ?? []).map((p) => path.resolve(p)));
    const loadStart = (JSON.parse(fs.readFileSync(path.join(args.finish, "run.json"), "utf8")) as { loadStart?: ReturnType<typeof loadSnapshot> }).loadStart ?? loadSnapshot();
    await finish(loadTask(info.task), info, { wallMs: Number(args["wall-sec"]) * 1000, doneBy: "finished", humanFree: true, resultTree: info.work }, { ...opts, loadStart, proxyLog: null });
    return;
  }

  if (args.task === undefined || !(CONTENDERS as ReadonlyArray<string>).includes(args.contender ?? "")) {
    throw new Error(`usage: bench-vs --task <task> --contender <${CONTENDERS.join("|")}>  (or --list, or --finish <run-dir> --wall-sec N)`);
  }
  const task = loadTask(args.task);
  const contender = args.contender as Contender;
  const timeoutMs = Number(args["timeout-min"] ?? task.timeoutMin) * 60_000;
  const runId = `${task.name}-${contender}-${stamp()}`;
  const runDir = path.join(TMP, runId);
  fs.mkdirSync(runDir, { recursive: true });
  log(`run ${runId} in ${runDir}`);

  const loadStart = loadSnapshot();
  log(`load at start: ${loadStart.loadavg1} on ${loadStart.cpus} cpus, ${loadStart.claudeProcesses ?? "?"} claude processes${busy(loadStart) ? " (BUSY: this run will be flagged)" : ""}`);
  const proxyLog = path.join(runDir, "requests.jsonl");

  if (contender === "fleetd") {
    const { runFleetd } = await import("./fleetd.ts");
    const proxy = await runProxy(runDir);
    try {
      const { info, outcome, agents } = await runFleetd({ task, runDir, runId, slot: Number(args.slot), maxAgents: Number(args["max-agents"]), timeoutMs, proxyUrl: proxy.url });
      await proxy.close();
      await finish(task, info, outcome, { ...opts, agents: opts.agents ?? agents, loadStart, proxyLog });
    } finally {
      await proxy.close();
    }
    return;
  }

  const info = prepareLocal(task, contender, runDir);
  writeInfo(info);
  if (contender === "t3") {
    fs.writeFileSync(path.join(runDir, "run.json"), `${JSON.stringify({ ...info, loadStart }, null, 2)}\n`);
    console.log(`\nWorking directory:\n  ${info.work}\n\nTask text (send it as the first message of a new thread in that directory):\n-----\n${task.text}\n-----\n`);
    console.log(`When the thread says it is finished, record the result with:\n  scripts/bench-vs --finish ${runDir} --wall-sec <seconds> --usage <the thread's claude session JSONL dir>\n`);
    return;
  }
  if (contender === "reference") {
    await finish(task, info, await reference(info), { ...opts, loadStart, proxyLog: null });
    return;
  }
  const proxy = await runProxy(runDir);
  try {
    const outcome = await claudeP(task, info, timeoutMs, proxy.url);
    await proxy.close();
    await finish(task, info, outcome, { ...opts, loadStart, proxyLog });
  } finally {
    await proxy.close();
  }
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    log(`FAIL ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
    process.exitCode = 1;
  });
}

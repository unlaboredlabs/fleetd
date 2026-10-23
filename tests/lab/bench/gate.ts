// The `claude-p+gate` contender: `claude -p` does the task exactly as the ungated `claude-p` does (the same clone of the
// frozen base, the same prompt, no remote), and then its result pays the gate fleetd's work pays before it counts: one
// PR against a fresh run branch of the lab repo, one fresh reviewer pinned like everything else and given fleetd's own
// reviewer prompt, the repo's CI green on that head, and a squash merge. Blocking findings or red CI go back to the same
// claude session (`--resume`) with fleetd's fix message; the new head is reviewed again (fleetd's delta prompt) and runs
// CI again. Done is the merge, timed by GitHub's mergedAt; the result is the run branch after it.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { claudeSession, cloneBranch, gh, git, LAB_REPO, log, prepareClaudeHome, REPO_ROOT, type RunInfo, scrubHome, type TaskDef } from "./benchVs.ts";

/** CI is polled this often; fleetd's train polls every 15 s, so this favors the gated contender, if anything. */
const CI_POLL_MS = 5_000;
/** A head with no check run after this long: CI never started. */
const CI_START_MS = 5 * 60_000;
/** Review and fix rounds before the run gives up unmerged. */
const MAX_ROUNDS = 6;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const prompt = (name: string) => fs.readFileSync(path.join(REPO_ROOT, "crates/fleetd/assets/prompts", `${name}.md`), "utf8").replace(/\n$/u, "");
/** fleetd's `{{name}}` rendering: unknown names stay as written. */
const render = (template: string, vars: Record<string, string>) => template.replace(/\{\{(\w+)\}\}/gu, (m, k: string) => vars[k] ?? m);

type Verdict = { blocking: number; nonBlocking: number; summary: string };

/** The reviewer's verdict: the last `{"blocking": ...}` JSON object in its reply; null when there is none. */
export const gateVerdictOf = (text: string): Verdict | null => {
  const starts = [...text.matchAll(/\{\s*"blocking"\s*:/gu)].map((m) => m.index).reverse();
  for (const start of starts) {
    const tail = text.slice(start);
    for (let end = tail.lastIndexOf("}"); end > 0; end = tail.lastIndexOf("}", end - 1)) {
      try {
        const v = JSON.parse(tail.slice(0, end + 1)) as Partial<Verdict>;
        if (typeof v.blocking === "number") return { blocking: v.blocking, nonBlocking: Number(v.nonBlocking ?? 0), summary: String(v.summary ?? "") };
      } catch {
        // Not this closing brace.
      }
    }
  }
  return null;
};

/**
 * The reviewer's first message, built as fleetd builds a review task's: `task.brief.review` around `review.reviewer`
 * (plus `review.delta` on a re-review), the task text as the workstream's goal. fleetd's `report` and `ask_lead` tools
 * don't exist here, so one appended paragraph says where the verdict goes instead.
 */
const reviewPrompt = (task: TaskDef, pr: { url: string; number: number; headSha: string }, round: number, reviewedSha?: string) => {
  let review = render(prompt("review.reviewer"), { prUrl: pr.url, headSha: pr.headSha, prNumber: String(pr.number), repo: LAB_REPO });
  if (reviewedSha !== undefined && reviewedSha !== pr.headSha) review += `\n\n${render(prompt("review.delta"), { reviewedSha, headSha: pr.headSha })}`;
  const brief = render(prompt("task.brief.review"), {
    taskId: `review-${round}`,
    kind: "review",
    workstreamId: "bench",
    project: task.name,
    title: `Review PR #${pr.number}`,
    task: review,
    workstream: `\n\n## Workstream\nGoal:\n${task.text}\nDone when: everything the goal asks for is done.`,
  });
  return `${brief}\n\n## In this session\nfleetd's \`report\` and \`ask_lead\` tools are not available. Decide on your own, and give your verdict as the last line of your final message, one line of JSON and nothing after it: {"blocking": <count>, "nonBlocking": <count>, "summary": "<the summary the report tool would take, naming each blocking finding as path:line>"}`;
};

/** The writer's fix message: fleetd's `pr.fix`, plus where its commit goes in this run (it has no remote). */
const fixPrompt = (pr: { url: string }, branch: string, problem: string, findings: string) =>
  `${render(prompt("pr.fix"), { pr: `${pr.url} (claude-p)`, problem, findings: findings.trim() === "" ? "" : `\n\n${findings.trim()}\n`, branch })}\n\nThis checkout has no remote: commit the fix here, on the branch checked out now, and stop. The harness pushes it to the same PR.`;

/** The head's CI: every check run completed (green when all succeeded or were skipped), or null when it never started. */
const waitCi = async (sha: string, deadline: number, stop: { stopped: boolean }) => {
  const started = Date.now();
  while (!stop.stopped && Date.now() < deadline) {
    const runs = JSON.parse(gh("api", `repos/${LAB_REPO}/commits/${sha}/check-runs`, "--jq", "[.check_runs[] | {name, status, conclusion}]")) as Array<{ name: string; status: string; conclusion: string | null }>;
    if (runs.length > 0 && runs.every((r) => r.status === "completed")) {
      const red = runs.filter((r) => !["success", "skipped", "neutral"].includes(r.conclusion ?? ""));
      return { green: red.length === 0, failed: red.map((r) => `${r.name}: ${r.conclusion}`), ms: Date.now() - started };
    }
    if (runs.length === 0 && Date.now() - started > CI_START_MS) return null;
    await sleep(CI_POLL_MS);
  }
  return null;
};

/** The tail of the failed CI logs of `sha`, for the fix message. */
const failedLog = (sha: string) => {
  const ids = JSON.parse(gh("run", "list", "-R", LAB_REPO, "--commit", sha, "--json", "databaseId,conclusion")) as Array<{ databaseId: number; conclusion: string }>;
  const failed = ids.find((r) => r.conclusion === "failure");
  if (failed === undefined) return "";
  const out = spawnSync("gh", ["run", "view", String(failed.databaseId), "-R", LAB_REPO, "--log-failed"], { encoding: "utf8", maxBuffer: 64 << 20 });
  return (out.stdout ?? "").slice(-3000);
};

/** The user's gh login, copied into `home` so the reviewer can read the PR (scrubHome removes it). */
const copyGhLogin = (home: string) => {
  const from = path.join(os.homedir(), ".config/gh");
  if (!fs.existsSync(path.join(from, "hosts.yml"))) throw new Error("claude-p+gate needs your gh login: ~/.config/gh/hosts.yml is missing");
  fs.mkdirSync(path.join(home, ".config/gh"), { recursive: true, mode: 0o700 });
  for (const f of ["hosts.yml", "config.yml"].filter((f) => fs.existsSync(path.join(from, f)))) {
    fs.copyFileSync(path.join(from, f), path.join(home, ".config/gh", f));
    fs.chmodSync(path.join(home, ".config/gh", f), 0o600);
  }
};

/** Commits whatever the writer left uncommitted (the ungated run's checks read the working tree, so it counts there too). */
const commitLeftovers = (work: string, what: string) => {
  if (git(work, "status", "--porcelain") === "") return;
  git(work, "add", "-A");
  git(work, "commit", "-q", "--no-verify", "-m", `bench: ${what} left uncommitted`);
};

export async function runGated(opts: { task: TaskDef; info: RunInfo; timeoutMs: number; proxyUrl: string }) {
  const { task, info, timeoutMs, proxyUrl } = opts;
  const runStamp = /\d{14}$/u.exec(info.runId)?.[0] ?? String(Date.now());
  const runBranch = `bench/${task.name}/run-${runStamp}/main`;
  const headBranch = `bench/${task.name}/run-${runStamp}/claude-p`;
  gh("api", "-X", "POST", `repos/${LAB_REPO}/git/refs`, "-f", `ref=refs/heads/${runBranch}`, "-f", `sha=${info.baseSha}`, "--silent");
  log(`run branch ${runBranch} at ${info.baseSha.slice(0, 7)}`);
  const home = path.join(info.runDir, "home");
  prepareClaudeHome(home, proxyUrl);
  info.usageDirs.push(path.join(home, ".claude/projects"));
  const stream = path.join(info.runDir, "claude-p.stream.jsonl");
  const rounds: Array<Record<string, unknown>> = [];
  const started = Date.now();
  info.startedAt = new Date(started).toISOString();
  const deadline = started + timeoutMs;
  const left = () => Math.max(1_000, deadline - Date.now());
  let doneBy: "finished" | "timeout" | "error" = "error";
  let wallMs = timeoutMs;
  let why = "";
  let pr: { url: string; number: number; headSha: string } | undefined;
  let reviews = 0;
  try {
    const first = await claudeSession({ home, cwd: info.work, prompt: task.text, stream, timeoutMs: left() });
    const writerMs = Date.now() - started;
    log(`claude -p exited after ${(writerMs / 60_000).toFixed(1)} min${first.finished ? "" : " (not finished)"}; the gate starts`);
    rounds.push({ writerExitMs: writerMs });
    const sessionId = first.sessionId;
    if (!first.finished || sessionId === undefined) throw new Error(first.timedOut ? "timeout" : "claude -p did not finish");
    const push = () => {
      commitLeftovers(info.work, "the writer");
      if (git(info.work, "rev-list", "--count", `${info.baseSha}..HEAD`) === "0") throw new Error("claude -p committed nothing");
      git(info.work, "push", "-q", "--force", `https://github.com/${LAB_REPO}.git`, `HEAD:refs/heads/${headBranch}`);
      return git(info.work, "rev-parse", "HEAD");
    };
    let headSha = push();
    const subject = git(info.work, "log", "--format=%s", "--reverse", `${info.baseSha}..HEAD`).split("\n")[0] || task.title;
    const url = gh("pr", "create", "-R", LAB_REPO, "--base", runBranch, "--head", headBranch, "--title", subject.slice(0, 200), "--body", `claude -p's result for the bench task ${task.name}.`);
    pr = { url, number: Number(/\/pull\/(\d+)/u.exec(url)?.[1]), headSha };
    log(`PR ${url} at ${headSha.slice(0, 7)}`);
    let reviewedSha: string | undefined;
    for (let round = 1; ; round++) {
      if (round > MAX_ROUNDS) throw new Error(`no clean, green head after ${MAX_ROUNDS} rounds`);
      if (Date.now() >= deadline) throw new Error("timeout");
      pr.headSha = headSha;
      const roundStart = Date.now();
      // CI runs alongside the review, as fleetd's does.
      const stopCi = { stopped: false };
      const ci = waitCi(headSha, deadline, stopCi);
      reviews++;
      const rhome = path.join(info.runDir, `reviewer-${round}`);
      const rwork = path.join(rhome, "repo");
      cloneBranch(headBranch, rwork);
      prepareClaudeHome(rhome, proxyUrl);
      copyGhLogin(rhome);
      info.usageDirs.push(path.join(rhome, ".claude/projects"));
      let verdict: Verdict | null;
      try {
        const r = await claudeSession({ home: rhome, cwd: rwork, prompt: reviewPrompt(task, pr, round, reviewedSha), stream: path.join(info.runDir, `reviewer-${round}.stream.jsonl`), timeoutMs: left() });
        verdict = gateVerdictOf(String(r.result?.result ?? ""));
      } finally {
        scrubHome(rhome);
      }
      reviewedSha = headSha;
      const reviewMs = Date.now() - roundStart;
      log(`review ${round} of ${headSha.slice(0, 7)}: ${verdict === null ? "no verdict" : `${verdict.blocking} blocking, ${verdict.nonBlocking} non-blocking`} (${(reviewMs / 1000).toFixed(0)} s)`);
      let fix: { problem: string; findings: string } | undefined;
      if (verdict === null) {
        stopCi.stopped = true;
        throw new Error("the reviewer gave no verdict");
      }
      if (verdict.blocking > 0) {
        stopCi.stopped = true;
        fix = { problem: `review review-${round} at ${headSha.slice(0, 12)} found ${verdict.blocking} blocking finding${verdict.blocking === 1 ? "" : "s"} (${verdict.nonBlocking} non-blocking)`, findings: verdict.summary };
        rounds.push({ round, headSha, reviewMs, verdict });
      } else {
        const result = await ci;
        rounds.push({ round, headSha, reviewMs, verdict, ci: result, ciDoneAfterReviewMs: Date.now() - roundStart - reviewMs });
        if (result === null) throw new Error(Date.now() >= deadline ? "timeout" : "CI never started on the PR");
        log(`CI on ${headSha.slice(0, 7)}: ${result.green ? "green" : `red (${result.failed.join(", ")})`}`);
        if (result.green) break;
        fix = { problem: `CI failed on ${headSha.slice(0, 12)}: ${result.failed.join(", ")}`, findings: failedLog(headSha) };
      }
      const fixed = await claudeSession({ home, cwd: info.work, prompt: fixPrompt(pr, headBranch, fix.problem, fix.findings), stream, timeoutMs: left(), resume: sessionId });
      if (!fixed.finished) throw new Error(fixed.timedOut ? "timeout" : "the fix session did not finish");
      const before = headSha;
      headSha = push();
      log(`fix ${round}: ${before.slice(0, 7)} -> ${headSha.slice(0, 7)}`);
    }
    gh("pr", "merge", String(pr.number), "-R", LAB_REPO, "--squash", "--match-head-commit", headSha);
    const merged = JSON.parse(gh("pr", "view", String(pr.number), "-R", LAB_REPO, "--json", "mergedAt")) as { mergedAt: string | null };
    if (merged.mergedAt === null) throw new Error("the merge did not land");
    // The merge is the gated run's done event, timed by GitHub, as fleetd's last merge is.
    wallMs = Date.parse(merged.mergedAt) - started;
    doneBy = "finished";
    log(`merged at ${merged.mergedAt}: ${(wallMs / 60_000).toFixed(1)} min`);
  } catch (error) {
    why = error instanceof Error ? error.message : String(error);
    doneBy = why === "timeout" ? "timeout" : "error";
    wallMs = Math.min(Date.now() - started, timeoutMs);
    log(`claude-p+gate stopped unmerged: ${why}`);
  } finally {
    scrubHome(home);
  }
  // What landed: the run branch, unchanged when nothing merged.
  const result = path.join(info.runDir, "result");
  cloneBranch(runBranch, result);
  return {
    wallMs,
    doneBy,
    humanFree: doneBy === "finished",
    resultTree: result,
    agents: 1 + reviews,
    extra: { runBranch, pr: pr ?? null, rounds, ...(why === "" ? {} : { stoppedBecause: why }) },
  };
}

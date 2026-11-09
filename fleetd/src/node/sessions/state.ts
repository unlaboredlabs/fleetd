// The session service's decisions, kept pure (crates/fleetd/src/node/sessions/state.rs): a summary's derived fields,
// how runs close when a process ends, permission answers from policy, and the bounded copies of items that go over
// the link.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { headUtf16, tailUtf16 } from "../util.ts";
import { ALWAYS_DISALLOWED } from "../runner/claude.ts";
import type { SessionLocal } from "./store.ts";
import { isActive, RESUME_REFUSED, type FailureClass, type PermissionDecision, type RunEnd, type RunFailure, type RunInfo, type RuntimeMode, type SessionSummary, type ThreadItem } from "./types.ts";

/** Item outputs longer than this go over the link cut to their tail; `read_item` returns them whole. */
export const OUTPUT_KEPT = 8 * 1024;
export const ASSISTANT_TAIL = 2000;

/** Recomputes what a summary derives from its runs: the latest run, the active one, and the status. */
export function settle(summary: SessionSummary, runs: RunInfo[], at: string): void {
  const neverRan = (r: RunInfo) => r.status === "interrupted" && r.startedAt === undefined;
  const byOrdinal = (rs: RunInfo[]) => rs.reduce<RunInfo | undefined>((m, r) => (!m || r.ordinal >= m.ordinal ? r : m), undefined);
  const latest = byOrdinal(runs.filter((r) => !neverRan(r))) ?? byOrdinal(runs);
  if (latest) summary.latestRun = { ...latest };
  else delete summary.latestRun;
  const active = runs.filter((r) => isActive(r.status)).reduce<RunInfo | undefined>((m, r) => (!m || r.ordinal < m.ordinal ? r : m), undefined);
  if (active) summary.activeRunId = active.id;
  else {
    delete summary.activeRunId;
    delete summary.pendingPermission;
  }
  summary.status = summary.pendingPermission
    ? "waiting"
    : active
      ? "running"
      : summary.latestRun?.status === "failed"
        ? "failed"
        : summary.latestRun?.status === "interrupted"
          ? "interrupted"
          : "idle";
  summary.updatedAt = at;
}

export type ExitInfo = { code: number | null; signal: number | null; stderr_tail: string };

/** Why a process ended while runs were still active. */
export type EndCause =
  | { kind: "requested"; why: string }
  | { kind: "node_stopping" }
  | { kind: "node_restarted" }
  | { kind: "exited"; exit: ExitInfo };

export const asked = (c: EndCause) => c.kind === "requested" || c.kind === "node_stopping";
export const causeEnd = (c: EndCause): RunEnd =>
  c.kind === "requested" ? "requested" : c.kind === "node_stopping" ? "node_stopping" : c.kind === "node_restarted" ? "node_restarted" : "exited";
export const causeEndedBy = (c: EndCause) => (c.kind === "requested" && c.why.trim() ? headUtf16(c.why.trim(), 200) : undefined);

function describeExit(exit: ExitInfo): string {
  const how =
    exit.signal !== null
      ? `the agent was killed by signal ${exit.signal}`
      : exit.code !== null
        ? `the agent exited with code ${exit.code}`
        : "the agent exited";
  const stderr = exit.stderr_tail.trim();
  return stderr ? `${how} before the run ended\n--- stderr tail ---\n${stderr}` : `${how} before the run ended`;
}

export const causeMessage = (c: EndCause) =>
  c.kind === "requested" ? c.why : c.kind === "node_stopping" ? "the node stopped" : c.kind === "node_restarted" ? "node restarted mid-run" : describeExit(c.exit);

/** The failure of a run that ended because of `message`. */
export const endedBy = (message: string): RunFailure => ({ class: "process_exited", message: tailUtf16(message, 4000) || "ended", retries: 0 });

/** Closes every active run of a process that is gone. The indexes of the runs it changed. */
export function closeOut(runs: RunInfo[], cause: EndCause, at: string): number[] {
  const changed: number[] = [];
  runs.forEach((run, i) => {
    if (!isActive(run.status)) return;
    run.status = cause.kind === "exited" ? "failed" : "interrupted";
    run.endedAt = at;
    run.failure = endedBy(causeMessage(cause));
    run.end = causeEnd(cause);
    const by = causeEndedBy(cause);
    if (by) run.endedBy = by;
    else delete run.endedBy;
    changed.push(i);
  });
  return changed;
}

/** The run a runner's end of `runId` ends: that run while active, else the active one when no run has that id. */
export function ending(runs: RunInfo[], runId: string): number | undefined {
  const at = runs.findIndex((r) => r.id === runId);
  if (at >= 0) return isActive(runs[at]!.status) ? at : undefined;
  const active = runs.findIndex((r) => isActive(r.status));
  return active < 0 ? undefined : active;
}

/** claude's words when its context is full (runner/claude/failure.rs `context_full_text`). */
export const contextFull = (text: string) => /prompt is too long|context (?:window|length)|maximum context|exceeds? the model's context/i.test(text);

export function failureEnd(failure: RunFailure): RunEnd {
  const limited: FailureClass[] = ["usage_limit", "rate_limit", "pool_exhausted"];
  if (limited.includes(failure.class)) return "limited";
  if (failure.class === "process_exited") return "exited";
  if (failure.class === "invalid_request" && contextFull(failure.message)) return "context_full";
  return "failed";
}

export type RunOutcome =
  | { Completed: { text: string } }
  | "Interrupted"
  | { Superseded: { by: string } }
  | { Failed: RunFailure };

export function runEnd(outcome: RunOutcome, cause: EndCause | undefined, slept: boolean): RunEnd {
  if (typeof outcome === "object" && "Completed" in outcome) return "completed";
  if (typeof outcome === "object" && "Superseded" in outcome) return "superseded";
  if (slept) return "machine_slept";
  if (outcome === "Interrupted") return cause ? causeEnd(cause) : "requested";
  return failureEnd(outcome.Failed);
}

/** `<claude config dir>/projects/<cwd, every non-alphanumeric as ->/<session>.jsonl`. */
export function claudeSessionFile(configDir: string, cwd: string, sessionId: string): string {
  return join(configDir, "projects", cwd.replace(/[^A-Za-z0-9]/g, "-"), `${sessionId}.jsonl`);
}

/** Whether the next start resumes, or (throws) why it must not start: a session resumes only in the config dir it
 * was started with. */
export function startMode(local: SessionLocal, configDir: string, sessionId: string): boolean {
  if (!local.started) return false;
  if (local.configDir !== configDir && existsSync(claudeSessionFile(local.configDir, local.cwd, sessionId)))
    throw new Error(
      `${RESUME_REFUSED}session ${sessionId} was started with the claude config dir ${local.configDir} and cannot resume under ${configDir}: claude keeps the conversation there. Point the machine back at it ("claudeConfigDir": "${local.configDir}" in the node's node.json, then restart the node), or start a new session`,
    );
  return true;
}

/** A permission prompt the node answers itself: every ask of a session held to its allowed tools, tools fleetd never
 * gives an agent, everything under full access. undefined: the hub (a person) answers. A lead's commands in manual
 * mode (claude::role_answer) go to the hub here: the shell guard is the hub's code, not ported to the node. */
export function autoAnswer(mode: RuntimeMode, allowedOnly: boolean, toolName: string, input: unknown): PermissionDecision | undefined {
  if (allowedOnly) return { behavior: "deny", message: `fleetd policy: ${toolName} is not one of the tools this session may use` };
  if (ALWAYS_DISALLOWED.includes(toolName)) return { behavior: "deny", message: `fleetd policy: ${toolName} is not available to fleetd sessions` };
  return mode === "full-access" ? { behavior: "allow", updatedInput: input } : undefined;
}

/** The copy of an item that goes over the link: outputs over OUTPUT_KEPT cut to their tail. */
export function bounded(item: ThreadItem): ThreadItem {
  const kind = item.kind;
  if ((kind.type === "command" || kind.type === "tool") && kind.output !== undefined && Buffer.byteLength(kind.output) > OUTPUT_KEPT) {
    const bytes = Buffer.from(kind.output);
    let start = bytes.length - OUTPUT_KEPT;
    while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) start++;
    return { ...item, kind: { ...kind, output: bytes.subarray(start).toString("utf8"), outputOmitted: true } };
  }
  return item;
}

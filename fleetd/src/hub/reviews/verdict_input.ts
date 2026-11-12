// A review's verdict as the contract checks it and as it is stored, and one key per PR (verdicts.ts records them).
import type { ProjectRef } from "../../shared/contracts.ts";
import { ToolError } from "../../shared/errors.ts";

/** A review task's verdict (contracts `verification::ReviewVerdict`, Rust-only). */
export type ReviewVerdict = {
  taskId?: string;
  prHeadSha?: string;
  blocking: number;
  nonBlocking: number;
  summary: string;
};

/** Who is recording: the lead's project and its `by`, and the task when the call comes from a task's session. */
export type VerdictCaller = { projectRef: ProjectRef; by: string; task?: string };

/** One key per PR however its URL is written: host and path, lowercased, `/pulls/` as `/pull/`, no trailing slash. */
export function prKey(url: string): string {
  const trimmed = url.trim();
  let u: URL;
  try {
    u = new URL(trimmed);
  } catch {
    return trimmed.toLowerCase();
  }
  if (u.host === "") return trimmed.toLowerCase();
  return `${u.host}${u.pathname}`.toLowerCase().replace("/pulls/", "/pull/").replace(/\/+$/, "");
}

const SHA = /^[0-9a-f]{40}$/;

/** The verdict's fields as the contract checks them; refused as `invalid` otherwise. */
export function readVerdict(raw: Record<string, unknown>): ReviewVerdict {
  const count = (k: string) => {
    const v = raw[k];
    if (typeof v !== "number" || !Number.isInteger(v) || v < 0) throw new ToolError("invalid", `${k}: expected a count`);
    return v;
  };
  const summary = raw.summary;
  if (typeof summary !== "string" || [...summary].length < 1 || [...summary].length > 4000) {
    throw new ToolError("invalid", "summary: expected text of 1 to 4000 characters");
  }
  const out: ReviewVerdict = { blocking: count("blocking"), nonBlocking: count("nonBlocking"), summary };
  if (raw.taskId != null) {
    if (typeof raw.taskId !== "string" || !/^T[1-9]\d*$/.test(raw.taskId)) throw new ToolError("invalid", "taskId: expected a task id");
    out.taskId = raw.taskId;
  }
  if (raw.prHeadSha != null) {
    if (typeof raw.prHeadSha !== "string" || !SHA.test(raw.prHeadSha)) {
      throw new ToolError("invalid", "prHeadSha: expected a full lowercase commit SHA");
    }
    out.prHeadSha = raw.prHeadSha;
  }
  return out;
}

/** In the Rust struct's field order, its absent fields left out. */
export const encode = (v: ReviewVerdict) =>
  JSON.stringify({
    ...(v.taskId !== undefined ? { taskId: v.taskId } : {}),
    ...(v.prHeadSha !== undefined ? { prHeadSha: v.prHeadSha } : {}),
    blocking: v.blocking,
    nonBlocking: v.nonBlocking,
    summary: v.summary,
  });

// The in-memory shapes the pure parts of the time area read: stored spans as
// rows, and what a critical path walk needs about an order.
import type { Category, SpanExtra, SpanKind, SpanStatus } from "../../shared/contracts.ts";
import { categoryOf } from "./kinds.ts";

/** A stored span. Open spans are cut at the query's `until` by the loader, so `endMs` is always set. */
export type Row = {
  id: number;
  kind: SpanKind;
  startMs: number;
  endMs: number;
  /** Exclusive time. 0 on envelopes and on detail spans that sit beside the lane's tiling. */
  exclMs: number;
  lane: string;
  parentId?: number;
  labelId?: number;
  label?: string;
  /** The program: "cargo test", "git push", "Read", "mcp__x__y". */
  family?: string;
  exitCode?: number;
  outBytes?: number;
  status: SpanStatus;
  machineId?: string;
  projectId?: string;
  workstreamId?: string;
  taskId?: string;
  threadId?: string;
  /** The session's role: "lead", "implementer", "reviewer"… */
  role?: string;
  profile?: string;
  extra: SpanExtra;
};

export const rowCat = (r: Row): Category => categoryOf(r.kind);
export const dur = (r: Row) => Math.max(r.endMs - r.startMs, 0);

/** Which span owns an instant its lane shares with another span. */
export function rank(kind: SpanKind): number {
  switch (kind) {
    case "wait.permission":
      return 9;
    case "wait.retry.api":
    case "compaction":
      return 8;
    case "tools.parallel":
      return 7;
    case "tool.bash":
    case "tool.read":
    case "tool.edit":
    case "tool.web":
    case "tool.mcp":
    case "tool.other":
    case "git":
      return 6;
    case "model.first_token":
    case "model.thinking":
    case "model.output":
      return 4;
    case "wake.debounce":
    case "run.queued":
    case "run.startup":
    case "park.usage":
    case "wait.offline":
    case "wait.retry.node":
      return 1;
    case "model.message":
      return 3;
    case "run":
    case "gap":
    case "ci.check":
    case "ci.queue":
      return 0;
    default:
      return 5;
  }
}

/** Spans that sit beside a lane's tiling instead of in it: they never own an instant. */
export const isDetail = (kind: SpanKind) => kind === "run" || kind === "ci.check" || kind === "ci.queue" || kind === "gap";

/** What a critical-path walk needs about one order. */
export type PathInput = {
  /** `intake.route` start or `workstream.created`. */
  startMs: number;
  /** `workstream.done`, or now. */
  endMs: number;
  rows: Row[];
  /** Lane -> the lanes it waits on. */
  waitsOn: Map<string, string[]>;
};

/** The inputs of the insight rules over one period. */
export type RuleInput = { rows: Row[]; taskTitles: Map<string, string> };

// Span kinds and categories (crates/fleetd-contracts/src/time.rs `span_kinds!`, `Category`), converted from the Rust
// table: each kind's stored code, which never changes, and its category.
import type { Category, SpanKind, SpanStatus } from "../../shared/contracts.ts";

/** Category codes, in the Rust enum's order. */
export const CATEGORIES: Category[] = ["model", "tools", "machine", "queue", "human", "pipeline", "idle"];

export const KINDS: [kind: SpanKind, code: number, cat: Category][] = [
  ["run", 1, "machine"],
  ["model.message", 2, "model"],
  ["model.first_token", 3, "model"],
  ["model.thinking", 4, "model"],
  ["model.output", 5, "model"],
  ["tool.bash", 10, "tools"],
  ["tool.read", 11, "tools"],
  ["tool.edit", 12, "tools"],
  ["tool.web", 13, "tools"],
  ["tool.mcp", 14, "tools"],
  ["tool.other", 15, "tools"],
  ["tools.parallel", 16, "tools"],
  ["git", 17, "tools"],
  ["wait.retry.api", 20, "machine"],
  ["wait.retry.node", 21, "machine"],
  ["run.startup", 22, "machine"],
  ["compaction", 23, "machine"],
  ["runner.other", 24, "machine"],
  ["wait.offline", 25, "machine"],
  ["queue.slot", 30, "queue"],
  ["queue.lease", 31, "queue"],
  ["queue.usage", 32, "queue"],
  ["queue.offline", 33, "queue"],
  ["run.queued", 34, "queue"],
  ["wake.debounce", 35, "queue"],
  ["park.usage", 36, "queue"],
  ["wait.permission", 40, "human"],
  ["wait.request", 41, "human"],
  ["change.review", 50, "pipeline"],
  ["change.queue", 51, "pipeline"],
  ["change.rebase", 52, "pipeline"],
  ["change.ci", 53, "pipeline"],
  ["ci.check", 54, "pipeline"],
  ["ci.queue", 55, "pipeline"],
  ["change.merge", 56, "pipeline"],
  ["change.blocked", 57, "pipeline"],
  ["intake.route", 58, "pipeline"],
  ["idle", 60, "idle"],
  ["gap", 61, "idle"],
];

const BY_NAME = new Map(KINDS.map(([k, code, cat]) => [k as string, { code, cat }]));
const BY_CODE = new Map(KINDS.map(([k, code]) => [code, k]));

export const kindCode = (k: SpanKind) => BY_NAME.get(k)?.code ?? 24;
export const kindOf = (code: number): SpanKind | undefined => BY_CODE.get(code);
/** A kind's name, `claude.other` read as `runner.other` as the Rust serde alias does. */
export const parseKind = (name: string): SpanKind | undefined =>
  name === "claude.other" ? "runner.other" : BY_NAME.has(name) ? (name as SpanKind) : undefined;
export const categoryOf = (k: SpanKind): Category => BY_NAME.get(k)?.cat ?? "machine";
export const categoryCode = (c: Category) => CATEGORIES.indexOf(c);
export const categoryOfCode = (code: number): Category | undefined => CATEGORIES[code];

/** The critical path's tie-break order: a wait on a person wins over CI, and so on down to model time. */
export const pathRank = (c: Category): number => ({ human: 0, pipeline: 1, queue: 2, machine: 3, tools: 4, model: 5, idle: 6 })[c] ?? 6;

const STATUSES: SpanStatus[] = ["ok", "failed", "cancelled", "incomplete"];
export const statusCode = (s: SpanStatus) => Math.max(STATUSES.indexOf(s), 0);
export const statusOf = (code: number): SpanStatus => STATUSES[code] ?? "ok";

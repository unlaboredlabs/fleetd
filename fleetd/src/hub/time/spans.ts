// A span as the time inspector stores it, without the database (store.ts writes and reads them): who it belongs to,
// its label's program family and normal form, which spans a read covers, and how long they are kept.
import type { SpanExtra, SpanKind, SpanStatus } from "../../shared/contracts.ts";

export const DEFAULT_RETENTION_DAYS = 30;
/** Roll-ups and critical paths outlive spans: a few KB per day. */
export const ROLLUP_DAYS = 400;
export const PRUNE_BATCH = 5_000;
export const LABEL_MAX = 500;
export const DAY = 86_400_000;
export const HOUR = 3_600_000;

/** Who a span belongs to. */
export type Ids = {
  machineId?: string;
  projectId?: string;
  workstreamId?: string;
  taskId?: string;
  threadId?: string;
  runId?: string;
  /** `AgentRole` as stored: lead, implementer, reviewer, ... */
  role?: string;
  /** A task's profile's name; for a lead, the one its session started on. */
  profile?: string;
};

/** A span on its way into the store. `endMs` absent opens it; a later write with the same key and an end closes it. */
export type NewSpan = {
  src: string;
  srcKey: string;
  kind: SpanKind;
  startMs: number;
  endMs?: number;
  /** Absent: the whole interval, 0 for detail spans. */
  exclMs?: number;
  ids: Ids;
  lane: string;
  parentKey?: string;
  /** Raw; normalized and deduped here. */
  label?: string;
  exitCode?: number;
  outBytes?: number;
  status: SpanStatus;
  extra?: SpanExtra;
};

/** One roll-up target besides the span's own ids, with a weight: a lead turn split over the orders its wake served. */
export type Share = { scope: string; id: string; of: number };

/** What a write did: counted in roll-ups (new, or closed an open one), opened, or unchanged (a resend). */
export type Wrote = { kind: "counted"; id: number } | { kind: "opened"; id: number } | { kind: "unchanged" };

/** The program a shell command runs: after any `cd x &&` and `VAR=value` prefixes (node/runner/shell.rs). */
export function program(command: string): string | undefined {
  let rest = command.trim();
  for (;;) {
    if (rest.startsWith("cd ")) {
      const after = rest.slice(3);
      const i = after.indexOf("&&");
      if (i >= 0) {
        rest = after.slice(i + 2).trimStart();
        continue;
      }
    }
    const first = rest.split(/\s+/).filter(Boolean)[0];
    if (first === undefined) return undefined;
    if (first.includes("=") && !first.startsWith("=")) {
      rest = rest.slice(first.length).trimStart();
      continue;
    }
    return first;
  }
}

/** `text` cut to at most `max` UTF-16 units, never splitting a character. */
export function headUtf16(text: string, max: number): string {
  let units = 0;
  let out = "";
  for (const ch of text) {
    units += ch.length;
    if (units > max) return out;
    out += ch;
  }
  return text;
}

export const WITH_SUB = ["cargo", "git", "gh", "npm", "pnpm", "yarn", "go", "vp", "docker", "npx", "bun", "uv", "poetry"];

/** The program family of a label: "cargo test", "git push", "pytest". Tools that are not a shell command are their own family. */
export function family(kind: SpanKind, tool: string | undefined, label: string): string {
  if (kind !== "tool.bash" && kind !== "git") return tool ?? kind;
  const prog0 = program(label);
  if (prog0 === undefined) return "";
  const prog = prog0.split("/").pop() ?? prog0;
  if (WITH_SUB.includes(prog)) {
    const at = label.indexOf(prog0);
    const tokens = label
      .slice(at < 0 ? 0 : at + prog0.length)
      .trimStart()
      .split(/\s+/)
      .filter(Boolean);
    let sub: string | undefined;
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i] as string;
      if (t === "-C" || t === "-c") i++;
      else if (!t.startsWith("-")) {
        sub = t;
        break;
      }
    }
    if (sub !== undefined) return `${prog} ${[...sub].slice(0, 40).join("")}`;
  }
  return [...prog].slice(0, 80).join("");
}

export const WT = /(?:\/[^\s/'"]+)*\/worktrees\/[^\s/'"]+\/[^\s/'"]+/g;

/** Worktree paths become `<wt>`, so the same command in two worktrees is one label. */
export const normalize = (label: string) => headUtf16(label.replace(WT, "<wt>"), LABEL_MAX);

/** Which spans a read covers. */
export type Filter = {
  sinceMs: number;
  untilMs: number;
  machineId?: string;
  project?: [string, string];
  /** Lead lanes of a project. */
  lead?: [string, string];
  workstreamId?: string;
  taskIds?: string[];
  thread?: [string, string];
  /** A thread on any machine. */
  threadId?: string;
  role?: string;
  kinds?: SpanKind[];
  afterId?: number;
  /** Only spans that start here or later: keeps a period's read on the start index. */
  startFrom?: number;
  /** Only spans that start before this (`untilMs` still cuts open spans). */
  startBefore?: number;
  /** Only these spans. */
  ids?: number[];
  /** Only spans with one of these labels (the label index). */
  labelIds?: number[];
  /** Only spans of this kind, as a literal, so a partial index on it serves the read. */
  kind?: SpanKind;
  /** At the limit, keep the newest spans instead of the oldest. */
  newest?: boolean;
};

/** What a reader needs beside the row. */
export type Meta = { srcKey: string; role?: string; runId?: string; open: boolean };

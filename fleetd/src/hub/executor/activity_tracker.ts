// A followed thread's activity, from its thread events alone: what activity.ts keeps per thread for the app's live
// lanes (its open tool calls, whether it's writing or thinking, a retry, its streamed text, its tokens and a one-minute
// sparkline of its work), and the lane's parts at a time. Pure, so fleetd cloud's executor tracks a thread with the
// same code (package export `fleetd/hub/executor/activity_tracker`).
import { SPARK_BUCKET_SECS, SPARK_BUCKETS } from "../../shared/contracts.ts";
import type { Activity, ActivityNow, Spark, Tokens } from "../../shared/contracts.ts";
import {
  type ItemKind,
  runActive,
  type RunInfo,
  type RunUsage,
  type ThreadEvent,
  type ThreadItem,
  type ThreadMessage,
} from "../../shared/sessions.ts";
import { isoMs } from "../auth/allows.ts";

/** A delta within this long keeps the thread "writing". */
export const WRITING_FOR_MS = 3000;
/** Streamed text kept per thread, in characters. */
export const TEXT_TAIL_CHARS = 2000;
const BUCKET_MS = SPARK_BUCKET_SECS * 1000;
const CHARS_PER_TOKEN = 4;
/** Complete messages kept since the run started. */
const DONE_KEPT = 8;

/** The first `max` UTF-16 units of `s`, never splitting a character (shell_mapper's `js_take`). */
export function jsTake(s: string, max: number): string {
  if (s.length <= max) return s;
  let out = "";
  for (const c of s) {
    if (out.length + c.length > max) break;
    out += c;
  }
  return out;
}

/** The assistant text streaming now: its message, its last TEXT_TAIL_CHARS, and how many characters came in all. */
export class StreamText {
  constructor(
    readonly messageId: string,
    public tail = "",
    public total = 0,
  ) {}

  /** What came after the first `sent` characters, as far as the tail still has it. */
  since(sent: number): string {
    const missing = Math.max(0, this.total - sent);
    const chars = [...this.tail];
    if (missing >= chars.length) return this.tail;
    return chars.slice(chars.length - missing).join("");
  }
}

export type DoneText = { messageId: string; text: string };

type Open = { activity: Activity; startedMs: number };
type Bucket = { index: number; items: number; chars: number; tokens: number };

const emptyBucket = (index = 0): Bucket => ({ index, items: 0, chars: 0, tokens: 0 });
const mod = (a: number, n: number) => ((a % n) + n) % n;
const sat32 = (n: number) => Math.min(n, 0xffffffff);

export class ActivityTracker {
  private root: string | undefined;
  private open = new Map<string, Open>();
  private activeRun: string | undefined;
  private quietSinceMs = 0;
  private writingSinceMs: number | undefined;
  private lastDeltaMs: number | undefined;
  private retry: [Activity, number] | undefined;
  private streaming: StreamText | undefined;
  private doneTexts: DoneText[] = [];
  private runUsage = new Map<string, RunUsage>();
  private liveUsage: [string, RunUsage] | undefined;
  private charsSinceUsage = 0;
  private buckets: Bucket[] = Array.from({ length: SPARK_BUCKETS }, () => emptyBucket());

  /** Where paths are relative to: the session's worktree, else its project's root. */
  setRoot(root: string | undefined): void {
    this.root = root?.replace(/\/+$/, "");
  }

  apply(event: ThreadEvent, nowMs: number): void {
    switch (event.type) {
      case "snapshot": {
        const { root, buckets } = this;
        Object.assign(this, new ActivityTracker());
        this.root = root;
        this.buckets = buckets;
        this.quietSinceMs = nowMs;
        for (const run of event.runs) this.run(run, nowMs);
        const active = this.activeRun;
        if (active !== undefined) for (const m of event.messages) if (m.runId === active) this.message(m);
        for (const item of event.items) {
          if (item.status !== "running") continue;
          const parsed = Date.parse(item.startedAt);
          this.openItem(item, Math.min(Number.isNaN(parsed) ? nowMs : parsed, nowMs));
        }
        return;
      }
      case "message":
        return this.message(event);
      case "item": {
        this.retry = undefined;
        if (event.status === "running") {
          if (!this.open.has(event.id)) this.bump(nowMs, 1, 0, 0);
          this.openItem(event, nowMs);
        } else {
          if (this.open.delete(event.id)) this.quietSinceMs = nowMs;
          else this.bump(nowMs, 1, 0, 0);
          const retry = retryOf(event.kind);
          if (retry) this.retry = [retry, nowMs];
        }
        return;
      }
      case "run":
        return this.run(event, nowMs);
      case "delta": {
        this.retry = undefined;
        const chars = [...event.append].length;
        this.bump(nowMs, 0, chars, 0);
        this.charsSinceUsage += chars;
        if (this.lastDeltaMs === undefined || nowMs - this.lastDeltaMs > WRITING_FOR_MS) this.writingSinceMs = nowMs;
        this.lastDeltaMs = nowMs;
        if (this.streaming?.messageId !== event.messageId) this.streaming = new StreamText(event.messageId);
        const text = this.streaming;
        text.total += chars;
        text.tail += event.append;
        const kept = [...text.tail];
        if (kept.length > TEXT_TAIL_CHARS) text.tail = kept.slice(kept.length - TEXT_TAIL_CHARS).join("");
        return;
      }
      case "usage": {
        if (this.liveUsage && this.liveUsage[0] === event.runId) {
          const out = Math.max(0, event.usage.outputTokens - this.liveUsage[1].outputTokens);
          const asText = Math.floor(this.charsSinceUsage / CHARS_PER_TOKEN);
          this.bump(nowMs, 0, 0, sat32(Math.max(0, out - asText)));
        }
        this.charsSinceUsage = 0;
        this.liveUsage = [event.runId, event.usage];
        return;
      }
    }
  }

  private run(run: RunInfo, nowMs: number): void {
    if (runActive(run.status)) {
      if (this.activeRun !== run.id) {
        this.activeRun = run.id;
        this.quietSinceMs = nowMs;
        this.doneTexts = [];
      }
      return;
    }
    if (run.usage) this.runUsage.set(run.id, run.usage);
    if (this.liveUsage?.[0] === run.id) this.liveUsage = undefined;
    if (this.activeRun === run.id) {
      this.activeRun = undefined;
      this.open.clear();
      this.retry = undefined;
      this.lastDeltaMs = undefined;
      this.writingSinceMs = undefined;
      this.doneTexts = [];
    }
  }

  private message(m: ThreadMessage): void {
    if (m.role !== "assistant" || m.text.trim() === "") return;
    this.doneTexts = this.doneTexts.filter((d) => d.messageId !== m.id);
    this.doneTexts.push({ messageId: m.id, text: m.text });
    if (this.doneTexts.length > DONE_KEPT) this.doneTexts.shift();
  }

  private openItem(item: ThreadItem, startedMs: number): void {
    const activity = activityOf(item.kind, this.root);
    if (!activity) return;
    this.open.set(item.id, { activity, startedMs: this.open.get(item.id)?.startedMs ?? startedMs });
  }

  private bump(nowMs: number, items: number, chars: number, tokens: number): void {
    const index = Math.floor(nowMs / BUCKET_MS);
    const at = mod(index, SPARK_BUCKETS);
    let slot = this.buckets[at] as Bucket;
    if (slot.index !== index) {
      slot = emptyBucket(index);
      this.buckets[at] = slot;
    }
    slot.items = sat32(slot.items + items);
    slot.chars = sat32(slot.chars + chars);
    slot.tokens = sat32(slot.tokens + tokens);
  }

  runActive(): boolean {
    return this.activeRun !== undefined;
  }

  /** What the thread does at `nowMs`: its newest open call, a retry, writing, thinking; undefined with no run going. */
  now(nowMs: number): ActivityNow | undefined {
    const at = (activity: Activity, sinceMs: number): ActivityNow => ({ activity, since: isoMs(Math.min(sinceMs, nowMs)) });
    let newest: Open | undefined;
    for (const o of this.open.values()) if (!newest || o.startedMs > newest.startedMs) newest = o;
    if (newest) return at(newest.activity, newest.startedMs);
    if (this.retry && this.activeRun !== undefined) return at(this.retry[0], this.retry[1]);
    if (this.activeRun === undefined) return undefined;
    const last = this.lastDeltaMs;
    if (last !== undefined && this.writingSinceMs !== undefined && nowMs - last <= WRITING_FOR_MS) {
      return at({ kind: "writing" }, this.writingSinceMs);
    }
    const since = last === undefined ? this.quietSinceMs : Math.max(this.quietSinceMs, last + WRITING_FOR_MS);
    return at({ kind: "thinking" }, since);
  }

  /** The tokens of every run seen, and the active run's so far; undefined before any. */
  tokens(): Tokens | undefined {
    const live = this.liveUsage && !this.runUsage.has(this.liveUsage[0]) ? this.liveUsage : undefined;
    if (this.runUsage.size === 0 && !live) return undefined;
    const tokens: Tokens = { input: 0, output: 0, cacheRead: 0, live: live !== undefined };
    for (const usage of [...this.runUsage.values(), ...(live ? [live[1]] : [])]) {
      tokens.input += usage.inputTokens;
      tokens.output += usage.outputTokens;
      tokens.cacheRead += usage.cacheReadInputTokens;
    }
    return tokens;
  }

  /** The last minute's work, one sample per 2 s bucket, oldest first. */
  spark(nowMs: number): Spark {
    const end = Math.floor(nowMs / BUCKET_MS);
    const samples: number[] = [];
    for (let index = end - SPARK_BUCKETS; index < end; index++) {
      const b = this.buckets[mod(index, SPARK_BUCKETS)] as Bucket;
      samples.push(b.index === index ? Math.min(255, 16 * b.items + Math.floor(b.chars / 32) + Math.floor(b.tokens / 8)) : 0);
    }
    return { endAt: isoMs(end * BUCKET_MS), samples };
  }

  text(): StreamText | undefined {
    return this.streaming;
  }

  done(): DoneText[] {
    return this.doneTexts;
  }
}

/** The first non-blank line of a command, without a leading `cd … &&`. */
export function commandLine(command: string): string {
  const first = (command.split("\n").find((l) => l.trim() !== "") ?? "").trim();
  if (first.startsWith("cd ")) {
    const amp = first.indexOf("&&");
    if (amp >= 0) {
      const after = first.slice(amp + 2).trim();
      if (after !== "") return after;
    }
  }
  return first;
}

function relative(path: string, root: string | undefined): string {
  if (root !== undefined && path.startsWith(root)) {
    const rest = path.slice(root.length);
    if (rest.startsWith("/")) return rest.slice(1);
  }
  return path;
}

function inputStr(input: unknown, keys: string[]): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  for (const k of keys) {
    const v = (input as Record<string, unknown>)[k];
    if (typeof v === "string") {
      const t = v.trim();
      return t === "" ? undefined : t;
    }
  }
  return undefined;
}

const hostOf = (url: string) => {
  const i = url.indexOf("://");
  const rest = i >= 0 ? url.slice(i + 3) : url;
  return rest.split(/[/?#]/)[0] ?? rest;
};
const trimmed = (s: string | undefined) => {
  const t = s?.trim();
  return t ? t : undefined;
};
const firstLine = (s: string) => s.split("\n")[0] ?? s;
const clip = (s: string, max = 120) => jsTake(s, max);

function toolDetail(input: unknown): string | undefined {
  const d = inputStr(input, ["description", "query", "url", "command", "path", "file_path", "prompt"]);
  return d === undefined ? undefined : clip(firstLine(d));
}

/** An item's activity, in the app's words; undefined for permissions and errors. */
export function activityOf(kind: ItemKind, root: string | undefined): Activity | undefined {
  switch (kind.type) {
    case "command":
      return { kind: "command", text: clip(commandLine(kind.command)) };
    case "file_change":
      return { kind: "edit", path: clip(relative(kind.path, root)) };
    case "tool": {
      const c = kind.class;
      switch (c?.type) {
        case "read": {
          const p = trimmed(c.path);
          return { kind: "read", ...(p === undefined ? {} : { path: clip(relative(p, root)) }) };
        }
        case "search": {
          const p = trimmed(c.pattern);
          return { kind: "read", ...(p === undefined ? {} : { pattern: clip(p) }) };
        }
        case "web": {
          const url = trimmed(c.url);
          const d = url !== undefined ? hostOf(url) : trimmed(c.query);
          return { kind: "web", ...(d === undefined ? {} : { detail: clip(firstLine(d)) }) };
        }
        case "plan":
          return { kind: "planning" };
        case "mcp": {
          const detail = toolDetail(kind.input);
          const server = jsTake(c.server, 60);
          return {
            kind: "tool",
            name: jsTake(c.tool, 60),
            ...(detail === undefined ? {} : { detail }),
            ...(server === "" ? {} : { server }),
          };
        }
        default: {
          const detail = toolDetail(kind.input);
          return { kind: "tool", name: jsTake(kind.toolName, 60), ...(detail === undefined ? {} : { detail }) };
        }
      }
    }
    case "compaction":
      return { kind: "compacting" };
    case "api_retry":
    case "node_retry":
      return retryOf(kind);
    default:
      return undefined;
  }
}

function retryOf(kind: ItemKind): Activity | undefined {
  if (kind.type === "api_retry") {
    const reason = kind.errorStatus === 529 ? "overloaded" : kind.errorStatus !== undefined ? `${kind.errorStatus}` : kind.error;
    return { kind: "retrying", attempt: kind.attempt, of: kind.maxRetries, reason: clip(reason) };
  }
  if (kind.type === "node_retry") return { kind: "retrying", attempt: kind.attempt, of: kind.of, reason: clip(kind.reason.class) };
  return undefined;
}

/** A followed thread's live lane values (executor/mod.rs `LiveParts`). */
export type LiveParts = {
  activity?: ActivityNow;
  tokens?: Tokens;
  spark: Spark;
  text?: StreamText;
  done: DoneText[];
  runActive: boolean;
};

/** A tracker with no run going and no event this long is dropped: its follow has ended, whoever ended it. */
export const TRACKER_IDLE_MS = 10 * 60_000;

/** A tracker's live parts at `nowMs`: what `activity(hub).live(ref)` gives for a followed thread. */
export function liveParts(t: ActivityTracker, nowMs: number): LiveParts {
  const activityNow = t.now(nowMs);
  const tokens = t.tokens();
  const text = t.text();
  return {
    ...(activityNow ? { activity: activityNow } : {}),
    ...(tokens ? { tokens } : {}),
    spark: t.spark(nowMs),
    ...(text ? { text } : {}),
    done: [...t.done()],
    runActive: t.runActive(),
  };
}

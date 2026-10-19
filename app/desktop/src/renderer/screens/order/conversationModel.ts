// The lead's conversation, focused on one order (steering-spec §7, order-view brief B): its messages at full
// weight, fleetd's own messages to the lead (wakes, digests, its start) collapsed to one muted line, runs about
// other orders folded, finished tool-call runs folded, this order's hub events merged between messages, and every
// steer under its real author (Steer.by) with its receipt. Built here from the hub's data, never by a model.
// The fold/merge rules follow T3 Code's work log grouping.

import type { ActionItem, AgentLane, HubEvent, Steer, TailItem } from "../../../shared/contracts";
import { plural } from "./format";
import { type Receipt, receipt, sendingReceipt } from "./receipts";
import { taskOfTarget, unsettled, type Sending } from "./sending";

export type Author = { readonly kind: "you"; readonly keyName?: string } | { readonly kind: "lead" };

export interface Call {
  readonly summary: string;
  readonly failed: boolean;
  /** For a transcript jump to land on the call itself. */
  readonly at: string;
}

export type Entry =
  | {
      readonly kind: "say";
      readonly key: string;
      readonly at: string;
      readonly author: Author;
      /** A steer sent straight to one of the order's agents: "T88". */
      readonly to?: string;
      readonly text: string;
      readonly receipt?: Receipt;
      /** Still arriving on the live feed. */
      readonly streaming?: boolean;
      /** The hub sent only the first 2,000 characters. */
      readonly clipped?: boolean;
    }
  /** fleetd's machine text to the lead: one muted line, expandable to the rendered text. */
  | { readonly kind: "system"; readonly key: string; readonly at: string; readonly headline: string; readonly text: string }
  | {
      readonly kind: "fold";
      readonly key: string;
      readonly at: string;
      readonly secs: number;
      readonly commands: number;
      readonly failed: number;
      readonly calls: readonly Call[];
    }
  /** The lead is mid-turn: its latest calls, unfolded. */
  | { readonly kind: "working"; readonly key: string; readonly calls: readonly Call[] }
  | { readonly kind: "others"; readonly key: string; readonly at: string; readonly n: number; readonly about: string }
  | { readonly kind: "events"; readonly key: string; readonly at: string; readonly text: string }
  | { readonly kind: "rollup"; readonly key: string; readonly text: string }
  /** The next block of a long message, its own row so a 20k-line message scrolls like 20k short ones. */
  | {
      readonly kind: "more";
      readonly key: string;
      readonly text: string;
      readonly receipt?: Receipt;
      readonly streaming?: boolean;
      readonly clipped?: boolean;
    };

/** The order ids ("W12") a text names, as whole words. */
export function mentions(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/(?<![A-Za-z0-9])W[1-9][0-9]*(?![A-Za-z0-9])/g)) {
    if (!out.includes(m[0])) out.push(m[0]);
  }
  return out;
}

const field = (e: HubEvent, k: string): string | undefined => {
  const data: unknown = e.data;
  const v: unknown = typeof data === "object" && data !== null ? (data as Record<string, unknown>)[k] : undefined;
  return typeof v === "string" ? v : typeof v === "number" ? String(v) : undefined;
};

/** "T31 started", "#211 merged", else the event's own summary. */
export function eventPhrase(e: HubEvent): string {
  const task = field(e, "taskId");
  const pr = field(e, "prNumber");
  if (task !== undefined) {
    if (e.type === "task.started") return `${task} started`;
    if (e.type === "task.done" || e.type === "task.completed") return `${task} finished`;
    if (e.type === "task.failed") return `${task} failed`;
    if (e.type === "task.cancelled") return `${task} cancelled`;
  }
  if (e.type === "pr.merged" && pr !== undefined) return `#${pr} merged`;
  return e.summary;
}

/** "Worked for 48s · ran 3 commands (1 failed)". */
export function foldLabel(secs: number, commands: number, failed: number, calls: number): string {
  const time = secs < 60 ? `${secs}s` : `${Math.floor(secs / 60)}m ${String(secs % 60).padStart(2, "0")}s`;
  const did = commands === 0 ? plural(calls, "tool call") : commands === 1 ? "ran 1 command" : `ran ${commands} commands`;
  return `Worked for ${time} · ${did}${failed > 0 ? ` (${failed} failed)` : ""}`;
}

/** The steer a user message in the lead's log is: the hub's steer text begins with its id ("S12 · the human…"). */
function steerOf(text: string, steers: readonly Steer[]): Steer | undefined {
  const head = /^\s*(S[1-9][0-9]*)\b/.exec(text)?.[1];
  return head === undefined ? undefined : steers.find((s) => s.id === head);
}

const plain = (line: string): string =>
  line
    .replace(/^\s*(?:[-*+]|\d+\.)\s+/, "")
    .replace(/^#+\s*/, "")
    .replace(/[*_`]+/g, "")
    .trim();

/** A sentence's first clause, from the human's side: "The human settled 2 of your asks; see…" → "you settled 2 of its asks". */
function fromYourSide(line: string): string {
  const first = plain(line).split(/;\s|\.\s|:\s(?=[A-Z])/)[0] ?? "";
  const cut = first.replace(/^The human\b/, "you").replace(/\byour\b/g, "its");
  // A quote cut at its first sentence still closes.
  const turned = (cut.match(/(?<![A-Za-z])'|'(?![A-Za-z])/g) ?? []).length % 2 === 1 ? `${cut}…'` : cut;
  return turned.length > 120 ? `${turned.slice(0, 119)}…` : turned;
}

/** One muted line for fleetd's text to the lead: why it was woken, that it started, or what fleetd said. */
export function systemHeadline(text: string): string {
  const why = /^##\s*(?:Why you are woken|Events)\s*$/m.exec(text);
  if (why) {
    const reasons = text
      .slice(why.index + why[0].length)
      .split("\n")
      .filter((l) => /^\s*-\s+\S/.test(l));
    const first = reasons[0];
    if (first !== undefined) {
      const more = reasons.length > 1 ? ` (+${reasons.length - 1} more)` : "";
      return `Woken: ${fromYourSide(first)}${more}`;
    }
    return "Woken by fleetd";
  }
  if (/^\s*You are the lead of project\b/.test(text)) return "Started: fleetd's first message to the lead";
  if (/^\s*#\s*(?:fleetd digest|project)\b/.test(text)) return "fleetd's digest of the project";
  const line = text.split("\n").map(plain).find((l) => l.length > 0) ?? "";
  return `From fleetd: ${line.length > 100 ? `${line.slice(0, 99)}…` : line}`;
}

const RECENT = 8;

/**
 * A message's start (`head`) joined to its end (`tail`, its last characters) where they overlap; the tail alone
 * when it holds the whole message. Undefined when the two don't overlap, so they can't be shown as one.
 */
export function completeWith(head: string, tail: string): string | undefined {
  if (tail.startsWith(head) || tail.endsWith(head)) return tail;
  if (head.endsWith(tail) || head.includes(tail)) return head;
  // A short overlap could be chance; a dozen characters of the same words is the same message.
  const min = Math.min(12, tail.length);
  for (let k = Math.min(head.length, tail.length); k >= min; k--) {
    if (head.endsWith(tail.slice(0, k))) return head + tail.slice(k);
  }
  return undefined;
}

// A tail message is at most 2,000 UTF-16 units: the hub keeps a long message's END (thread_view.rs tail_of,
// keep_tail), and the offline cache keeps its start with an ellipsis (tools.rs). Either way part of it is missing.
const TAIL_TEXT = 2000;
const cutAtEnd = (text: string): boolean => text.length >= TAIL_TEXT - 1 && text.endsWith("…");
const isClipped = (text: string): boolean => cutAtEnd(text) || text.length >= TAIL_TEXT;

export interface Streamed {
  readonly messageId: string;
  readonly text: string;
}

export interface ConversationInput {
  /** The lead's tail, oldest first. */
  readonly tail: readonly TailItem[];
  /** The order ("W41"). */
  readonly workstreamId: string;
  /** This order's hub events. */
  readonly events: readonly HubEvent[];
  readonly leadWorking: boolean;
  /** This order's steers, to the lead and to its tasks, by anyone. */
  readonly steers: readonly Steer[];
  readonly sending: readonly Sending[];
  /** Steers whose "Interrupt and redirect" is in flight or done. */
  readonly redirected?: ReadonlySet<string>;
  /** The lead's messages as they streamed in on the live feed, oldest first: in full, where the tail cuts them. */
  readonly streamed?: readonly Streamed[];
  /**
   * The end of the lead's latest message (thread_tail's thread.latestMessageTail, its last 4,096 characters) and
   * when it was written: once the lead is idle, this completes a message the live feed or the tail cut short.
   */
  readonly latest?: { readonly text: string; readonly at: string };
  readonly lanes: readonly AgentLane[];
}

type Item =
  | { readonly t: "tail"; readonly at: string; readonly item: TailItem }
  | { readonly t: "event"; readonly at: string; readonly event: HubEvent }
  | { readonly t: "steer"; readonly at: string; readonly steer: Steer };

const authorOf = (s: Steer): Author => (s.by.kind === "lead" ? { kind: "lead" } : { kind: "you", keyName: s.by.keyName });
const taskOf = (s: Steer): string | undefined => ("taskId" in s.target ? s.target.taskId : undefined);

function steerSay(s: Steer, at: string, redirected: ReadonlySet<string> | undefined): Entry {
  const to = taskOf(s);
  return {
    kind: "say",
    key: `steer:${s.id}`,
    at,
    author: authorOf(s),
    ...(to === undefined ? {} : { to }),
    text: s.text,
    receipt: receipt(s, redirected?.has(s.id) ?? false),
  };
}

export function buildConversation(input: ConversationInput): Entry[] {
  const { tail, workstreamId: w, steers } = input;
  // Steers the lead's log already holds show where the lead received them; the rest (to a task, or not taken in
  // yet) are woven in by the time they were queued.
  const inLog = new Set<string>();
  for (const i of tail) {
    if (i.kind === "message" && i.role === "user") {
      const s = steerOf(i.text, steers);
      if (s) inLog.add(s.id);
    }
  }
  const items: Item[] = tail.map((item) => ({ t: "tail", at: item.at, item }));
  for (const event of input.events) items.push({ t: "event", at: event.at, event });
  for (const steer of steers) if (!inLog.has(steer.id)) items.push({ t: "steer", at: steer.queuedAt, steer });
  // Stable: equal times keep tail order, then events, then steers.
  items.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));

  const out: Entry[] = [];
  const streamed = input.streamed ?? [];
  const used = new Set<string>();
  // A streamed message is matched to the lead's newest replies only, so a short part ("The") can't vanish into an
  // old reply that happens to start the same way.
  const assistantCount = tail.filter((i) => i.kind === "message" && i.role === "assistant").length;
  let assistantSeen = 0;
  let calls: ActionItem[] = [];
  let foldStart: string | undefined;
  const seen = new Map<string, number>();
  const keyFor = (prefix: string, at: string): string => {
    const n = seen.get(at) ?? 0;
    seen.set(at, n + 1);
    return `${prefix}:${at}:${n}`;
  };
  const flush = () => {
    const first = calls[0];
    const last = calls.at(-1);
    if (first === undefined || last === undefined) return;
    const start = foldStart ?? first.at;
    const secs = Math.max(0, Math.round((Date.parse(last.at) - Date.parse(start)) / 1000)) || 0;
    out.push({
      kind: "fold",
      key: `fold:${start}`,
      at: start,
      secs,
      commands: calls.filter((c) => c.kind === "command").length,
      failed: calls.filter((c) => c.failed).length,
      calls: calls.map((c) => ({ summary: c.summary, failed: c.failed, at: c.at })),
    });
    calls = [];
    foldStart = undefined;
  };

  for (const it of items) {
    if (it.t === "event") {
      const phrase = eventPhrase(it.event);
      const prev = out.at(-1);
      if (prev?.kind === "events") out[out.length - 1] = { ...prev, text: `${prev.text}, ${phrase}` };
      else out.push({ kind: "events", key: `events:${it.event.seq}`, at: it.at, text: phrase });
      continue;
    }
    if (it.t === "steer") {
      flush();
      out.push(steerSay(it.steer, it.at, input.redirected));
      continue;
    }
    const item = it.item;
    if (item.kind === "action") {
      calls.push(item.action);
      continue;
    }
    if (item.role === "system") continue;
    if (item.role === "user") {
      const s = steerOf(item.text, steers);
      if (s) {
        flush();
        foldStart = item.at;
        out.push(steerSay(s, item.at, input.redirected));
        continue;
      }
    }
    const ids = mentions(item.text);
    if (ids.length > 0 && !ids.includes(w)) {
      // Its calls belong to that other order too.
      calls = [];
      foldStart = undefined;
      const prev = out.at(-1);
      if (prev?.kind === "others") out[out.length - 1] = { ...prev, n: prev.n + 1 };
      else out.push({ kind: "others", key: keyFor("others", item.at), at: item.at, n: 1, about: ids[0] ?? "" });
      continue;
    }
    flush();
    if (item.role === "user") {
      // In a lead's thread every other user message is fleetd's own: wakes, digests, its start, nudges.
      foldStart = item.at;
      out.push({ kind: "system", key: keyFor("system", item.at), at: item.at, headline: systemHeadline(item.text), text: item.text });
    } else {
      // The same message from the live feed: in full where the tail cut it, or a part the feed caught.
      const head = cutAtEnd(item.text) ? item.text.slice(0, -1) : item.text;
      const recent = assistantSeen++ >= assistantCount - RECENT;
      const same = recent
        ? streamed.find(
            (m) => !used.has(m.messageId) && m.text.trim() !== "" && (m.text.startsWith(head) || head.startsWith(m.text) || m.text.endsWith(head)),
          )
        : undefined;
      if (same) used.add(same.messageId);
      const full = same !== undefined && same.text.length > head.length ? same.text : undefined;
      out.push({
        kind: "say",
        key: keyFor("say", item.at),
        at: item.at,
        author: { kind: "lead" },
        text: full ?? item.text,
        ...(full === undefined && isClipped(item.text) ? { clipped: true } : {}),
      });
    }
  }

  if (input.leadWorking && calls.length > 0) {
    out.push({ kind: "working", key: "working", calls: calls.slice(-3).map((c) => ({ summary: c.summary, failed: c.failed, at: c.at })) });
    calls = [];
  } else {
    flush();
  }

  // Streamed messages the tail doesn't hold yet (it refetches on the thread's events); the newest is still arriving
  // while the lead works.
  const fresh = streamed.filter((m) => !used.has(m.messageId) && m.text.trim() !== "");
  const latest = !input.leadWorking && input.latest !== undefined && input.latest.text.trim() !== "" ? input.latest : undefined;
  fresh.forEach((m, i) => {
    const last = i === fresh.length - 1;
    const streaming = input.leadWorking && last;
    // Idle, the newest streamed message is finished: its end is the thread's latest message.
    const done = last && latest ? (completeWith(m.text, latest.text) ?? `${m.text}\n\n…\n\n${latest.text}`) : m.text;
    out.push({
      kind: "say",
      key: `live:${m.messageId}`,
      at: last && latest ? latest.at : "",
      author: { kind: "lead" },
      text: done,
      ...(streaming ? { streaming } : {}),
    });
  });
  // Idle, the lead's newest message is finished, and the thread's latest-message tail holds its true end: the
  // tail item and the live feed may each have caught it mid-stream (or the hub kept only part of it). Complete it,
  // whichever of them built the row.
  if (latest && fresh.length === 0) {
    for (let k = out.length - 1; k >= 0; k--) {
      const e = out[k];
      if (e?.kind !== "say" || e.author.kind !== "lead" || e.to !== undefined) continue;
      const own = cutAtEnd(e.text) ? e.text.slice(0, -1) : e.text;
      const full = completeWith(own, latest.text);
      if (full !== undefined && full !== e.text) out[k] = { kind: "say", key: e.key, at: e.at, author: e.author, text: full };
      break;
    }
  }

  for (const s of unsettled(input.sending, steers)) {
    const to = taskOfTarget(s.target);
    out.push({
      kind: "say",
      key: `sending:${s.requestId}`,
      at: s.at,
      author: { kind: "you" },
      ...(to === undefined ? {} : { to }),
      text: s.text,
      receipt: sendingReceipt(s),
    });
  }

  const roll = rollup(input.lanes);
  if (roll !== undefined) out.push({ kind: "rollup", key: "rollup", text: roll });
  return out.flatMap(split);
}

/** A long message as several rows: the first keeps its time and author, the last its receipt and flags. */
function split(e: Entry): Entry[] {
  if (e.kind !== "say") return [e];
  const blocks = splitBlocks(e.text);
  if (blocks.length === 1) return [e];
  const { receipt: r, streaming, clipped, ...head } = e;
  const flags = { ...(r ? { receipt: r } : {}), ...(streaming ? { streaming } : {}), ...(clipped ? { clipped } : {}) };
  return blocks.map((text, i): Entry => {
    if (i === 0) return { ...head, text };
    return { kind: "more", key: `${e.key}#${i}`, text, ...(i === blocks.length - 1 ? flags : {}) };
  });
}

const FENCE = /^\s*(`{3,}|~{3,})/;

/**
 * Markdown cut into blocks of about `max` lines, at blank lines where it can, never inside a code fence (a fence
 * that runs long is closed and reopened). Only the last block changes as text is appended, so earlier rows keep
 * their keys and measured heights.
 */
export function splitBlocks(text: string, max = 40): string[] {
  const lines = text.split("\n");
  if (lines.length <= max + max / 2) return [text];
  const out: string[] = [];
  let cur: string[] = [];
  let fence: { open: string; marker: string } | undefined;
  for (const line of lines) {
    const f = FENCE.exec(line)?.[1];
    if (f !== undefined) fence = fence === undefined ? { open: line, marker: f } : line.trim().startsWith(fence.marker) ? undefined : fence;
    cur.push(line);
    const atBreak = fence === undefined && line.trim() === "";
    if ((cur.length >= max && atBreak) || cur.length >= 2 * max) {
      if (fence === undefined) {
        out.push(cur.join("\n"));
        cur = [];
      } else {
        out.push([...cur, fence.marker].join("\n"));
        cur = [fence.open];
      }
    }
  }
  if (cur.length > 0) out.push(cur.join("\n"));
  return out;
}

const settled = (l: AgentLane): boolean => l.status === "done" || l.status === "failed" || l.status === "cancelled";

/** "All 3 agents finished: #211 #212", or "2 of 3 finished; T32 failed". Undefined while any agent still runs. */
export function rollup(lanes: readonly AgentLane[]): string | undefined {
  const agents = lanes.filter((l) => l.role !== "lead");
  if (agents.length === 0 || !agents.every(settled)) return undefined;
  const failed = agents.filter((l) => l.status !== "done").map((l) => l.taskId ?? l.laneId);
  const prs = [...new Set(agents.flatMap((l) => (l.pr ? [`#${l.pr.number}`] : [])))];
  const n = agents.length;
  if (failed.length === 0) return `All ${plural(n, "agent")} finished${prs.length > 0 ? `: ${prs.join(" ")}` : ""}`;
  return `${n - failed.length} of ${n} finished; ${failed.join(", ")} ${failed.length === 1 ? "failed" : "did not finish"}`;
}

/** The pill: the most urgent state first ("1 needs you · 3 working · 3 done", "all 3 done"). */
export function fanOut(lanes: readonly AgentLane[], asks: number): string | undefined {
  const count = (f: (l: AgentLane) => boolean) => lanes.filter(f).length;
  const waiting = count((l) => l.status === "waiting") + asks;
  const working = count((l) => l.status === "working" || l.status === "starting");
  const queued = count((l) => l.status === "queued");
  const failed = count((l) => l.status === "failed");
  const done = count((l) => l.status === "done");
  if (lanes.length === 0 && waiting === 0) return undefined;
  if (waiting + working + queued + failed === 0) return `all ${done} done`;
  const parts: Array<[number, string]> = [
    [waiting, "needs you"],
    [failed, "failed"],
    [working, "working"],
    [queued, "queued"],
    [done, "done"],
  ];
  return parts
    .filter(([n]) => n > 0)
    .map(([n, word]) => `${n} ${word}`)
    .join(" · ");
}

/** The row holding a transcript item at `at`: the last row that starts at or before it (a fold holds the calls after its start). */
export function entryIndexAt(entries: readonly Entry[], at: string): number {
  let best = -1;
  entries.forEach((e, i) => {
    const t = "at" in e ? e.at : "";
    if (t !== "" && t <= at) best = i;
  });
  return best === -1 ? 0 : best;
}

/** Within a fold, the call a transcript item at `at` is: the last that starts at or before it. */
export function callIndexAt(calls: readonly Call[], at: string): number {
  let best = 0;
  calls.forEach((c, i) => {
    if (c.at <= at) best = i;
  });
  return best;
}

/** What a transcript jump does to its row: a fold opens and lights the call itself; any other row lights whole. */
export function jumpTarget(e: Entry, at: string): { readonly open: boolean; readonly call?: number } {
  if (e.kind === "fold") return { open: true, call: callIndexAt(e.calls, at) };
  if (e.kind === "working") return { open: false, call: callIndexAt(e.calls, at) };
  return { open: false };
}

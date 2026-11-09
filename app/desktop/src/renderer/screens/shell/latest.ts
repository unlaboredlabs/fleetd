// Each chat's newest line for the sidebar's rows (W530): the newest message you or the lead wrote, as one line of plain
// words ("You: ship it", "Asks for your approval", "Pull request #12: …"), and when. fleetd's own lines (an agent
// started, a PR merged) and agents' notes to the lead are not what a chat said, so they neither show nor move a row.
// Read once per chat as the link comes up (its newest few messages, a few chats at a time, only those that moved
// since), then kept up by each chat.message event, which carries the message (one too big for its event is read
// again). The last lines are kept on this computer per hub, so a launch shows them before the hub answers, and
// offline.
import { useEffect, useSyncExternalStore } from "react";
import { eventData, type ChatBlock, type ChatMessage, type HubEventOf } from "../../../shared/contracts";
import type { HubId } from "../../../shared/hubs";
import type { DataLayer } from "../../src/data/queries";
import { CHAT_EVENTS } from "../../src/data/chat-contract";
import type { ProjectRow } from "../../src/data/selectors";
import { replyOf } from "../chat/bubbles";
import { plainText } from "../chat/plain";

export interface Latest {
  /** The line, without who wrote it; empty when none of its newest messages is one to show. */
  readonly text: string;
  /** A person wrote it (the row says "You:" or their first name); absent for the lead. An id of "" is from a hub before people: you. */
  readonly person?: { readonly id: string; readonly name: string } | undefined;
  /** When that message was written; empty with no line. */
  readonly at: string;
  /** The newest seq looked at, line or not: a chat whose lastSeq is past it is read again. */
  readonly seq: number;
}

const KEPT = "fleetd.sidebarLatest";
/** How many of a chat's newest messages a read looks through for its line. */
const LOOK = 10;
/** Reads at once, as the link comes up. */
const AT_ONCE = 4;
/** The longest line kept: one sidebar row shows far less. */
const MAX = 160;

const BLOCK_WORDS: Record<ChatBlock["kind"], (b: ChatBlock) => string> = {
  pr: (b) => (b.kind === "pr" ? `Pull request #${String(b.number)}${b.title === undefined ? "" : `: ${b.title}`}` : ""),
  ask: (b) => (b.kind === "ask" ? b.question : ""),
  checklist: (b) => (b.kind === "checklist" ? (b.title ?? "A checklist") : ""),
  table: (b) => (b.kind === "table" ? (b.title ?? "A table") : ""),
  chart: (b) => (b.kind === "chart" ? b.title : ""),
  diff: () => "A diff",
  agent: () => "An agent",
  image: (b) => (b.kind === "image" ? (b.caption ?? "Photo") : ""),
  clip: (b) => (b.kind === "clip" ? (b.caption ?? "Clip") : ""),
  file: (b) => (b.kind === "file" ? (b.caption ?? b.name ?? "File") : ""),
};

/** A lead's block that didn't reach a part (a fence as written) says nothing in a preview. */
const withoutBlockFences = (text: string): string => text.replace(/^ {0,3}(`{3,}|~{3,})[ \t]*fleetd-block[^\n]*\n[\s\S]*?(?:^ {0,3}\1[ \t]*$|(?![\s\S]))/gmu, "");

const flat = (text: string): string => {
  const one = text.replace(/\s+/gu, " ").trim();
  return one.length <= MAX ? one : `${one.slice(0, MAX - 1)}…`;
};

/** A message as its row's line, without who wrote it; null for one that isn't (fleetd's own, an agent's, one still streaming). */
export const lineOf = (m: ChatMessage): string | null => {
  if (m.author !== "human" && m.author !== "lead") return null;
  if (m.state === "streaming") return null;
  const mine = m.author === "human";
  const item = m.item?.kind;
  if (item === "command_approval") return "Asks for your approval";
  if (item === "secret_request") return "Asks for a secret";
  const text = mine ? (replyOf(m.text)?.body ?? m.text) : m.text;
  const parts = m.parts ?? [];
  const words =
    parts.length === 0
      ? plainText(withoutBlockFences(text))
      : parts.map((p) => (p.block !== undefined && p.block.kind in BLOCK_WORDS ? BLOCK_WORDS[p.block.kind](p.block) : plainText(withoutBlockFences(text.slice(p.start, p.end))))).join(" ");
  const files = (m.attachments ?? []).map((a) => (a.mime.startsWith("image/") ? "Photo" : a.name)).join(", ");
  const line = flat(words === "" ? files : words);
  return line === "" ? null : line;
};

/** The newest line among `messages` (any order), and the newest seq among them. */
export const latestOf = (messages: readonly ChatMessage[], before?: Latest): Latest => {
  const newest = [...messages].sort((a, b) => b.seq - a.seq);
  const seq = Math.max(before?.seq ?? 0, newest[0]?.seq ?? 0);
  for (const m of newest) {
    if (before !== undefined && m.seq <= before.seq && before.text !== "") break;
    const text = lineOf(m);
    if (text === null) continue;
    const person = m.author === "human" ? { id: m.person?.personId ?? "", name: m.person?.name ?? "" } : undefined;
    return person === undefined ? { text, at: m.createdAt, seq } : { text, at: m.createdAt, seq, person };
  }
  return before === undefined ? { text: "", at: "", seq } : { ...before, seq };
};

type Lines = Readonly<Record<string, Latest>>;

let lines: ReadonlyMap<HubId, Lines> = new Map();
const listeners = new Set<() => void>();
let saving = 0;

const readKept = (): ReadonlyMap<HubId, Lines> => {
  try {
    const all: unknown = JSON.parse(window.localStorage.getItem(KEPT) ?? "{}");
    if (typeof all !== "object" || all === null) return new Map();
    return new Map(Object.entries(all as Record<string, Lines>));
  } catch {
    return new Map();
  }
};
let loaded = false;

const keepSoon = () => {
  if (saving !== 0) return;
  saving = window.setTimeout(() => {
    saving = 0;
    try {
      window.localStorage.setItem(KEPT, JSON.stringify(Object.fromEntries(lines)));
    } catch {
      // Without storage a launch shows the rows without their lines until the hub answers.
    }
  }, 1000);
};

const put = (hub: HubId, key: string, next: Latest) => {
  const was = lines.get(hub)?.[key];
  if (was !== undefined && was.text === next.text && was.at === next.at && was.seq === next.seq) return;
  lines = new Map(lines).set(hub, { ...lines.get(hub), [key]: next });
  for (const l of listeners) l();
  keepSoon();
};

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

const none: Lines = {};

/** One hub's lines, by project key. */
export const useLatest = (hub: HubId): Lines =>
  useSyncExternalStore(subscribe, () => {
    if (!loaded) {
      loaded = true;
      lines = readKept();
    }
    return lines.get(hub) ?? none;
  });

const reading = new WeakMap<DataLayer, Set<string>>();

const refOf = (key: string) => {
  const at = key.indexOf("/");
  return { machineId: key.slice(0, at), projectId: key.slice(at + 1) };
};

/** Reads `keys`' newest messages, AT_ONCE at a time, each chat once while one is on its way. */
const readAll = async (layer: DataLayer, keys: readonly string[]) => {
  const busy = reading.get(layer) ?? new Set<string>();
  reading.set(layer, busy);
  const queue = keys.filter((k) => !busy.has(k));
  for (const k of queue) busy.add(k);
  const next = async (): Promise<void> => {
    const key = queue.shift();
    if (key === undefined) return;
    const out = await layer.call("chat_history", { projectRef: refOf(key), limit: LOOK });
    busy.delete(key);
    if (out.ok) put(layer.hub, key, latestOf(out.output.messages, lines.get(layer.hub)?.[key]));
    return next();
  };
  await Promise.all(Array.from({ length: AT_ONCE }, next));
};

/**
 * Keeps one hub's lines current while it is live: reads the chats that moved since their line was made, and follows
 * each new message. In the hub's always-mounted watcher (HubWatch).
 */
export const useFollowLatest = (layer: DataLayer, rows: ReadonlyArray<ProjectRow> | undefined, live: boolean): void => {
  const known = useLatest(layer.hub);
  // The chats whose newest message is past their line's: on each fresh link, and when the rows change.
  const stale = live && rows !== undefined ? rows.filter((r) => r.lastSeq !== undefined && r.lastSeq > 0 && r.lastSeq > (known[r.key]?.seq ?? 0)).map((r) => r.key) : [];
  const want = stale.join("\n");
  useEffect(() => {
    if (want !== "") void readAll(layer, want.split("\n"));
  }, [layer, want]);

  useEffect(() => {
    const { store } = layer;
    let last = store.getState().events.at(-1)?.seq ?? -1;
    return store.subscribe((s) => {
      for (const event of s.events) {
        if (event.seq <= last) continue;
        last = event.seq;
        if (event.type !== CHAT_EVENTS.message) continue;
        const data = eventData<"chat.message">(event as HubEventOf<"chat.message">);
        if (data === undefined) continue;
        const key = `${data.projectRef.machineId}/${data.projectRef.projectId}`;
        const before = lines.get(layer.hub)?.[key];
        if (data.message !== undefined && before !== undefined) put(layer.hub, key, latestOf([data.message], before));
        // Too big for its event, or a chat without a line yet: its newest are read, once the message is final.
        else if (data.state !== "streaming") void readAll(layer, [key]);
      }
    });
  }, [layer]);
};

// A bot's memory as the phone's bot Memory screen reads it, the same model as the desktop's Instructions & memory:
// each line of its files with who taught it (a person's name, or the lead for its own), and the changes held for an
// admin's OK on top, which an owner or admin keeps or not (memory_get with projectRef, memory_hold_answer).
import type { HubError } from "./desktop";

type PersonShape = { readonly personId: string; readonly name: string };
type AuthorShape = { readonly text: string; readonly by?: PersonShape };
/** One of the bot's files, the part the phone reads (fleetd-contracts MemoryFile). */
type FileShape = { readonly topic?: string; readonly text: string; readonly authors?: readonly AuthorShape[] };
/** A held change (fleetd-contracts MemoryHeld), the part the phone reads. */
export type HeldShape = {
  readonly messageId: string;
  readonly text: string;
  readonly by?: PersonShape;
  readonly forgotten?: boolean;
  readonly replaced?: string;
  readonly topic?: string;
};

export type BotLine = { readonly text: string; readonly by?: string };
export type BotFile = { readonly topic?: string; readonly lines: readonly BotLine[] };
export type BotMemory = { readonly files: readonly BotFile[]; readonly held: readonly HeldShape[] };

type Result<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: HubError };
type Raw = (tool: string, input: unknown) => Promise<{ readonly ok: true; readonly output: unknown } | { readonly ok: false; readonly error: HubError }>;
type Ref = { readonly machineId: string; readonly projectId: string };

/** Who taught a line, in words: their name, or the lead for its own. */
export const authorWord = (a: { readonly by?: PersonShape }): string => a.by?.name ?? "the lead";

const isIndexLine = (l: string) => l.startsWith("- [") && l.trimEnd().endsWith(".md)");

/** A file's entries, blank and topic lines left out, each with who taught it when the workspace has a record. */
export function botLines(f: FileShape): BotLine[] {
  const authors = new Map((f.authors ?? []).map((a) => [a.text, authorWord(a)]));
  return f.text.split("\n").flatMap((raw): BotLine[] => {
    const line = raw.trimEnd();
    if (!line.trim() || isIndexLine(line)) return [];
    const text = line.replace(/^(- )+/, "");
    const by = authors.get(text);
    return [{ text, ...(by === undefined ? {} : { by }) }];
  });
}

/**
 * A held change's quiet line: who taught it, and what it does beyond adding itself. `short` (the row not opened) says a
 * rewrite in a word; opened, the line it would replace in full.
 */
export function heldDetail(h: HeldShape, short = false): string {
  const replaces = h.replaced === undefined ? undefined : short ? "rewrites a line" : `in place of “${h.replaced}”`;
  const what = h.forgotten === true ? "would take this out" : replaces;
  return [`From ${authorWord(h)}`, what, h.topic].filter((w) => w !== undefined).join(" · ");
}

/** Lines a long file shows before Show All, and held changes before Show More: the desktop's. */
export const FOLD = 6;
export const HELD_FOLD = 3;

/**
 * The first `n` of a long list and how many more there are, or all of it (`all`, or when only a few more would fold).
 * The screen stays short however big a bot's memory gets.
 */
export function folded<T>(items: readonly T[], n: number, all: boolean): { shown: readonly T[]; more: number } {
  if (all || items.length <= n + 2) return { shown: items, more: 0 };
  return { shown: items.slice(0, n), more: items.length - n };
}

/** How many held changes wait on `me`, an owner or admin, by the chat state's open items (one per admin). */
export function heldForMe(open: readonly { readonly kind: string; readonly messageId: string; readonly for?: string }[] | undefined, me: string | undefined): number {
  if (me === undefined) return 0;
  return new Set((open ?? []).filter((o) => o.kind === "memory_hold" && o.for === me).map((o) => o.messageId)).size;
}

/** "1 waiting", for the bot's Memory row, while any change waits. */
export const heldValue = (n: number): string | undefined => (n > 0 ? `${String(n)} waiting` : undefined);

export type BotMemoryClient = {
  read(ref: Ref): Promise<Result<BotMemory>>;
  answer(ref: Ref, messageId: string, keep: boolean): Promise<Result<null>>;
};

type GetOutput = { files?: FileShape[]; held?: HeldShape[] };

export const botMemoryClient = (hub: { readonly call: unknown }): BotMemoryClient => {
  // The calls' types come with fleetd-contracts; read through their shape until the app's are generated.
  const call = (hub.call as Raw).bind(hub);
  return {
    read: async (ref) => {
      const r = await call("memory_get", { projectRef: ref });
      if (!r.ok) return r;
      const g = r.output as GetOutput;
      return { ok: true, value: { files: (g.files ?? []).map((f) => ({ ...(f.topic === undefined ? {} : { topic: f.topic }), lines: botLines(f) })), held: g.held ?? [] } };
    },
    answer: async (ref, messageId, keep) => {
      const r = await call("memory_hold_answer", { projectRef: ref, messageId, keep });
      return r.ok ? { ok: true, value: null } : r;
    },
  };
};

/** A chat line of a bot's change held for an admin, still waiting: what the chat shows with Review. */
export const heldLine = (message: { readonly remembered?: { readonly hold?: string } } | undefined): boolean => message?.remembered?.hold === "waiting";

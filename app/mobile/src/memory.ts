// The person's own memory, as the phone's Memory screen reads and edits it: the core (user.md) every session reads, the
// topic files leads open when their work comes up, and the last tidy's "Memory refreshed" line with its Undo
// (memory_get, memory_set, memory_undo on the person's own key).
import type { HubError } from "./desktop";

/** One of the person's files, the part the phone reads (fleetd-contracts MemoryFile). */
export type MemoryFileShape = { readonly topic?: string; readonly text: string; readonly chars: number; readonly cap: number };

type Item = { readonly undone?: boolean };
/** The last tidy's line (a ChatMessage), the part the phone reads. */
export type TidiedShape = {
  readonly messageId: string;
  readonly projectRef: { readonly machineId: string; readonly projectId: string };
  readonly text?: string;
  readonly memoryRefreshed?: { readonly items: readonly Item[]; readonly total?: number; readonly undone?: number };
};

/** How the last tidy went (fleetd-contracts MemoryRefreshRun), the part the phone reads. */
export type TidyRunShape = { readonly state: string; readonly why?: string };

export type MyMemory = { readonly core: MemoryFileShape; readonly topics: readonly MemoryFileShape[]; readonly tidied?: TidiedShape; readonly tidyRun?: TidyRunShape };

type Result<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: HubError };
type Raw = (tool: string, input: unknown) => Promise<{ readonly ok: true; readonly output: unknown } | { readonly ok: false; readonly error: HubError }>;

export type MemoryClient = {
  read(): Promise<Result<MyMemory>>;
  /** The whole file: the core without `topic`. Empty deletes a topic. */
  save(topic: string | undefined, text: string): Promise<Result<null>>;
  undoTidy(tidied: TidiedShape): Promise<Result<null>>;
};

type GetOutput = { user: MemoryFileShape; userFiles?: MemoryFileShape[]; tidied?: TidiedShape; tidyRun?: TidyRunShape };

export const memoryClient = (hub: { readonly call: unknown }): MemoryClient => {
  // The calls' types come with fleetd-contracts; read through their shape until the app's are generated.
  const call = (hub.call as Raw).bind(hub);
  const done = <T>(r: Awaited<ReturnType<Raw>>, value: (o: unknown) => T): Result<T> => (r.ok ? { ok: true, value: value(r.output) } : r);
  return {
    read: async () =>
      done(await call("memory_get", {}), (o) => {
        const g = o as GetOutput;
        return { core: g.user, topics: g.userFiles ?? [], ...(g.tidied ? { tidied: g.tidied } : {}), ...(g.tidyRun ? { tidyRun: g.tidyRun } : {}) };
      }),
    save: async (topic, text) => done(await call("memory_set", { scope: "user", text, ...(topic === undefined ? {} : { topic }) }), () => null),
    undoTidy: async (tidied) => done(await call("memory_undo", { projectRef: tidied.projectRef, messageId: tidied.messageId }), () => null),
  };
};

/** How many of a tidy's changes are still in effect: Undo shows while any is. */
export function openChanges(tidied: TidiedShape | undefined): number {
  const r = tidied?.memoryRefreshed;
  if (!r) return 0;
  const total = r.total ?? r.items.length;
  return total - (r.undone ?? r.items.filter((i) => i.undone === true).length);
}

/** The core's text without its topic lines, which the screen shows as the topics' rows. */
export const coreEntries = (text: string): string =>
  text
    .split("\n")
    .filter((l) => !(l.startsWith("- [") && l.trimEnd().endsWith(".md)")))
    .join("\n");

/** The core as saved from its editor: the entries typed, then the topic lines it had, which the editor doesn't show. */
export function withTopicLines(typed: string, before: string): string {
  const links = before.split("\n").filter((l) => l.startsWith("- [") && l.trimEnd().endsWith(".md)"));
  const body = typed.replace(/\s+$/, "");
  const lines = [...(body ? [body] : []), ...links];
  return lines.length ? `${lines.join("\n")}\n` : "";
}

/** Why the last tidy didn't run, when it didn't. */
export const tidyFailed = (run: TidyRunShape | undefined): string | undefined => (run?.state === "failed" ? (run.why ?? "It failed.") : undefined);

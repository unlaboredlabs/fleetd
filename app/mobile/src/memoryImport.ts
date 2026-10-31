// Import Memory (screens/ImportMemory.tsx), as Grok's: the person copies fleetd's export prompt into another
// assistant, pastes its answer back, and the hub distills it into entries in their own memory, saying how many it
// added. The hub's two calls sit behind ImportClient; the screen's states are this reducer's, so they're tested
// without a phone.
import type { HubError } from "./desktop";

export type Result<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: HubError };

/** What an import wrote, and what it left out because it looked like a secret or the memory was full. */
export interface Imported {
  readonly added: number;
  readonly secrets: number;
  readonly full: number;
}

/** The hub's side: its export prompt, and the pasted answer turned into memory entries. */
export interface ImportClient {
  readonly prompt: () => Promise<Result<string>>;
  readonly add: (text: string) => Promise<Result<Imported>>;
}

/** Distilling is a model turn on the person's own Claude, about 30 to 90 seconds. */
export const IMPORT_MS = 180_000;

/** memory_import's answer (fleetd-contracts memory.rs), the part the phone reads. */
interface ImportOutput {
  readonly prompt: string;
  readonly added: readonly { readonly text: string; readonly replaced?: string }[];
  readonly skipped: readonly { readonly text: string; readonly why: "duplicate" | "secret" | "full" }[];
}

type Call = (tool: "memory_import", input: { text?: string }, timeoutMs?: number) => Promise<{ readonly ok: true; readonly output: ImportOutput } | { readonly ok: false; readonly error: HubError }>;

/** What an answer of memory_import came to. */
export const importedOf = (o: Pick<ImportOutput, "added" | "skipped">): Imported => ({
  added: o.added.length,
  secrets: o.skipped.filter((x) => x.why === "secret").length,
  full: o.skipped.filter((x) => x.why === "full").length,
});

/**
 * memory_import, on the person's own key: without text it answers the prompt alone, which the screen asks for as it
 * opens (never a copy of its own); with the paste it waits for the model turn and writes to their memory.
 */
export const importClient = (hub: { readonly call: unknown }): ImportClient => {
  // The call's types come with fleetd-contracts' memory_import; read through its shape until the app's are generated.
  const call = (hub.call as Call).bind(hub);
  return {
    prompt: async () => {
      const r = await call("memory_import", {});
      return r.ok ? { ok: true, value: r.output.prompt } : r;
    },
    add: async (text) => {
      const r = await call("memory_import", { text }, IMPORT_MS);
      return r.ok ? { ok: true, value: importedOf(r.output) } : r;
    },
  };
};

export type PromptState = { readonly t: "loading" } | { readonly t: "ready"; readonly text: string } | { readonly t: "failed"; readonly error: HubError };

/** The paste and what became of it: being written, sent and distilling, added (how many), or refused. */
export type Phase = { readonly t: "editing" } | { readonly t: "working" } | { readonly t: "done"; readonly imported: Imported } | { readonly t: "failed"; readonly error: HubError };

export interface ImportState {
  readonly prompt: PromptState;
  readonly text: string;
  readonly phase: Phase;
  /** The prompt was just copied: its button says so for a moment. */
  readonly copied: boolean;
}

export type ImportMsg =
  | { readonly t: "prompt"; readonly result: Result<string> }
  | { readonly t: "reloadPrompt" }
  | { readonly t: "copied" }
  | { readonly t: "copiedShown" }
  | { readonly t: "typed"; readonly text: string }
  | { readonly t: "add" }
  | { readonly t: "added"; readonly result: Result<Imported> };

export const initialImport: ImportState = { prompt: { t: "loading" }, text: "", phase: { t: "editing" }, copied: false };

export const importStep = (s: ImportState, m: ImportMsg): ImportState => {
  switch (m.t) {
    case "prompt":
      return { ...s, prompt: m.result.ok ? { t: "ready", text: m.result.value } : { t: "failed", error: m.result.error } };
    case "reloadPrompt":
      return { ...s, prompt: { t: "loading" } };
    case "copied":
      return s.prompt.t === "ready" ? { ...s, copied: true } : s;
    case "copiedShown":
      return { ...s, copied: false };
    case "typed":
      // Nothing changes under a paste being distilled; editing after an outcome starts over.
      return s.phase.t === "working" ? s : { ...s, text: m.text, phase: { t: "editing" } };
    case "add":
      return canAdd(s) ? { ...s, phase: { t: "working" } } : s;
    case "added":
      if (s.phase.t !== "working") return s;
      // Added: the paste is done with. Refused: it stays, to try again.
      return m.result.ok ? { ...s, text: "", phase: { t: "done", imported: m.result.value } } : { ...s, phase: { t: "failed", error: m.result.error } };
  }
};

/** Add to Memory: something pasted, and not already on its way. */
export const canAdd = (s: ImportState): boolean => s.text.trim() !== "" && s.phase.t !== "working";

const count = (n: number, one: string, many: string): string => (n === 1 ? `1 ${one}` : `${String(n)} ${many}`);

/** What an import came to: a title, and what it means, with what it left out (secrets, a full memory). */
export const addedWords = (r: Imported): { readonly title: string; readonly detail: string } => {
  const notes = [
    r.secrets === 0 ? null : `Left out ${count(r.secrets, "line that looked like a key or password", "lines that looked like keys or passwords")}.`,
    r.full === 0 || r.added === 0 ? null : `${count(r.full, "more didn't", "more didn't")} fit: your memory is full.`,
  ].filter((n) => n !== null);
  if (r.added === 0 && r.full > 0) return { title: "Memory Full", detail: ["None of it fit. Make room under Settings › Memory in the desktop app, then try again.", ...notes].join(" ") };
  if (r.added === 0) return { title: "Nothing New", detail: ["Your memory already has all of it.", ...notes].join(" ") };
  return { title: `Added ${String(r.added)} to Memory`, detail: [`Your Navis and every lead read ${r.added === 1 ? "it" : "them"} from now on.`, ...notes].join(" ") };
};

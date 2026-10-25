// Settings → Memory's rules, kept pure: a file's name, its length against its cap as the hub counts it, and where
// an entry was remembered.
import type { MemoryFile, MemoryNote } from "../../../shared/contracts";
import { toHash } from "../shell/routes";

/** `user.md`, `MEMORY.md` or `<topic>.md`, as the files are named on the hub. */
export const fileName = (f: Pick<MemoryFile, "scope" | "topic">): string => (f.scope === "user" ? "user.md" : f.topic ? `${f.topic}.md` : "MEMORY.md");

/** The hub counts characters (code points), not UTF-16 units: an emoji is one. */
export const charCount = (text: string): number => Array.from(text).length;

export interface CapState {
  readonly line: string;
  /** Past the cap: the hub refuses the save, so the page does first. */
  readonly over: boolean;
}

const n = (x: number) => x.toLocaleString("en-US");

export function capState(text: string, cap: number): CapState {
  const chars = charCount(text);
  return { line: `${n(chars)} of ${n(cap)} characters`, over: chars > cap };
}

/** The project's files together after an edit of one of them, against the project's cap. */
export function projectCapState(files: ReadonlyArray<MemoryFile>, edited: { readonly name: string; readonly text: string } | null, cap: number): CapState {
  const total = files.reduce((sum, f) => sum + (edited && fileName(f) === edited.name ? charCount(edited.text) : f.chars), 0);
  return { line: `${n(total)} of ${n(cap)} characters across this project`, over: total > cap };
}

/** The chat line that said "Remembered: …", which a note links to. */
export const noteHref = (note: MemoryNote): string => toHash({ id: "project", project: note.projectRef, message: note.messageId });

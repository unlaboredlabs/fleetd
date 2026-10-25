// Settings → Memory's rules, kept pure: a file's name, its length against its cap as the hub counts it, its lines as
// entries with where each was remembered, and the whole file after an entry is edited, deleted or put back. The file
// stays the truth: every change is the file's new text, for memory_set.
import type { MemoryFile, MemoryNote } from "../../../shared/contracts";
import { toHash } from "../shell/routes";

/** `user.md`, `MEMORY.md` or `<topic>.md`, as the files are named on the hub. */
export const fileName = (f: Pick<MemoryFile, "scope" | "topic">): string => (f.scope === "user" ? "user.md" : f.topic ? `${f.topic}.md` : "MEMORY.md");

/** The hub counts characters (code points), not UTF-16 units: an emoji is one. */
export const charCount = (text: string): number => Array.from(text).length;

export interface CapState {
  readonly chars: number;
  readonly cap: number;
  readonly line: string;
  /** Past the cap: the hub refuses the save, so the page does first. */
  readonly over: boolean;
}

const n = (x: number) => x.toLocaleString("en-US");

export function capState(text: string, cap: number): CapState {
  const chars = charCount(text);
  return { chars, cap, line: `${n(chars)} of ${n(cap)} characters`, over: chars > cap };
}

/** The project's files together after an edit of one of them, against the project's cap. */
export function projectCapState(files: ReadonlyArray<MemoryFile>, edited: { readonly name: string; readonly text: string } | null, cap: number): CapState {
  const total = files.reduce((sum, f) => sum + (edited && fileName(f) === edited.name ? charCount(edited.text) : f.chars), 0);
  return { chars: total, cap, line: `${n(total)} of ${n(cap)} characters across this project`, over: total > cap };
}

/** The chat line that said "Remembered: …", which a note links to. */
export const noteHref = (note: MemoryNote): string => toHash({ id: "project", project: note.projectRef, message: note.messageId });

/** One line of a file as the page lists it. */
export interface MemoryLine {
  /** Its place in the file, from 0. */
  readonly at: number;
  /** The line as kept, which an edit or an undo finds it by. */
  readonly raw: string;
  /** A remembered line (a card), or a heading someone wrote (a label; edited as text). */
  readonly kind: "entry" | "heading";
  /** What it says, without its "- " or "#". */
  readonly text: string;
  /** Where it came from: only for a line `remember` wrote that reads as it did. Anything else shows none. */
  readonly note?: MemoryNote;
}

const BULLET = /^(\s*(?:[-*+]|\d+[.)])\s+)(.*)$/;
const HEADING = /^(#{1,6}\s+)(.*)$/;

/** MEMORY.md's `- [topic](topic.md)` line, as the hub tells it: the topic is its own group, not an entry. */
const isIndexLine = (line: string): boolean => line.startsWith("- [") && line.trimEnd().endsWith(".md)");

/** The hub keeps an entry as `- <text>` and matches a note to the line that reads exactly that. */
const entryLine = (text: string): string => `- ${text}`;

/** The file's lines, blank ones and MEMORY.md's topic lines left out, each with its note when there is one. */
export function memoryLines(f: Pick<MemoryFile, "scope" | "topic" | "text" | "notes">): MemoryLine[] {
  const index = f.scope === "project" && !f.topic;
  // Notes are newest first; a line written twice gets its newest.
  const notes = new Map<string, MemoryNote>();
  for (const note of f.notes) if (!notes.has(entryLine(note.text))) notes.set(entryLine(note.text), note);
  const out: MemoryLine[] = [];
  split(f.text).lines.forEach((raw, at) => {
    const line = raw.trimEnd();
    if (!line.trim() || (index && isIndexLine(line))) return;
    const heading = HEADING.exec(line);
    const note = notes.get(line);
    out.push(
      heading
        ? { at, raw, kind: "heading", text: heading[2] ?? "" }
        : { at, raw, kind: "entry", text: BULLET.exec(line)?.[2] ?? line.trim(), ...(note ? { note } : {}) },
    );
  });
  return out;
}

/** Whether a line shows under a search: every word of it, in any case. */
export function lineMatches(line: Pick<MemoryLine, "text">, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const text = line.text.toLowerCase();
  return words.every((w) => text.includes(w));
}

/** An entry as typed into its card: one line, as the lead's are, with no edge space. */
export const entryText = (typed: string): string => typed.replace(/\s*\n\s*/g, " ").trim();

interface Lines {
  readonly lines: string[];
  /** Ends with a line break, as the hub writes a file. */
  readonly nl: boolean;
}

function split(text: string): Lines {
  const lines = text.split("\n");
  const nl = lines.at(-1) === "";
  if (nl) lines.pop();
  return { lines, nl };
}

const join = ({ lines, nl }: Lines): string => (lines.length === 0 ? "" : `${lines.join("\n")}${nl ? "\n" : ""}`);

/** Thrown when the line an edit was for is no longer in the file (the lead or another window changed it). */
export class LineGone extends Error {
  constructor(name: string) {
    super(`${name} changed since this was shown, and that entry is no longer in it.`);
  }
}

/** Where `line` is in `lines` now: its old place if it is still there, else wherever it moved. */
function find(lines: ReadonlyArray<string>, line: Pick<MemoryLine, "at" | "raw">): number {
  return lines[line.at] === line.raw ? line.at : lines.indexOf(line.raw);
}

/**
 * The file with `line` reading `text` instead, keeping its "- " (or heading marks), or with it gone when `text` is
 * null. `name` is the file's, for the error when the line is no longer there.
 */
export function withLine(file: string, name: string, line: Pick<MemoryLine, "at" | "raw">, text: string | null): string {
  const f = split(file);
  const i = find(f.lines, line);
  if (i < 0) throw new LineGone(name);
  if (text === null) f.lines.splice(i, 1);
  else {
    // A file saved with CRLF keeps its "\r", which would stop the bullet matching.
    const kept = line.raw.trimEnd();
    const mark = BULLET.exec(kept) ?? HEADING.exec(kept);
    f.lines[i] = `${mark?.[1] ?? ""}${entryText(text)}${line.raw.endsWith("\r") ? "\r" : ""}`;
  }
  return join(f);
}

/**
 * Undo of a delete: the file as it is now with `line` back where it was (or at the end when the file has since got
 * shorter). Unchanged when the line is already there again.
 */
export function restoreLine(file: string, line: Pick<MemoryLine, "at" | "raw">): string {
  const f = split(file);
  if (f.lines.includes(line.raw)) return file;
  f.lines.splice(Math.min(line.at, f.lines.length), 0, line.raw);
  return join(f);
}

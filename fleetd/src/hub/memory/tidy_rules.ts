// A person's own memory's tidy, without the hub or the disk (tidy.ts runs it): when it may start, which chat lines it
// reads, its session's message, and the files it found and left (`Snapshot`), which Undo all puts back.
import type { ChatMessage, MemoryCaps, PersonId } from "../../shared/contracts.ts";
import { clip } from "../leads/text.ts";

/** The prompt of the tidy's session (prompts/defaults/memory.tidy.md). */
export const TIDY_PROMPT_ID = "memory.tidy";
/** A write past a cap starts a tidy this long after it, so a burst of writes gets one. */
export const TIDY_DEBOUNCE_MS = 60_000;
/** A tidy a write asked for starts at least this long after the last one started. */
export const TIDY_GAP_MS = 3_600_000;
/** The night's tidy waits for the night's per-bot refreshes, until this long after the night's hour. */
export const TIDY_LATEST_MS = 2 * 3_600_000;
/** Each bot's chat a tidy reads: newest kept, each message cut. */
export const TIDY_CHAT_CHARS = 40_000;
export const TIDY_MESSAGE_CHARS = 2_000;

/** A person's memory files by name (`user.md`, `<topic>.md`), as a tidy found or left them. */
export type Snapshot = Record<string, string>;

export const sameSnapshot = (a: Snapshot, b: Snapshot): boolean => {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...keys].every((k) => (a[k] ?? "") === (b[k] ?? ""));
};

/** A key of a snapshot's contents, to see whether a person's memory changed since the last tidy. */
export const snapshotKey = (s: Snapshot): string =>
  String(Bun.hash(JSON.stringify(Object.keys(s).sort().map((k) => [k, s[k]]))));

/**
 * Whether `m` is `person`'s own words: their message, or on a hub with only them one without a person (written before
 * people). `only` is whether `person` is the hub's one person.
 */
export const ownWords = (m: ChatMessage, person: PersonId, only: boolean): boolean =>
  m.author === "human" && (m.person === undefined ? only : m.person.personId === person);

/**
 * One line of a bot's chat for `person`'s tidy, or undefined: their own words, and the lead's when nobody else wrote
 * in what it reads (`solo`). Another person's words, and the lead's answers to them, never reach it.
 */
export function tidyChatLine(m: ChatMessage, person: PersonId, only: boolean, solo: boolean): string | undefined {
  const text = clip((m.text ?? "").trim(), TIDY_MESSAGE_CHARS);
  if (!text) return undefined;
  if (ownWords(m, person, only)) return `Human: ${text}`;
  if (m.author === "lead" && solo) return `Lead: ${text}`;
  return undefined;
}

/** The person's memory as the session reads it: the core, then each topic, whole, each under its name. */
export function tidyMemory(files: Snapshot, caps: MemoryCaps): string {
  const names = Object.keys(files).filter((n) => n !== "user.md").sort();
  let out = `Caps, in characters: user.md (the core, read by every session) ${caps.user}, each topic ${caps.topic}.`;
  for (const name of ["user.md", ...names]) {
    const body = (files[name] ?? "").trimEnd();
    out += `\n\n### ${name === "user.md" ? "user.md (core)" : `${name} (topic ${name.slice(0, -3)})`}\n${body || "(empty)"}`;
  }
  return out;
}

/** The tidy session's one message: its prompt, then the memory, then what the person said in each bot since. */
export function tidyPrompt(rules: string, memory: string, chats: { title: string; text: string }[]): string {
  const said = chats.filter((c) => c.text.trim());
  const text =
    said.length === 0 ? "(none)" : said.map((c) => `### ${c.title}\n${c.text}`).join("\n\n");
  return `${rules.trimEnd()}\n\n## Memory now\n${memory}\n\n## Chat since the last tidy\n${text}`;
}

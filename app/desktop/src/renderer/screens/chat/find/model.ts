// The chat's search field, as words and filters: what is typed reads into chat_find's input. A filter is typed
// (`from:lead`, `has:link`, `on:2026-10-14`, `before:…`, `after:…`) or picked, and becomes a chip once it is whole; the
// rest are the words. Pure, so the field and its tests read the same.
import type { ChatFindHas, ChatFindInput } from "../../../../shared/contracts";

/** A filter as its chip shows it. */
export type Chip =
  | { readonly kind: "from"; readonly who: "lead" | "me" | { readonly personId: string; readonly name: string } }
  | { readonly kind: "has"; readonly has: ChatFindHas }
  /** A local day, `YYYY-MM-DD`: `on` it, `before` it (up to its start) or `after` it (from the next day). */
  | { readonly kind: "on" | "before" | "after"; readonly day: string };

export const HAS_WORDS: Readonly<Record<string, ChatFindHas>> = {
  link: "link",
  links: "link",
  image: "image",
  images: "image",
  photo: "image",
  photos: "image",
  file: "file",
  files: "file",
  pr: "pr",
  prs: "pr",
  pinned: "pinned",
  pin: "pinned",
};

export const HAS_LABEL: Readonly<Record<string, string>> = { link: "Links", image: "Images", file: "Files", pr: "Pull requests", pinned: "Pinned" };

/** A chip's words. */
export function chipLabel(c: Chip): string {
  switch (c.kind) {
    case "from":
      return c.who === "lead" ? "From the lead" : c.who === "me" ? "From me" : `From ${c.who.name}`;
    case "has":
      return HAS_LABEL[c.has] ?? c.has;
    case "on":
      return dayLabel(c.day);
    case "before":
      return `Before ${dayLabel(c.day)}`;
    case "after":
      return `After ${dayLabel(c.day)}`;
  }
}

const dayLabel = (day: string): string => {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
};

const pad = (n: number) => String(n).padStart(2, "0");
const dayOf = (at: Date) => `${String(at.getFullYear())}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;

/** `today`, `yesterday` or a `YYYY-MM-DD` that is a real day, as one; else undefined. */
export function dayFrom(text: string, nowMs: number): string | undefined {
  const t = text.toLowerCase();
  if (t === "today") return dayOf(new Date(nowMs));
  if (t === "yesterday") {
    const at = new Date(nowMs);
    at.setDate(at.getDate() - 1);
    return dayOf(at);
  }
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(t);
  if (!m) return undefined;
  const at = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return at.getMonth() === Number(m[2]) - 1 && at.getDate() === Number(m[3]) ? dayOf(at) : undefined;
}

/** The people a `from:` names, by name; `me` is the person this app acts as. */
export interface Who {
  readonly people: ReadonlyArray<{ readonly personId: string; readonly name: string }>;
  readonly me?: string | undefined;
}

/** A whole typed filter as its chip, or undefined when `word` isn't one (yet). */
export function chipOf(word: string, who: Who, nowMs: number): Chip | undefined {
  const at = word.indexOf(":");
  if (at <= 0) return undefined;
  const key = word.slice(0, at).toLowerCase();
  const value = word.slice(at + 1);
  if (value === "") return undefined;
  if (key === "from") {
    const v = value.toLowerCase();
    if (v === "lead") return { kind: "from", who: "lead" };
    if (v === "me" && who.me !== undefined) return { kind: "from", who: "me" };
    const person = who.people.find((p) => p.name.toLowerCase() === v) ?? who.people.find((p) => p.name.toLowerCase().split(/\s+/)[0] === v);
    return person === undefined ? undefined : { kind: "from", who: person };
  }
  if (key === "has" || key === "is") {
    const has = HAS_WORDS[value.toLowerCase()];
    return has === undefined ? undefined : { kind: "has", has };
  }
  if (key === "on" || key === "before" || key === "after" || key === "during") {
    const day = dayFrom(value, nowMs);
    return day === undefined ? undefined : { kind: key === "during" ? "on" : key, day };
  }
  return undefined;
}

/** What a filter key being typed (`fr`, `from:`, `has:l`) could become, for the list under the field. */
export function suggestions(last: string, who: Who): readonly Chip[] {
  const l = last.toLowerCase();
  const all: Chip[] = [
    { kind: "from", who: "lead" },
    ...(who.me === undefined ? [] : [{ kind: "from", who: "me" } as const]),
    ...who.people.filter((p) => p.personId !== who.me).map((p): Chip => ({ kind: "from", who: p })),
    ...(["link", "image", "file", "pr", "pinned"] as const).map((has): Chip => ({ kind: "has", has })),
  ];
  if (l === "") return all.filter((c) => c.kind === "has" || (c.kind === "from" && (c.who === "lead" || c.who === "me")));
  const typed = (c: Chip): string => (c.kind === "from" ? `from:${c.who === "lead" || c.who === "me" ? c.who : c.who.name.toLowerCase()}` : c.kind === "has" ? `has:${c.has}` : "");
  // Only once it reads as a filter: a word that merely starts like one ("fr") stays a word.
  if (!l.includes(":")) return [];
  return all.filter((c) => typed(c).startsWith(l) || (c.kind === "from" && typeof c.who === "object" && l.startsWith("from:") && c.who.name.toLowerCase().includes(l.slice(5))));
}

/** The words and chips as chat_find's input for `projectRef` (no `before`, no `limit`). */
export function findInput(projectRef: ChatFindInput["projectRef"], words: string, chips: readonly Chip[], me: string | undefined): ChatFindInput {
  const input: { -readonly [K in keyof ChatFindInput]: ChatFindInput[K] } = { projectRef };
  const w = words.trim();
  if (w !== "") input.words = w;
  const has: ChatFindHas[] = [];
  const start = (day: string, plus = 0) => {
    const [y, m, d] = day.split("-").map(Number) as [number, number, number];
    return new Date(y, m - 1, d + plus).toISOString();
  };
  for (const c of chips) {
    if (c.kind === "from") {
      if (c.who === "lead") input.author = "lead";
      else if (c.who === "me") {
        if (me !== undefined) input.personId = me;
      } else input.personId = c.who.personId;
    } else if (c.kind === "has") {
      if (!has.includes(c.has)) has.push(c.has);
    } else if (c.kind === "on") {
      input.since = start(c.day);
      input.until = start(c.day, 1);
    } else if (c.kind === "before") input.until = start(c.day);
    else input.since = start(c.day, 1);
  }
  if (has.length > 0) input.has = has;
  return input;
}

/** Whether there is anything to look for: words or a filter. */
export const asks = (words: string, chips: readonly Chip[]): boolean => words.trim() !== "" || chips.length > 0;

/** A filter of the same kind replaces the one before (one `from`, one day); `has` ones add up. */
export function withChip(chips: readonly Chip[], chip: Chip): readonly Chip[] {
  const dated = (k: Chip["kind"]) => k === "on" || k === "before" || k === "after";
  const kept = chips.filter((c) => {
    if (chip.kind === "has") return !(c.kind === "has" && c.has === chip.has);
    if (chip.kind === "from") return c.kind !== "from";
    if (chip.kind === "on") return !dated(c.kind);
    return c.kind !== chip.kind && c.kind !== "on";
  });
  return [...kept, chip];
}

/** "3 of 48", "48", "10,000+" for the field's end. */
export function countLabel(count: number | undefined, countMore: boolean, at: number | undefined): string | undefined {
  if (count === undefined) return undefined;
  const total = `${count.toLocaleString("en-US")}${countMore ? "+" : ""}`;
  if (count === 0) return "No results";
  return at === undefined ? total : `${(at + 1).toLocaleString("en-US")} of ${total}`;
}

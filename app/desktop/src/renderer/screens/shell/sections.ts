// Your sections of chats on one hub (W580): names you give to some of your chats, which then sit together under a quiet
// label, below the chats in none. The hub keeps them (chat_sections_get / _set), in your order: the same on your phone
// and each of your desktops, and a teammate's never change yours. A section is made with its first chat (a row's menu,
// Move to section › New section…) and goes with its last; a pinned chat keeps its section and shows among the pins
// only. A change shows at once and goes to the hub as the whole list (ahead.ts); one the hub refuses is taken back, with
// why. Another device's change (chat.sections, which only your devices see) arrives live. The last sections read are
// kept on this computer too, only so a launch shows them before the hub answers: a change is never made to those, but
// to the hub's own list, read first (changeSections), since the list sent replaces the hub's. Which sections are
// folded is this computer's alone (sidebarState.ts). The list's lines and each change to the sections are pure, so
// they are unit-tested.
import { useEffect, useState } from "react";
import type { ChatSection, ProjectRef } from "../../../shared/contracts";
import type { DataLayer } from "../../src/data/queries";
import { useDataLayer, useReadOf, useToolQuery } from "../../src/data/react";
import { ahead, keptPerHub } from "./ahead";
import { projectId } from "./model";

/** The hub's limits (chat_sections_set), checked here first so what it would refuse is said before it is sent. */
export const SECTION_NAME_MAX = 40;
export const SECTIONS_MAX = 50;

/** A new section's id: the hub keeps it as sent, through a rename or a move. */
export const newSectionId = (): string => crypto.randomUUID();

const has = (section: ChatSection, key: string): boolean => section.chats.some((c) => projectId(c) === key);

/** A chat ("machineId/projectId") is in the first section that names it, as the hub keeps it. */
export const sectionOf = (sections: readonly ChatSection[], key: string): ChatSection | undefined => sections.find((s) => has(s, key));

const without = (sections: readonly ChatSection[], key: string): ChatSection[] => sections.map((s) => (has(s, key) ? { ...s, chats: s.chats.filter((c) => projectId(c) !== key) } : s));
/** A section goes away with its last chat. */
const kept = (sections: readonly ChatSection[]): ChatSection[] => sections.filter((s) => s.chats.length > 0);

/** `chat` moved into the section `to`, or out of every section (null): the same list when it is there already. */
export const moveChat = (sections: readonly ChatSection[], chat: ProjectRef, to: string | null): readonly ChatSection[] => {
  const key = projectId(chat);
  if ((sectionOf(sections, key)?.id ?? null) === to || (to !== null && !sections.some((s) => s.id === to))) return sections;
  return kept(without(sections, key).map((s) => (s.id === to ? { ...s, chats: [...s.chats, chat] } : s)));
};

/** A new section, last, with `chat` as its first. */
export const addSection = (sections: readonly ChatSection[], id: string, name: string, chat: ProjectRef): readonly ChatSection[] =>
  kept([...without(sections, projectId(chat)), { id, name: name.trim(), chats: [chat] }]);

/** Whether one more section fits once `chat` has left its own: the hub keeps up to SECTIONS_MAX. */
export const roomForSection = (sections: readonly ChatSection[], chat: ProjectRef): boolean => kept(without(sections, projectId(chat))).length < SECTIONS_MAX;

export const renameSection = (sections: readonly ChatSection[], id: string, name: string): readonly ChatSection[] =>
  sections.some((s) => s.id === id && s.name !== name.trim()) ? sections.map((s) => (s.id === id ? { ...s, name: name.trim() } : s)) : sections;

/** Without the section: its chats are in none, back on top of the list. */
export const removeSection = (sections: readonly ChatSection[], id: string): readonly ChatSection[] => sections.filter((s) => s.id !== id);

/**
 * The section moved one place up (-1) or down (1) among those on show (`shown`, their ids in order): past the next one
 * you see, and any between that have no chat on show (all pinned or archived), so a move always shows.
 */
export const moveSection = (sections: readonly ChatSection[], id: string, by: -1 | 1, shown: readonly string[]): readonly ChatSection[] => {
  const section = sections.find((s) => s.id === id);
  const at = shown.indexOf(id);
  const past = at === -1 ? undefined : shown[at + by];
  const to = sections.findIndex((s) => s.id === past);
  if (section === undefined || to === -1) return sections;
  const next = sections.filter((s) => s.id !== id);
  // Without it, the ones after it are one place up: `to` is before the one passed going up, after it going down.
  next.splice(to, 0, section);
  return next;
};

/** Why the hub would refuse `name` for a section (`except`: the one being renamed); undefined when it would take it. */
export const sectionNameProblem = (sections: readonly ChatSection[], name: string, except?: string): string | undefined => {
  const trimmed = name.trim();
  const length = Array.from(trimmed).length;
  if (length === 0) return "A section needs a name";
  if (length > SECTION_NAME_MAX) return `Keep it to ${String(SECTION_NAME_MAX)} characters: this one has ${String(length)}`;
  if (sections.some((s) => s.id !== except && s.name === trimmed)) return `You already have a section named “${trimmed}”`;
  return undefined;
};

/** What a section's rows say of themselves, for its label. */
interface Marked {
  readonly section?: string | undefined;
  readonly want?: unknown;
  readonly unread: boolean;
}

export type SectionLine<R> =
  | { readonly t: "chat"; readonly row: R }
  /**
   * A section's label. `count`: its chats on show; `dot`: one of them waits on you ("you"), else has a new message
   * ("new"). Folded, its chats have no lines.
   */
  | { readonly t: "section"; readonly section: ChatSection; readonly folded: boolean; readonly count: number; readonly dot: "you" | "new" | undefined };

/**
 * The list under the pins, from its rows in their order (`rows`: the chats on show that aren't pinned): the chats in no
 * section on top with no label, then each section in your order under its label. A section with no chat on show (all
 * pinned or archived) has no label; a folded one (`folded`) is its label alone.
 */
export const sectionLines = <R extends Marked>(rows: ReadonlyArray<R>, sections: readonly ChatSection[], folded: (id: string) => boolean): ReadonlyArray<SectionLine<R>> => {
  const known = new Set(sections.map((s) => s.id));
  const lines: SectionLine<R>[] = rows.filter((r) => r.section === undefined || !known.has(r.section)).map((row) => ({ t: "chat", row }));
  for (const section of sections) {
    const inside = rows.filter((r) => r.section === section.id);
    if (inside.length === 0) continue;
    const isFolded = folded(section.id);
    const dot = inside.some((r) => r.want !== undefined) ? "you" : inside.some((r) => r.unread) ? "new" : undefined;
    lines.push({ t: "section", section, folded: isFolded, count: inside.length, dot });
    if (!isFolded) for (const row of inside) lines.push({ t: "chat", row });
  }
  return lines;
};

/** What a screen reader says of a folded label beside its name: what it holds. */
export const foldedWords = (count: number, dot: "you" | "new" | undefined): string =>
  [count === 1 ? "1 chat" : `${String(count)} chats`, ...(dot === "you" ? ["one waits on you"] : dot === "new" ? ["something new inside"] : [])].join(", ");

const NONE = {} as const;

const isRef = (c: unknown): c is ProjectRef =>
  typeof c === "object" && c !== null && typeof (c as { machineId?: unknown }).machineId === "string" && typeof (c as { projectId?: unknown }).projectId === "string";
const isSection = (s: unknown): s is ChatSection =>
  typeof s === "object" && s !== null && typeof (s as { id?: unknown }).id === "string" && typeof (s as { name?: unknown }).name === "string" && Array.isArray((s as { chats?: unknown }).chats) && (s as { chats: unknown[] }).chats.every(isRef);

const before = keptPerHub("fleetd.sidebarSections", (raw): readonly ChatSection[] | undefined => (Array.isArray(raw) ? raw.filter(isSection) : undefined));

/** Why the hub didn't answer, in words for the person: its own, but a hub from before sections has no such tool. */
const why = (error: { readonly code: string; readonly message: string }): string =>
  error.code === "not_found" ? "This hub doesn’t keep sections yet. Update it to use them." : error.message;

const saved = ahead({
  send: async (layer, sections: readonly ChatSection[]) => {
    const out = await layer.call("chat_sections_set", { sections: [...sections] });
    return out.ok ? undefined : why(out.error);
  },
  read: "chat_sections_get",
  list: (answer): readonly ChatSection[] => answer.sections,
  refused: "Couldn’t save your sections",
  why,
});

/** This hub's sections for you, in your order: your changes still on their way, else the hub's, else the ones kept from before. */
export const useSections = (): readonly ChatSection[] | undefined => {
  const layer = useDataLayer();
  const { hub } = layer;
  const read = useToolQuery("chat_sections_get", NONE).data?.sections;
  const want = saved.useAhead(layer, useReadOf("chat_sections_get", NONE));
  const [last] = useState(() => before.read(hub));
  useEffect(() => {
    if (read !== undefined) before.keep(hub, read);
  }, [hub, read]);
  return want ?? read ?? last;
};

/**
 * Changes your sections on `layer`'s hub: `change` gets them as they are there and returns them changed (the same list
 * for no change), and the whole list is saved. The sidebar takes it at once. Changes made while one is on its way go
 * after it, only the newest of them; a refusal puts the hub's sections back and says why. A hub that hasn't answered
 * with your sections yet is asked first, so the list sent never lacks a section made on another device; if it can't
 * say, nothing is sent, and the person hears why as for a refusal (ahead.ts).
 */
export const changeSections = (layer: DataLayer, change: (sections: readonly ChatSection[]) => readonly ChatSection[]): Promise<void> => saved.change(layer, change);

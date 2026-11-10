// This person's sections of chats on one hub (W580): names they give to some of their chats, which then sit under a
// quiet label in the list. The hub keeps them (chat_sections_get / _set), in their order, the same on each of their
// devices; this phone keeps a copy per hub (prefs.ts sections) so the list shows them at once on launch and offline. A
// change shows at once and goes to the hub as the whole list, one set at a time; one the hub hasn't taken yet (offline,
// the link dropped, the app closed) stays pending for that hub, kept on disk, and goes on its next live link, over what
// the hub has. One the hub refuses (a name it won't take, a hub from before sections) is taken back: the list is the
// hub's again, and the person is told why. Another device's change (chat.sections, which only this person's devices
// get) is read again, unless one made here is still pending. A change made while the hub is being asked what they are
// (at launch, on a new link), or after it couldn't say, is not sent as this phone's copy changed: it shows at once,
// waits for the hub's own list, is made again on top of that and then sent, since the list sent replaces the hub's and
// the copy may lack a section made on another device. Only if the hub can't be reached does it wait as one made
// offline. Which sections are folded is this phone's alone (prefs.ts folded). The list's lines and each change to the
// sections are pure, so they are unit-tested.
import type { ChatSection, HubError, ToolInput } from "./desktop";
import type { Typed } from "./hub/client";
import type { ChatRow } from "./lists";
import { keyOf, refOf, type Key } from "./store";

/** One section: its id (made here when the section is, kept through a rename or a move), its name, its chats. */
export interface Section {
  readonly id: string;
  readonly name: string;
  readonly chats: readonly Key[];
}

/** The hub's limits (chat_sections_set), checked here first so what it would refuse never leaves the prompt. */
export const SECTION_NAME_MAX = 40;
export const SECTIONS_MAX = 50;

/** A new section's id: the hub keeps it as sent. */
export const newSectionId = (): string => `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;

/** A chat is in the first section that names it, as the hub keeps it. */
export const sectionOf = (sections: readonly Section[], key: Key): Section | undefined => sections.find((s) => s.chats.includes(key));

const without = (sections: readonly Section[], key: Key): readonly Section[] => sections.map((s) => (s.chats.includes(key) ? { ...s, chats: s.chats.filter((k) => k !== key) } : s));
/** A section goes away with its last chat. */
const kept = (sections: readonly Section[]): readonly Section[] => sections.filter((s) => s.chats.length > 0);

/** `key` moved into the section `to`, or out of every section (null): the same list when it is there already. */
export const moveChat = (sections: readonly Section[], key: Key, to: string | null): readonly Section[] => {
  if ((sectionOf(sections, key)?.id ?? null) === to || (to !== null && !sections.some((s) => s.id === to))) return sections;
  return kept(without(sections, key).map((s) => (s.id === to ? { ...s, chats: [...s.chats, key] } : s)));
};

/** A new section, last, with `key` as its first chat. */
export const addSection = (sections: readonly Section[], id: string, name: string, key: Key): readonly Section[] => kept([...without(sections, key), { id, name: name.trim(), chats: [key] }]);

/** Whether one more section fits once `key` has left its own: the hub keeps up to SECTIONS_MAX. */
export const roomForSection = (sections: readonly Section[], key: Key): boolean => kept(without(sections, key)).length < SECTIONS_MAX;

export const renameSection = (sections: readonly Section[], id: string, name: string): readonly Section[] =>
  sections.some((s) => s.id === id && s.name !== name.trim()) ? sections.map((s) => (s.id === id ? { ...s, name: name.trim() } : s)) : sections;

/** Without the section: its chats are in none, back on top of the list. */
export const removeSection = (sections: readonly Section[], id: string): readonly Section[] => sections.filter((s) => s.id !== id);

/**
 * The section moved one place up (-1) or down (1) among those on show (`shown`, their ids in order): past the next one
 * the person sees, and any between that have no chat on show (all pinned or archived), so a move always shows.
 */
export const moveSection = (sections: readonly Section[], id: string, by: -1 | 1, shown: readonly string[]): readonly Section[] => {
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

/** Why the hub would refuse `name` for a section (`except`: the one being renamed), in words for the person. */
export const nameProblem = (sections: readonly Section[], name: string, except?: string): string | undefined => {
  const trimmed = name.trim();
  const length = Array.from(trimmed).length;
  if (length === 0) return "A section needs a name.";
  if (length > SECTION_NAME_MAX) return `A section's name is at most ${String(SECTION_NAME_MAX)} characters: this one has ${String(length)}.`;
  if (sections.some((s) => s.id !== except && s.name === trimmed)) return `You already have a section named “${trimmed}”.`;
  return undefined;
};

export type SectionLine =
  | { readonly t: "chat"; readonly row: ChatRow }
  /** A section's label. `count`: its chats on show; `dot`: one of them needs you or has something unread. */
  | { readonly t: "section"; readonly section: Section; readonly folded: boolean; readonly count: number; readonly dot: boolean };

const asksForYou = (r: ChatRow): boolean => r.want !== undefined || r.approvals > 0 || (r.unread > 0 && !r.muted) || r.markedUnread;

/**
 * The list under the pins: the chats in no section on top with no label, then each section in the person's order under
 * its label, its chats in the list's own order (`rows`': what waits for you, then what spoke last). A section with no
 * chat on show (all pinned or archived) has no label; a folded one (`folded`: ids) is its label alone.
 */
export const sectionLines = (rows: readonly ChatRow[], sections: readonly Section[], folded: readonly string[]): readonly SectionLine[] => {
  const place = new Map<Key, string>();
  for (const s of sections) for (const k of s.chats) if (!place.has(k)) place.set(k, s.id);
  const lines: SectionLine[] = rows.filter((r) => !place.has(r.key)).map((row) => ({ t: "chat", row }));
  for (const section of sections) {
    const inside = rows.filter((r) => place.get(r.key) === section.id);
    if (inside.length === 0) continue;
    const isFolded = folded.includes(section.id);
    lines.push({ t: "section", section, folded: isFolded, count: inside.length, dot: inside.some(asksForYou) });
    if (!isFolded) for (const row of inside) lines.push({ t: "chat", row });
  }
  return lines;
};

/** What VoiceOver says of a label: its name, folded or open, and what a folded one holds. */
export const labelWords = (line: Extract<SectionLine, { t: "section" }>): string =>
  line.folded ? [line.section.name, "folded", line.count === 1 ? "1 chat" : `${String(line.count)} chats`, ...(line.dot ? ["something new inside"] : [])].join(", ") : `${line.section.name}, open`;

/** Where Move to Section can send a chat: each of the person's sections, none, or a new one. */
export interface SectionChoice {
  readonly label: string;
  /** Where the chat is now. */
  readonly ticked: boolean;
  readonly to: { readonly t: "section"; readonly id: string } | { readonly t: "none" } | { readonly t: "new" };
}

export const sectionChoices = (sections: readonly Section[], key: Key): readonly SectionChoice[] => {
  const own = sectionOf(sections, key)?.id;
  return [
    ...sections.map((s): SectionChoice => ({ label: s.name, ticked: s.id === own, to: { t: "section", id: s.id } })),
    { label: "No Section", ticked: own === undefined, to: { t: "none" } },
    { label: "New Section…", ticked: false, to: { t: "new" } },
  ];
};

export type LabelAction = "rename" | "up" | "down" | "remove";

/** What a held label offers: a move only where there is a section on show to move past. */
export const labelActions = (id: string, shown: readonly string[]): readonly LabelAction[] => {
  const at = shown.indexOf(id);
  return ["rename", ...(at > 0 ? (["up"] as const) : []), ...(at !== -1 && at < shown.length - 1 ? (["down"] as const) : []), "remove"];
};

/** Where this phone keeps its copy of one hub's sections, and whether a change to them waits to be sent. */
export interface SectionStore {
  saved(): readonly Section[];
  save(sections: readonly Section[]): void;
  pending(): boolean;
  setPending(on: boolean): void;
}

/** The hub's two calls for them (Session's client). */
export type SectionCall = <T extends "chat_sections_get" | "chat_sections_set">(tool: T, input: ToolInput<T>) => Promise<Typed<T>>;

const fromHub = (sections: readonly ChatSection[]): readonly Section[] => sections.map((s) => ({ id: s.id, name: s.name, chats: s.chats.map(keyOf) }));
const toHub = (sections: readonly Section[]): ChatSection[] => sections.map((s) => ({ id: s.id, name: s.name, chats: s.chats.map(refOf) }));

/** A copy in memory: a session made without one (tests, a screen's own). */
export const memorySections = (start: readonly Section[] = []): SectionStore => {
  let sections = start;
  let pending = false;
  return {
    saved: () => sections,
    save: (next) => {
      sections = next;
    },
    pending: () => pending,
    setPending: (on) => {
      pending = on;
    },
  };
};

/**
 * The hub said no: a list it won't keep (invalid: a name twice, one too long), a hub from before sections (not_found),
 * a key with no person (forbidden). Anything else (offline, the link dropped mid-call, no answer in time, a failure on
 * the hub) leaves the change to send again.
 */
const refused = (code: string): boolean => code === "invalid" || code === "not_found" || code === "forbidden";

/** What the person reads when a change was taken back: the hub's own words for a list it won't keep. */
const refusalWords = (error: HubError): string => (error.code === "not_found" ? "This hub doesn't keep sections yet. Update it to use them." : error.message);

export class Sections {
  readonly #call: SectionCall;
  readonly #store: SectionStore;
  /** A change the hub refused was taken back: its words, for the person. */
  readonly #onRefused: (words: string) => void;
  #sending = false;
  /** Changes made here: a read, or a set's answer, from before the newest one is stale. */
  #edits = 0;
  /** Whether this phone's copy is the hub's own list: it answered a read or took a set, and isn't being asked again. */
  #fresh = false;
  /** The reads asked, and whether the newest is still on its way: only its answer counts. */
  #reads = 0;
  #reading = false;
  /** Changes made before the hub said what the sections are: made again on top of its list once it answers. */
  #waiting: Array<(sections: readonly Section[]) => readonly Section[]> = [];

  constructor(call: SectionCall, store: SectionStore, onRefused: (words: string) => void = () => undefined) {
    this.#call = call;
    this.#store = store;
    this.#onRefused = onRefused;
  }

  /** On each snapshot, and when another of this person's devices changed them. */
  async read(): Promise<void> {
    if (this.#store.pending()) return this.#flush();
    // What the hub has may be newer than this copy until it answers: a change made meanwhile waits for it.
    this.#fresh = false;
    this.#reading = true;
    const no = ++this.#reads;
    const edits = this.#edits;
    const r = await this.#call("chat_sections_get", {});
    // Asked again since: that answer is the one that counts.
    if (no !== this.#reads) return;
    this.#reading = false;
    if (!r.ok) {
      // A hub from before sections has none to show.
      if (this.#waited().length === 0) return;
      // What waited for the answer is a change made offline, for the next live link; a hub that won't say takes it
      // now, to refuse it in its own words.
      this.#store.setPending(true);
      return refused(r.error.code) ? this.#flush() : undefined;
    }
    if (edits !== this.#edits || this.#store.pending() || this.#sending) return;
    this.#fresh = true;
    const waiting = this.#waited();
    // The hub's own list, with what waited for it made again on top: no section made on another device is left out.
    this.#store.save(waiting.reduce((sections, change) => change(sections), fromHub(r.output.sections)));
    if (waiting.length === 0) return;
    this.#store.setPending(true);
    return this.#flush();
  }

  /**
   * Changed here: `how` gets the sections and returns them changed. Shown at once, then sent: as this phone's copy
   * changed when that is the hub's list, else made again on the hub's own once it says.
   */
  change(how: (sections: readonly Section[]) => readonly Section[]): Promise<void> {
    if (!this.#fresh && !this.#store.pending()) {
      this.#store.save(how(this.#store.saved()));
      this.#waiting.push(how);
      return this.#reading ? Promise.resolve() : this.read();
    }
    this.#edits++;
    this.#store.save(how(this.#store.saved()));
    this.#store.setPending(true);
    return this.#flush();
  }

  /** The changes that waited for the hub's list, taken. */
  #waited(): ReadonlyArray<(sections: readonly Section[]) => readonly Section[]> {
    const waiting = this.#waiting;
    this.#waiting = [];
    return waiting;
  }

  /** The newest list to the hub, one set at a time; what changes meanwhile goes next. */
  async #flush(): Promise<void> {
    if (this.#sending) return;
    this.#sending = true;
    let taken: HubError | undefined;
    try {
      while (this.#store.pending()) {
        const edits = this.#edits;
        const r = await this.#call("chat_sections_set", { sections: toHub(this.#store.saved()) });
        if (r.ok) {
          // Changed again while this one went: still pending, and the loop sends the newest. Else the list as the
          // hub stored it is the truth (a name trimmed, a chat it no longer has left out).
          this.#fresh = true;
          if (edits !== this.#edits) continue;
          this.#store.setPending(false);
          this.#store.save(fromHub(r.output.sections));
          continue;
        }
        if (!refused(r.error.code)) return;
        // Refused whole, whatever else changed meanwhile was in it: nothing waits, and the hub's list comes back.
        this.#store.setPending(false);
        taken = r.error;
      }
    } finally {
      this.#sending = false;
    }
    if (taken === undefined) return;
    this.#onRefused(refusalWords(taken));
    await this.read();
  }
}

// How the built-in prompts' list presents the hub's editable prompts (event lines are facts the hub fills in, not
// prompts): the edited ones first, the rest behind a few groups by what a person is looking for, each a plain name and
// one line on what it is for. The hub's own title and `sentWhen` stay the fallback, so a prompt a newer hub adds still
// shows up, in "Other", with the hub's words.
import type { PromptSummary, RetiredPromptOverride } from "./contracts";

export interface CatalogGroup {
  readonly key: string;
  readonly title: string;
  readonly blurb: string;
}

export const GROUPS = [
  { key: "lead", title: "The lead", blurb: "Its role and rules, how it talks, and what it is sent as work comes in." },
  { key: "tasks", title: "Task agents", blurb: "The first message of each agent the lead starts." },
  { key: "reviews", title: "Reviews and checks", blurb: "What a pull request's reviewer is told." },
  { key: "messages", title: "Messages", blurb: "What reaches an agent while it runs." },
  { key: "other", title: "Other", blurb: "Prompts this version of the app has no description for yet." },
] as const satisfies ReadonlyArray<CatalogGroup>;

export type GroupKey = (typeof GROUPS)[number]["key"];

interface Entry {
  readonly group: GroupKey;
  readonly name: string;
  readonly description: string;
}

const e = (group: GroupKey, name: string, description: string): Entry => ({ group, name, description });

/** Keyed by registry id: the editable prompts (the instructions have their own page). Order within a group follows this table. */
const ENTRIES: Readonly<Record<string, Entry>> = {
  "lead.start": e("lead", "Lead's role, rules and playbooks", "What the lead does, what it must never do, and how it runs a bug fix, a feature or research."),
  "lead.voice": e("lead", "Voice", "How the lead talks in chat: short bubbles, exact details, and the blocks it can show."),
  "lead.profiles": e("lead", "Task profiles", "How the lead picks a profile for a task; added to its first message with the project's allowed profiles."),
  "task.brief.write": e("tasks", "Writer task", "First message of a task that changes code and opens a pull request."),
  "review.reviewer": e("reviews", "Reviewer", "Reviews a pull request each round, by the project's review rules."),
  "steer.message": e("messages", "Your steer, mid-run", "Your words (or the lead's) delivered straight to a running agent."),
};

const ORDER: ReadonlyMap<string, number> = new Map(Object.keys(ENTRIES).map((id, ix) => [id, ix]));

/** The hub's groups, for a prompt this table does not know (by the hub's group name, old or new). */
const HUB_GROUP: Readonly<Partial<Record<string, GroupKey>>> = {
  lead: "lead",
  tasks: "tasks",
  reviews_and_checks: "reviews",
  messages: "messages",
};

export interface CatalogRow {
  readonly summary: PromptSummary;
  readonly name: string;
  readonly description: string;
}

/** A prompt's plain name and one-line description. */
export function describe(p: Pick<PromptSummary, "id" | "title" | "sentWhen">): { name: string; description: string } {
  const known = ENTRIES[p.id];
  return known ? { name: known.name, description: known.description } : { name: p.title, description: sentence(p.sentWhen) };
}

export function groupOf(summary: PromptSummary): GroupKey {
  return ENTRIES[summary.id]?.group ?? HUB_GROUP[summary.group] ?? "other";
}

/**
 * "per new order" → "Sent per new order.", with the hub's tool names read as words ("every project_stop" → "every
 * project stop"), since this line is for people.
 */
function sentence(sentWhen: string): string {
  const s = sentWhen
    .trim()
    .replace(/\.$/u, "")
    .replace(/`/gu, "")
    .replace(/\b([a-z]+(?:_[a-z]+)+)\b/gu, (w) => w.replaceAll("_", " "));
  return s === "" ? "" : `Sent ${s}.`;
}

export interface CatalogSection {
  readonly group: CatalogGroup & { readonly key: GroupKey };
  readonly rows: ReadonlyArray<CatalogRow>;
}

/** The list as shown: grouped, in table order; empty groups left out. Instructions have their own page. */
export function sections(prompts: ReadonlyArray<PromptSummary>): CatalogSection[] {
  const byGroup = new Map<GroupKey, CatalogRow[]>();
  for (const summary of prompts) {
    if (summary.kind === "instructions") continue;
    const row: CatalogRow = { summary, ...describe(summary) };
    const key = groupOf(summary);
    const rows = byGroup.get(key) ?? [];
    rows.push(row);
    byGroup.set(key, rows);
  }
  const rank = (r: CatalogRow) => ORDER.get(r.summary.id) ?? Number.MAX_SAFE_INTEGER;
  return GROUPS.flatMap((group) => {
    const rows = byGroup.get(group.key);
    if (!rows) return [];
    rows.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
    return [{ group, rows }];
  });
}

/**
 * The page's one list: the prompts edited at `level` (a project's own edits on its page, the hub-wide ones on the
 * hub's) first, in the groups' order, then the rest by group.
 */
export function listed(prompts: ReadonlyArray<PromptSummary>, level: "project" | "global"): { edited: CatalogRow[]; rest: CatalogSection[] } {
  return {
    edited: sections(prompts.filter((p) => p.scope === level)).flatMap((s) => s.rows),
    rest: sections(prompts.filter((p) => p.scope !== level)),
  };
}

/** How many edits `level` holds, for the row that opens the page: its prompts' and those of prompts fleetd no longer sends. */
export function editCount(prompts: ReadonlyArray<PromptSummary>, orphans: ReadonlyArray<RetiredPromptOverride>, level: "project" | "global"): number {
  return prompts.filter((p) => p.kind !== "instructions" && p.scope === level).length + orphans.filter((o) => o.scope === level).length;
}

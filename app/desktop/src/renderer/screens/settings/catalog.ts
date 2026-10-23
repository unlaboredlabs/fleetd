// How the Prompts list presents the hub's editable prompts (10; event lines are a fixed format, not prompts):
// a few groups by what a person is looking for, a plain name, and one line on what it is for. The hub's own title
// and `sentWhen` stay the fallback, so a prompt a newer hub adds still shows up, in "Other", with the hub's words.
import type { PromptSummary } from "./contracts";

export interface CatalogGroup {
  readonly key: string;
  readonly title: string;
  readonly blurb: string;
}

export const GROUPS = [
  { key: "lead", title: "The lead", blurb: "Each project's lead: its role, its rules, and how it runs each kind of work." },
  { key: "tasks", title: "Task agents", blurb: "The first message of the agents that write the code." },
  { key: "reviews", title: "Reviews and checks", blurb: "Reviewers, verifiers and the research judge." },
  { key: "messages", title: "Messages", blurb: "What reaches an agent while it runs." },
  { key: "one-shots", title: "Learning from incidents", blurb: "The question fleetd asks a model, without tools, about what went wrong." },
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
export const ENTRIES: Readonly<Record<string, Entry>> = {
  "lead.start": e("lead", "Lead's role, rules and playbooks", "What the lead does, what it must never do, and how it runs a bug fix, a feature, research or finish-all."),
  "lead.profiles": e("lead", "Task profiles", "When the lead may put a task on medium; added to its first message while medium is allowed."),
  "task.brief.write": e("tasks", "Writer task", "First message of a task that changes code and opens a pull request."),
  "review.reviewer": e("reviews", "Reviewer", "Reviews a pull request each round, by the project's review rules."),
  "review.verifier": e("reviews", "Verifier", "Checks a large pull request actually does what it claims."),
  judge: e("reviews", "Judge", "Decides whether a done-when check of a claim passed."),
  "judge.research": e("reviews", "Research judge", "Decides whether a research claim's check passed."),
  "steer.message": e("messages", "Your steer, mid-run", "Your words (or the lead's) delivered straight to a running agent."),
  retro: e("one-shots", "Retro and triage", "Reviews recent incidents and proposes changes, at most twice a day."),
};

const ORDER: ReadonlyMap<string, number> = new Map(Object.keys(ENTRIES).map((id, ix) => [id, ix]));

/** The hub's groups, for a prompt this table does not know (by the hub's group name, old or new). */
const HUB_GROUP: Readonly<Partial<Record<string, GroupKey>>> = {
  lead: "lead",
  tasks: "tasks",
  reviews_and_checks: "reviews",
  messages: "messages",
  one_shots: "one-shots",
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
 * "per new order" → "Sent per new order.", with the hub's tool names read as words ("every lead_restart" → "every
 * lead restart"), since this line is for people.
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

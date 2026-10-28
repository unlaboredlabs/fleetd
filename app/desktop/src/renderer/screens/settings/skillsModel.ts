// Settings → Projects → Agents' rules, kept pure: where a skill comes from in words, which ones the page can edit, the name a new
// one may have, its first SKILL.md, and the line an installed one shows.
import type { SkillOrigin, SkillSummary } from "../../../shared/contracts";

export const ORIGIN_LABEL: Readonly<Record<SkillOrigin, string>> = {
  repo_agents: "Repo · .agents/skills",
  repo_claude: "Repo · .claude/skills",
  project: "This project",
  global: "Hub-wide",
};

/** Kept by the hub, so edited here; the repo's change in the repo. */
export const editable = (origin: SkillOrigin): origin is "project" | "global" => origin === "project" || origin === "global";

/** The Agent Skills spec's name: lowercase letters, digits and single hyphens, at most 64 characters. */
export const isSkillName = (name: string): boolean => name.length <= 64 && /^[a-z0-9]+(-[a-z0-9]+)*$/u.test(name);

/** What a typed name is turned into: lowercase, spaces and underscores as hyphens. */
export const slug = (typed: string): string =>
  typed
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/gu, "-");

/** Why `name` can't be a new skill's, or null. */
export function nameProblem(name: string, taken: ReadonlyArray<string>): string | null {
  if (name === "") return "Give it a name.";
  if (!isSkillName(name)) return "Lowercase letters, digits and single hyphens only, at most 64 characters.";
  if (taken.includes(name)) return `There is already a skill called ${name} here.`;
  return null;
}

/** A new skill's SKILL.md (the hub's own template). */
export const template = (name: string): string =>
  `---\nname: ${name}\ndescription: What this skill does, and when an agent should use it.\n---\n\n# ${name}\n\nSteps the agent follows, in order.\n`;

/** "Installed from owner/repo, pinned" (the commit shows as an id chip), or null for one written here or in the repo. */
export function installLine(s: Pick<SkillSummary, "install">): string | null {
  if (!s.install) return null;
  const ref = s.install.ref === "HEAD" ? "" : ` (${s.install.ref})`;
  return `Installed from ${s.install.source}${ref}, pinned`;
}

/** "Agents use .agents/skills's instead", for a skill another of the same name outranks. */
export function shadowLine(s: Pick<SkillSummary, "shadowedBy">): string | null {
  return s.shadowedBy ? `Agents use the ${ORIGIN_LABEL[s.shadowedBy]} one of this name instead.` : null;
}

/** One row's key: a name can be in more than one origin. */
export const rowKey = (s: Pick<SkillSummary, "origin" | "name">): string => `${s.origin}/${s.name}`;

/** The skills the page shows for its scope: global alone, or a project's with its repo's and the global ones. */
export function groups(skills: ReadonlyArray<SkillSummary>): Array<{ origin: SkillOrigin; rows: SkillSummary[] }> {
  const order: SkillOrigin[] = ["repo_agents", "repo_claude", "project", "global"];
  return order.map((origin) => ({ origin, rows: skills.filter((s) => s.origin === origin) })).filter((g) => g.rows.length > 0);
}

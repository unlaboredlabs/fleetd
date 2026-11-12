// A skill the hub keeps as the tools show it, without the disk (index.ts keeps the folders): where its install record
// lives, its origin, its summary, and which of two by the same name wins.
import type { SkillInstall, SkillOrigin, SkillScope, SkillSummary, SkillVersion } from "../../shared/contracts.ts";
import { descriptionOf } from "./frontmatter.ts";

/** Where an installed skill's source and pin are kept, in its folder. */
export const INSTALL_FILE = ".fleetd-install.json";
export const originOf = (scope: SkillScope): SkillOrigin => (scope === "project" ? "project" : "global");

/** One skill the hub keeps, read from its folder. */
export type Kept = {
  name: string;
  scope: SkillScope;
  /** SKILL.md. */
  text: string;
  install?: SkillInstall;
  /** The other files, folder-relative, sorted. */
  files: string[];
  updatedAt?: string;
  /** Its newest version. */
  changed?: SkillVersion;
};

export function summary(k: Kept): SkillSummary {
  return {
    name: k.name,
    origin: originOf(k.scope),
    description: descriptionOf(k.text),
    ...(k.install ? { install: k.install } : {}),
    files: k.files,
    ...(k.updatedAt ? { updatedAt: k.updatedAt } : {}),
    ...(k.changed ? { changed: k.changed } : {}),
  } as SkillSummary;
}

export const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export const ORIGINS: SkillOrigin[] = ["repo_agents", "repo_claude", "project", "global"];

/** Marks each skill that another of the same name outranks, and sorts the list by origin, then name. */
export function markShadowed(skills: SkillSummary[]): void {
  skills.sort((a, b) => ORIGINS.indexOf(a.origin) - ORIGINS.indexOf(b.origin) || cmp(a.name, b.name));
  skills.forEach((s, i) => {
    const winner = skills.slice(0, i).find((o) => o.name === s.name)?.origin;
    if (winner === undefined) delete s.shadowedBy;
    else s.shadowedBy = winner;
  });
}

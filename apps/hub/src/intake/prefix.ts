// Explicit prefixes on an intent: a template prefix (`fix:`) skips the router for the template, and a leading
// `@<project>` skips it for the project. Either order works: "@lab fix: …" and "fix: @lab …".
import type { PlaybookName, ProjectRef, ProjectSummary } from "@fleetd/contracts";
import path from "node:path";

const TEMPLATE_PREFIXES: ReadonlyArray<readonly [string, PlaybookName]> = [
  ["bug", "bugfix"],
  ["fix", "bugfix"],
  ["research", "research"],
  ["finish", "finish-all"],
];

export interface ParsedIntent {
  readonly template?: PlaybookName;
  /** The `<project>` of a leading `@<project>`, as typed. */
  readonly project?: string;
  /** The template prefix as written in lowercase, e.g. "fix:", for the echo. */
  readonly prefix?: string;
}

export const parseIntent = (text: string): ParsedIntent => {
  let rest = text.trimStart();
  let template: { readonly name: PlaybookName; readonly prefix: string } | undefined;
  let project: string | undefined;
  for (let i = 0; i < 2; i++) {
    const mention = project === undefined ? /^@([^\s:,]+)[\s:,]*/u.exec(rest) : null;
    if (mention) {
      project = mention[1]!;
      rest = rest.slice(mention[0].length);
      continue;
    }
    const word = template === undefined ? /^([a-z]+)\s*:\s*/iu.exec(rest) : null;
    const hit = word && TEMPLATE_PREFIXES.find(([name]) => name === word[1]!.toLowerCase());
    if (word && hit) {
      template = { name: hit[1], prefix: `${hit[0]}:` };
      rest = rest.slice(word[0].length);
      continue;
    }
    break;
  }
  return { ...(template === undefined ? {} : { template: template.name, prefix: template.prefix }), ...(project === undefined ? {} : { project }) };
};

/** Lowercase words joined by "-": "Repo A (lab)" → "repo-a-lab". */
export const slugOf = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "");

export type ProjectMatch =
  | { readonly kind: "one"; readonly project: ProjectSummary }
  | { readonly kind: "none" }
  | { readonly kind: "many"; readonly projects: ReadonlyArray<ProjectSummary> };

/** `@<name>` against each project's title, the title's slug or the slug of its folder name, ignoring case. */
export const matchProject = (name: string, projects: ReadonlyArray<ProjectSummary>): ProjectMatch => {
  const wanted = name.toLowerCase();
  const slug = slugOf(name);
  const hits = projects.filter((p) => {
    const names = [p.title.toLowerCase(), slugOf(p.title), slugOf(path.basename(p.workspaceRoot))];
    return names.includes(wanted) || (slug !== "" && names.includes(slug));
  });
  if (hits.length === 1) return { kind: "one", project: hits[0]! };
  return hits.length === 0 ? { kind: "none" } : { kind: "many", projects: hits };
};

export const refOf = (p: { readonly machineId: ProjectRef["machineId"]; readonly projectId: ProjectRef["projectId"] }): ProjectRef => ({
  machineId: p.machineId,
  projectId: p.projectId,
});

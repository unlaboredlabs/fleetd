// Settings → Projects → Repos, the parts with no React: what setup and preview apply to a repo, and where its
// checkout is. A hub reads a repo's own setup and preview, or the project's when the repo has none of its own.
import type { PreviewConfig, ProjectRepo, ProjectSettings, ProjectSummary, ToolInput, WorktreeSetup } from "../../../shared/contracts";

/** One setting as it applies to a repo: its own, or the project's; `line` is null when there is none. */
export interface Applied {
  own: boolean;
  line: string | null;
}

/** The setup commands in one line, or null when none run. */
export const setupLine = (setup: WorktreeSetup): string | null => (setup.commands?.length ? setup.commands.join("; ") : null);

/** The preview's start command, or null when none is set. */
export const previewLine = (preview: PreviewConfig | undefined): string | null => preview?.web?.start ?? null;

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/**
 * The setup and preview `repo` (the hub's answer for it, undefined while there is none: a hub before per-repo
 * settings refuses the read) runs with. One the same as the project's reads as the project's.
 */
export function applied(project: ProjectSettings, repo: ProjectSettings | undefined): { setup: Applied; preview: Applied } {
  const setupOwn = repo !== undefined && !same(repo.setup, project.setup);
  const previewOwn = repo !== undefined && !same(repo.preview, project.preview);
  return {
    setup: { own: setupOwn, line: setupLine(setupOwn ? repo.setup : project.setup) },
    preview: { own: previewOwn, line: previewLine(previewOwn ? repo.preview : project.preview) },
  };
}

/**
 * The directory holding the repo's files: as the hub serves it, else its checkout project's folder, else the checkout's
 * id (an older hub, before the node reported it).
 */
export const checkoutPath = (repo: ProjectRepo, projects: ReadonlyArray<ProjectSummary>): string =>
  repo.path ??
  projects.find((p) => p.machineId === repo.checkout.machineId && p.projectId === repo.checkout.projectId)?.workspaceRoot ??
  repo.checkout.projectId;

/** Whether the repo is the project's own directory, which can't be removed from it. */
export const isOwn = (repo: ProjectRepo, project: { machineId: string; projectId: string }): boolean =>
  repo.checkout.machineId === project.machineId && repo.checkout.projectId === project.projectId;

const NAME = /^[a-z0-9-]{1,32}$/;

/**
 * Why `source` can't be added as it is: a path relative to a home or working directory, which only the CLI on that
 * machine can expand; null when it can.
 */
export function sourceProblem(source: string): string | null {
  const text = source.trim();
  return text === "~" || text.startsWith("~/") || text === "." || text.startsWith("./") || text.startsWith("../")
    ? "Give the checkout's full path on the machine, such as /home/me/src/api."
    : null;
}

/**
 * What Add repo sends for `source`: a path (`/…`) on the project's machine, else a GitHub repo to clone there; null
 * while there is nothing to add, a relative path (`sourceProblem`), or a name that isn't a repo name.
 */
export function addInput(project: { machineId: string; projectId: string }, source: string, name: string): ToolInput<"project_repo_add"> | null {
  const text = source.trim();
  const n = name.trim();
  if (text === "" || sourceProblem(text) !== null || (n !== "" && !NAME.test(n))) return null;
  const at = { machineId: project.machineId, projectId: project.projectId, ...(n ? { name: n } : {}) };
  return text.startsWith("/") ? { ...at, path: text } : { ...at, url: text };
}

// Settings → Projects → Repos, the parts with no React: where a repo's checkout is, and what Add repo sends.
import type { ProjectRepo, ProjectSummary, ToolInput } from "../../../shared/contracts";

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

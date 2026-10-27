// Settings → Projects → Repos, the parts with no React: what setup and preview apply to a repo, and where its
// checkout is. A hub reads a repo's own setup and preview, or the project's when the repo has none of its own.
import type { PreviewConfig, ProjectRepo, ProjectSettings, ProjectSummary, WorktreeSetup } from "../../../shared/contracts";

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

/** The directory holding the repo's files: its checkout project's folder, or the checkout's id when it isn't listed. */
export const checkoutPath = (repo: ProjectRepo, projects: ReadonlyArray<ProjectSummary>): string =>
  projects.find((p) => p.machineId === repo.checkout.machineId && p.projectId === repo.checkout.projectId)?.workspaceRoot ?? repo.checkout.projectId;

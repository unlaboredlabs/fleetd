// What adding a project decides and says without the hub (add.ts, discover.ts and repos.ts do the adding): its folder's
// name, whether a node's refusal names the folder, when a clone's progress is shown, a problem as a tool's error, and
// why an archived project refuses.
import type { CloneProgressData, ProjectProblem, ProjectRef, ProjectRepo } from "../../shared/contracts.ts";
import { ToolError } from "../../shared/errors.ts";

export const problem = (code: ProjectProblem["code"], message: string, fix: string): ProjectProblem => ({ code, message, fix });

export function problemError(p: ProjectProblem): ToolError {
  const code =
    p.code === "machine_offline"
      ? "machine_offline"
      : p.code === "gh_no_access" || p.code === "path_missing"
        ? "not_found"
        : p.code === "no_worker" || p.code === "not_a_git_repo" || p.code === "dest_exists"
          ? "invalid"
          : "failed";
  return new ToolError(code, p.message, p.fix ?? "");
}

/** Whether the node's message names the folder at `path`: as given, or `~/x` as the node expands it (`/home/me/x`). */
export function namesFolder(message: string, path: string): boolean {
  return message.includes(path) || (path.startsWith("~/") && message.includes(path.slice(1)));
}

/** `slug_or` (project_lead/mod.rs): a folder name from a title, at most 40 bytes, `fallback` when nothing is left. */
export function slugOr(name: string, fallback: string): string {
  let out = "";
  for (const c of name.trim().toLowerCase()) {
    if (/^[a-z0-9]$/.test(c)) out += c;
    else if (out !== "" && !out.endsWith("-")) out += "-";
    if (out.length >= 40) break;
  }
  out = out.replace(/-+$/, "");
  return out === "" ? fallback : out;
}

export type Last = { atMs: number; phase: CloneProgressData["phase"]; percent: number };

/** Progress events: on each phase change and its 100 %, else every 5 percent at most once a second. */
export function progressDue(last: Last | undefined, phase: CloneProgressData["phase"], percent: number, nowMs: number): boolean {
  if (!last) return true;
  return (
    last.phase !== phase ||
    (percent === 100 && last.percent !== 100) ||
    (percent >= Math.min(last.percent + 5, 255) && nowMs - last.atMs >= 1000)
  );
}

/** Why an archived project refuses, and the fix (repos/mod.rs `archived_note`). */
export function archivedNote(holding: ProjectRef, repo: ProjectRepo): [string, string] {
  return [
    `This project is archived: its directory is repo ${repo.name} of project ${holding.projectId} on ${holding.machineId}.`,
    "Write to that project's lead instead; project_repo_remove takes the repo out of it and brings this project back.",
  ];
}

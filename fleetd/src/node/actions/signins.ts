// A project's kept browser sign-ins (sessions/mod.rs
// `forget_signins`, D221, D310): the profile its lead's browser sessions keep, under `<node home>/browser/kept/<id>`
// (or where it was before, until the node's start moves it: own_homes.ts), deleted when the person forgets them or the
// project goes. With a
// browser broker on this node, forgetting goes through it (browser/index.ts `forgetSignins`: the browser on the
// profile ends first); without one it is deleting that folder. None to forget is fine.
import { existsSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { unmovedProfile } from "../own_homes.ts";

/** The folder a project's kept profile lives in; none for an id a path can't hold. */
export function keptDir(home: string, projectId: string): string | undefined {
  const plain = !!projectId && projectId.length <= 128 && !projectId.startsWith(".") && /^[A-Za-z0-9._-]+$/.test(projectId);
  if (!plain) return undefined;
  return unmovedProfile(home, projectId) ?? join(home, "browser", "kept", projectId);
}

/** Whether a project keeps sign-ins on this machine (`project_worktrees`' `signinsKept`). */
export function signinsKept(home: string, projectId: string): boolean {
  const dir = keptDir(home, projectId);
  return !!dir && existsSync(dir) && statSync(dir).isDirectory();
}

/** Forgets a project's kept sign-ins; throws why they stay. */
export function forgetSignins(home: string, projectId: string): void {
  const dir = keptDir(home, projectId);
  if (!dir) return;
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch (error) {
    throw new Error(`project ${projectId}'s browser sign-ins were not forgotten: cannot delete ${dir}: ${(error as Error).message}`);
  }
}

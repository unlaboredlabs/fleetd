// The executor's project calls on a node (crates/fleetd/src/hub/executor/mod.rs `project_upsert`, `project_folder`,
// `project_remove`, `project_env`, `project_env_copy`, `order_env_drop`, `project_worktrees`).
import type { EnvVarName, EnvVarSet, MachineId, ProjectId, ProjectWorktrees, SecretFingerprint, WorkstreamId } from "../../shared/contracts.ts";
import type { EnvSecretSaved } from "../../shared/sessions.ts";
import type { Hub } from "../api/hub.ts";
import { ExecutorError, executors, READ_TIMEOUT_MS, REMOVE_TIMEOUT_MS, STOP_TIMEOUT_MS } from "./index.ts";

/** Forgetting a Navi's sign-ins: the node waits up to 20 s for the browser on its profile to close. */
export const SIGNINS_TIMEOUT_MS = 30_000;

function nonEmpty(machineId: MachineId, what: string, value: string): string {
  if (value === "") throw ExecutorError.failed(machineId, "project", `the ${what} is empty`);
  return value;
}

export async function projectUpsert(hub: Hub, m: MachineId, projectId: ProjectId, title: string, workspaceRoot: string): Promise<void> {
  await executors(hub).call(
    m,
    "project",
    { op: "project_upsert", projectId, title: nonEmpty(m, "title", title), workspaceRoot: nonEmpty(m, "path", workspaceRoot) },
    READ_TIMEOUT_MS,
  );
}

/** Registers a project in `folder`, a path under the node's home that the node makes when missing: a Navi's. */
export async function projectFolder(hub: Hub, m: MachineId, projectId: ProjectId, title: string, folder: string): Promise<string> {
  const out = await executors(hub).call(
    m,
    "project",
    { op: "project_upsert", projectId, title: nonEmpty(m, "title", title), workspaceRoot: nonEmpty(m, "folder", folder) },
    READ_TIMEOUT_MS,
  );
  if (out.kind !== "folder") throw ExecutorError.failed(m, "project", "the node did not say where the folder is");
  return out.path;
}

export async function projectRemove(
  hub: Hub,
  m: MachineId,
  projectId: ProjectId,
  removeWorktrees: boolean,
  erase: boolean,
  removeFolder: boolean,
): Promise<void> {
  await executors(hub).call(
    m,
    "project",
    {
      op: "project_remove",
      projectId,
      ...(removeWorktrees ? { removeWorktrees } : {}),
      ...(erase ? { erase } : {}),
      ...(removeFolder ? { removeFolder } : {}),
    },
    REMOVE_TIMEOUT_MS,
  );
}

export async function naviSigninsForget(hub: Hub, m: MachineId, projectId: ProjectId): Promise<void> {
  await executors(hub).call(m, "project", { op: "navi_signins_forget", projectId }, SIGNINS_TIMEOUT_MS);
}

/** Sets and removes the project's variables on its node; the fingerprint of each secret it saved. */
export async function projectEnv(hub: Hub, m: MachineId, projectId: ProjectId, set: EnvVarSet[], remove: EnvVarName[]): Promise<EnvSecretSaved[]> {
  const out = await executors(hub).call(m, "project", { op: "project_env", projectId, set, remove }, READ_TIMEOUT_MS);
  if (out.kind !== "project_env") throw ExecutorError.failed(m, "project", "the node sent no answer to project_env");
  return out.secrets;
}

export async function projectEnvCopy(hub: Hub, m: MachineId, from: ProjectId, to: ProjectId): Promise<void> {
  await executors(hub).call(m, "project", { op: "project_env_copy", from, to }, READ_TIMEOUT_MS);
}

export async function orderEnvDrop(
  hub: Hub,
  m: MachineId,
  projectId: ProjectId,
  orderId: WorkstreamId,
  name?: [EnvVarName, SecretFingerprint],
): Promise<void> {
  await executors(hub).call(
    m,
    "project",
    { op: "order_env_drop", projectId, orderId, ...(name ? { name: name[0], fingerprint: name[1] } : {}) },
    READ_TIMEOUT_MS,
  );
}

/** Where the project's worktrees live on its node and which are there. */
export async function projectWorktrees(hub: Hub, m: MachineId, projectId: ProjectId): Promise<ProjectWorktrees> {
  const out = await executors(hub).call(m, "read", { op: "project_worktrees", projectId }, READ_TIMEOUT_MS);
  if (out.kind !== "project_worktrees") throw ExecutorError.failed(m, "read", "the node sent no worktrees");
  const { kind: _kind, ...worktrees } = out;
  return worktrees as ProjectWorktrees;
}

/** A person's Stop: interrupts whatever run the thread has now. */
export async function interruptNow(hub: Hub, r: { machineId: MachineId; threadId: string }): Promise<void> {
  await executors(hub).call(r.machineId, "interrupt", { op: "interrupt", sessionId: r.threadId, reason: "stopped by the person" }, READ_TIMEOUT_MS);
}

/** Ends the thread's claude process; `removeWorktree` then deletes its worktree. */
export async function stop(hub: Hub, r: { machineId: MachineId; threadId: string }, removeWorktree: boolean): Promise<void> {
  await executors(hub).call(r.machineId, "stop", { op: "stop", sessionId: r.threadId, removeWorktree }, STOP_TIMEOUT_MS);
}

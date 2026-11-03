// The hub calls behind a chat's Artifacts, as the desktop makes them: the list (artifacts_list) and one artifact at its
// newest version or another (artifact_get), each read again on artifacts.changed.
import type { HubEvent, ProjectRef } from "../../desktop";
import type { Hub, Result } from "../manage/api";
import type { ArtifactRead, ArtifactSummary } from "./model";

const ref = (p: ProjectRef): ProjectRef => ({ machineId: p.machineId, projectId: p.projectId });

export const listArtifacts = async (hub: Hub, p: ProjectRef): Promise<Result<readonly ArtifactSummary[]>> => {
  const r = await hub.call("artifacts_list", { projectRef: ref(p) });
  return r.ok ? { ok: true, value: r.output.artifacts } : r;
};

export const readArtifact = async (hub: Hub, p: ProjectRef, name: string, version?: number): Promise<Result<ArtifactRead>> => {
  const r = await hub.call("artifact_get", { projectRef: ref(p), name, ...(version === undefined ? {} : { version }) });
  return r.ok ? { ok: true, value: { name: r.output.name, artifact: r.output.artifact, content: r.output.content, versions: r.output.versions } } : r;
};

/** An artifacts.changed for this chat. */
export const touchesArtifacts = (event: HubEvent, p: ProjectRef): boolean => {
  if (event.type !== "artifacts.changed") return false;
  const data = event.data as { projectRef?: ProjectRef } | undefined;
  return data?.projectRef === undefined || (data.projectRef.machineId === p.machineId && data.projectRef.projectId === p.projectId);
};

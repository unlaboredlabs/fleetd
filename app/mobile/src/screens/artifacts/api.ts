// The hub calls behind a chat's Artifacts, as the desktop makes them: the list with the chat's files (artifacts_list)
// and one artifact at its newest version or another (artifact_get), each read again on artifacts.changed.
import type { HubEvent, ProjectRef } from "../../desktop";
import type { Hub, Result } from "../manage/api";
import type { ArtifactRead, ArtifactSummary, ChatFile } from "./model";

const ref = (p: ProjectRef): ProjectRef => ({ machineId: p.machineId, projectId: p.projectId });

/** The chat's artifacts and the files sent in it, each newest first. */
export interface ArtifactsList {
  readonly artifacts: readonly ArtifactSummary[];
  readonly files: readonly ChatFile[];
}

export const listArtifacts = async (hub: Hub, p: ProjectRef): Promise<Result<ArtifactsList>> => {
  const r = await hub.call("artifacts_list", { projectRef: ref(p) });
  return r.ok ? { ok: true, value: { artifacts: r.output.artifacts, files: r.output.files } } : r;
};

export const readArtifact = async (hub: Hub, p: ProjectRef, name: string, version?: number): Promise<Result<ArtifactRead>> => {
  const r = await hub.call("artifact_get", { projectRef: ref(p), name, ...(version === undefined ? {} : { version }) });
  return r.ok ? { ok: true, value: { name: r.output.name, artifact: r.output.artifact, content: r.output.content, versions: r.output.versions } } : r;
};

/** An artifacts.changed for this chat, or a message in it, which may carry a file. */
export const touchesArtifacts = (event: HubEvent, p: ProjectRef): boolean => {
  if (event.type === "chat.message") return event.machineId === p.machineId && event.projectId === p.projectId;
  if (event.type !== "artifacts.changed") return false;
  const data = event.data as { projectRef?: ProjectRef } | undefined;
  return data?.projectRef === undefined || (data.projectRef.machineId === p.machineId && data.projectRef.projectId === p.projectId);
};

// A chat's key, "machineId/projectId": the store's, the notifications' and the routes' one name for a project. Pure, so
// the package exports the push reader that uses it (pushPayload.ts).
import type { ProjectRef } from "../../desktop/src/shared/contracts/contracts";

/** "machineId/projectId". */
export type Key = string;

export const keyOf = (ref: ProjectRef): Key => `${ref.machineId}/${ref.projectId}`;

export const refOf = (key: Key): ProjectRef => {
  const at = key.indexOf("/");
  return { machineId: key.slice(0, at), projectId: key.slice(at + 1) };
};

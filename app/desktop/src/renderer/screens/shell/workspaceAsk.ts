// Where New workspace is asked (NewWorkspace.tsx), apart from its dialog, so the sidebar loads that only once it is
// needed: it is never in the first chat's load.
import type { HubView } from "../../src/data/hubs";

/** As the cloud takes a name: 60 at most. */
export const WORKSPACE_NAME_MAX = 60;

/** The workspace New workspace is asked on: the one on show when it is a cloud one of the account's, else the first. */
export const askedOn = (hubs: ReadonlyArray<Pick<HubView, "id" | "cloud" | "codePaired">>, shown: string): string | null => {
  const ours = hubs.filter((h) => h.cloud === true && h.codePaired !== true);
  return (ours.find((h) => h.id === shown) ?? ours[0])?.id ?? null;
};

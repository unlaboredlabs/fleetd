// The composer's two reads from the data layer. Bound to E1's chat API (A7) once fix/desktop-chat-data lands:
// layer.chat for the actions, selectLeadWorking for the wording.

import { useData, useDataLayer } from "../../src/data/react";
import { leadLaneId } from "../../src/data/selectors";
import type { ChatActions } from "./chatApi";

export function useChatActions(): ChatActions {
  const layer = useDataLayer() as ReturnType<typeof useDataLayer> & { readonly chat?: ChatActions };
  // E1's layer has chat actions now, but its stub contract still types attachments as objects where H1's (and this
  // composer's) are ids; E1 is moving to H1's contract, and then this binds to layer.chat directly.
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  if (layer.chat === undefined) throw new Error("the data layer has no chat actions yet (A7)");
  return layer.chat;
}

/** Undefined while the feed hasn't said. */
export function useLeadWorking(projectKey: string): boolean | undefined {
  const [machineId = "", projectId = ""] = projectKey.split("/");
  return useData((s) => {
    const lane = s.live.lanes[leadLaneId({ machineId, projectId })];
    return lane === undefined ? undefined : lane.status === "working" || lane.status === "starting";
  });
}

// The board screen (routes #/, #/board and #/board/<machineId>/<projectId>): F1's screens.tsx mounts this.
import { useRef, useSyncExternalStore } from "react";
import { toast } from "../../ui";
import { BoardView } from "./BoardView";
import type { ComposerHandle } from "./Composer";
import { type ProjectKey, projectKey } from "./live";
import { useBoardSource } from "./source";

const subscribeHash = (on: () => void) => {
  window.addEventListener("hashchange", on);
  return () => window.removeEventListener("hashchange", on);
};

/** The project a "#/board/<machineId>/<projectId>" route filters to. */
export const routeProject = (hash: string): ProjectKey | undefined => {
  const m = /^#\/board\/([^/?]+)\/([^/?]+)/u.exec(hash);
  return m?.[1] !== undefined && m[2] !== undefined
    ? projectKey({ machineId: decodeURIComponent(m[1]), projectId: decodeURIComponent(m[2]) })
    : undefined;
};

const go = (hash: string) => {
  window.location.hash = hash;
};

export function BoardScreen() {
  const filter = routeProject(useSyncExternalStore(subscribeHash, () => window.location.hash));
  const composer = useRef<ComposerHandle>(null);
  const source = useBoardSource(() => go("#/projects/add"));
  return (
    <BoardView
      model={source.model}
      composer={source.composer}
      composerHandle={composer}
      filter={filter}
      lastUsed={source.lastUsed}
      offline={source.offline}
      onStage={source.watch}
      actions={{
        ...source.actions,
        openOrder: (id) => go(`#/order/${encodeURIComponent(id)}`),
        addProject: () => go("#/projects/add"),
        openAsk: (askId) => go(`#/board?inbox&ask=${encodeURIComponent(askId)}`),
        openPr: (url) => {
          void window.fleetd.openExternal(url).then((o) => {
            if (!o.ok) toast({ title: "Couldn't open the PR", description: o.message, tone: "danger" });
          });
        },
      }}
    />
  );
}

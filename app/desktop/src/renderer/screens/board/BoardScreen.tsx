// The board screen (#/ and #/board/<machineId>/<projectId>): F1's screen host mounts it.
import { useRef } from "react";
import { toast } from "../../ui";
import { BoardView } from "./BoardView";
import { useBoardCommands } from "./commands";
import type { ComposerHandle } from "./Composer";
import { projectKey } from "./live";
import { useBoardSource } from "./source";

const go = (hash: string) => {
  window.location.hash = hash;
};

/** `project`: the route's project (#/board/<machineId>/<projectId>), which the board is filtered to. */
export function BoardScreen({ project }: { project: { readonly machineId: string; readonly projectId: string } | null }) {
  const filter = project === null ? undefined : projectKey(project);
  const composer = useRef<ComposerHandle>(null);
  const source = useBoardSource(() => go("#/projects/add"));
  useBoardCommands(composer);
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

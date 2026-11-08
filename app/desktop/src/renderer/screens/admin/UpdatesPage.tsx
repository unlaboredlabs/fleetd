// Hub › Updates: where the hub and its machines stand, or how an update goes, with its one Update button; one line per
// part with Retry on one that didn't come through; Update automatically with what it last did and does next; and
// which fleetd the hub and each machine run. The hub row's popover says the same in short.
import { useEffect } from "react";
import { Text } from "../../ui";
import { PageHead, PagePart } from "../settings/parts";
import { AutoUpdates } from "../updates/AutoUpdates";
import { loadRun, retryMachine, startOver, startUpdate, updateNow } from "../updates/flow";
import { useFlowDeps, useUpdatesView } from "../updates/hooks";
import { hubStanding, type AppAction, type Retry } from "../updates/model";
import { runApp } from "../updates/UpdatesHost";
import { HubSection, Line, UpdatesSheet } from "../updates/UpdatesSheet";
import s from "../settings/settings.module.css";
import u from "../updates/updates.module.css";

export function UpdatesPage() {
  const view = useUpdatesView();
  const deps = useFlowDeps();
  const standing = hubStanding(view);
  // Fresh as the page opens: what automatic updates did and do next, not as the last few-minute poll had it.
  useEffect(() => void loadRun(deps), [deps]);
  const retry = (r: Retry) => {
    if (r.kind === "machine") void retryMachine(deps, r.machineId);
    else if (r.kind === "update") void startUpdate(deps);
    else runApp(r.run);
  };
  return (
    <div className={s.scroll} data-screen="settings.hub.updates">
      <div className={s.column}>
        <PageHead title="Updates">Which fleetd the hub and its machines run, and how they move to a newer one.</PageHead>
        {view.hub === null || standing === null ? (
          <Text size="sm" tone="quiet">
            Connect to the hub to see its version and its machines&apos;.
          </Text>
        ) : (
          <>
            {view.update !== null || view.progress !== null ? null : (
              <div className={u.head} data-updates-standing>
                <Text strong tone={standing.tone === "quiet" ? "default" : standing.tone}>
                  <Line text={standing.text} />
                </Text>
              </div>
            )}
            <UpdatesSheet
              view={view}
              onUpdate={() => void startUpdate(deps)}
              onStartOver={() => void startOver(deps)}
              onUpdateNow={() => void updateNow(deps)}
              onRetry={retry}
              onApp={(a: AppAction) => runApp(a)}
              auto={<AutoUpdates />}
              versions={
                <PagePart title="Versions" reveal="hub.updates.versions" intro="Updates go to the hub, then every machine, then this app.">
                  <HubSection part={view.hub} nodes={view.nodes} />
                </PagePart>
              }
            />
          </>
        )}
      </div>
    </div>
  );
}

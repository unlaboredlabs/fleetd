// Hub › Updates: where the hub and its machines stand, with Update now; Update automatically with what it last did and
// does next; and which fleetd the hub and each machine run. The same switch and status are in the updates sheet.
import { useEffect } from "react";
import { Button, Text } from "../../ui";
import { useDataLayer } from "../../src/data/react";
import { PageHead, PagePart } from "../settings/parts";
import { AutoUpdates } from "../updates/AutoUpdates";
import { loadRun, startUpdate } from "../updates/flow";
import { useFlowDeps, useUpdatesView } from "../updates/hooks";
import { hubStanding } from "../updates/model";
import { setUpdatesOpen } from "../updates/state";
import { HubSection, Line } from "../updates/UpdatesSheet";
import s from "../settings/settings.module.css";
import u from "../updates/updates.module.css";

export function UpdatesPage() {
  const view = useUpdatesView();
  const deps = useFlowDeps();
  const { hub } = useDataLayer();
  const standing = hubStanding(view);
  // Fresh as the page opens: what automatic updates did and do next, not as the last few-minute poll had it.
  useEffect(() => void loadRun(deps), [deps]);
  const now = () => {
    setUpdatesOpen(true, hub);
    void startUpdate(deps);
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
            <div className={u.head} data-updates-standing>
              <div className={u.words}>
                <Text strong tone={standing.tone === "quiet" ? "default" : standing.tone}>
                  <Line text={view.update?.title ?? standing.text} />
                </Text>
                {view.update === null ? null : (
                  <Text size="sm" tone="quiet">
                    {view.update.note}
                  </Text>
                )}
              </div>
              <div className={u.actions}>
                {view.update !== null ? (
                  <Button variant="primary" onClick={now} data-updates-start>
                    Update now
                  </Button>
                ) : (
                  <Button variant="secondary" onClick={() => setUpdatesOpen(true, hub)}>
                    {view.going ? "Show the update…" : "Open updates…"}
                  </Button>
                )}
              </div>
            </div>
            <AutoUpdates />
            <PagePart title="Versions" reveal="hub.updates.versions" intro="Updates go to the hub, then every machine, then this app.">
              <HubSection part={view.hub} nodes={view.nodes} />
            </PagePart>
          </>
        )}
      </div>
    </div>
  );
}

// Hub › Updates: the one status of updates (which fleetd everything runs, a newer one with its Update button, how an
// update goes, a machine that didn't update and why), and the Update automatically switch. Nothing else to read.
import { useEffect } from "react";
import { PageHead, SettingsSection } from "../settings/parts";
import { AutoUpdates } from "../updates/AutoUpdates";
import { loadRun } from "../updates/flow";
import { useFlowDeps, useUpdateStatus } from "../updates/hooks";
import { UpdateStatus } from "../updates/UpdateStatus";
import s from "../settings/settings.module.css";

export function UpdatesPage() {
  const status = useUpdateStatus();
  const deps = useFlowDeps();
  // Fresh as the page opens: not as the last few-minute poll had it.
  useEffect(() => void loadRun(deps), [deps]);
  return (
    <div className={s.scroll} data-screen="settings.hub.updates">
      <div className={s.column}>
        <PageHead title="Updates" />
        <SettingsSection data={{ "data-screen": "updates" }}>
          <UpdateStatus status={status} />
        </SettingsSection>
        <AutoUpdates />
      </div>
    </div>
  );
}

// Hub › Machines' Updates (a page of its own once: a link to Hub › Machines › Updates lands here): the one status of updates
// (which fleetd everything runs, a newer one with its Update button, how an update goes, a machine that didn't update
// and why), and the Update automatically switch. Nothing else to read.
import { useEffect } from "react";
import { Part } from "../settings/Frames";
import { GroupNote, SettingsSection } from "../settings/parts";
import { CLOUD_UPDATES } from "../updates/model";
import { useServes } from "./role";
import { AutoUpdates } from "../updates/AutoUpdates";
import { loadRun } from "../updates/flow";
import { useFlowDeps, useUpdateStatus } from "../updates/hooks";
import { UpdateStatus } from "../updates/UpdateStatus";

export function Updates() {
  const status = useUpdateStatus();
  const deps = useFlowDeps();
  const updates = useServes("hub_update_status");
  // Fresh as the page opens: not as the last few-minute poll had it.
  useEffect(() => {
    if (updates) void loadRun(deps);
  }, [deps, updates]);
  // fleetd cloud: no Update and no switch, one line where they would be.
  if (!updates) {
    return (
      <Part reveal="hub.updates" screen="settings.hub.updates">
        <SettingsSection title="Updates" data={{ "data-screen": "updates", "data-updates": "cloud" }}>
          <GroupNote>{CLOUD_UPDATES}</GroupNote>
        </SettingsSection>
      </Part>
    );
  }
  return (
    <Part reveal="hub.updates" screen="settings.hub.updates">
      <SettingsSection title="Updates" data={{ "data-screen": "updates" }}>
        <UpdateStatus status={status} />
      </SettingsSection>
      <AutoUpdates />
    </Part>
  );
}

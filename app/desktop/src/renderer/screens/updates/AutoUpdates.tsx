// Update automatically, on Hub › Updates: one switch the hub's owners and admins turn, which says nothing more unless
// automatic updates hold back, and then why in the hub's words.
import { useState } from "react";
import { toast } from "../../ui";
import { useDataLayer } from "../../src/data/react";
import { shortLabels } from "../../../shared/updates";
import { useSettledAdministers } from "../admin/role";
import { setAuto, useAuto } from "./flow";
import { SettingsSection, SwitchRow } from "../settings/parts";
import { Line } from "./UpdateStatus";

export function AutoUpdates() {
  const layer = useDataLayer();
  const auto = useAuto(layer.hub);
  const administers = useSettledAdministers();
  const [saving, setSaving] = useState(false);
  // Not known to administer the hub (never a member's flash of the switch), or an older hub: nothing to switch.
  if (!administers || auto === null) return null;
  const turn = async (on: boolean) => {
    setSaving(true);
    const refused = await setAuto(layer, on);
    setSaving(false);
    if (refused !== null) toast({ title: "Automatic updates didn't change", description: refused, tone: "danger" });
  };
  return (
    <SettingsSection data={{ "data-auto-updates": auto.on ? "on" : "off" }}>
      <SwitchRow
        title="Update automatically"
        line={auto.on && auto.held !== null ? <Line text={shortLabels(auto.held)} /> : undefined}
        checked={auto.on}
        disabled={saving}
        onCheckedChange={(on) => void turn(on)}
      />
    </SettingsSection>
  );
}

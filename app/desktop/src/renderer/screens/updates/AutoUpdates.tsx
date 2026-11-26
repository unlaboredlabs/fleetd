// Update automatically and Update speed, on Hub › Machines › Updates: a switch and a choice the hub's owners and admins
// turn. The switch says nothing more unless automatic updates hold back, and then why in the hub's words.
import { useState } from "react";
import type { UpdateSpeed } from "../../../shared/contracts";
import { Segmented, toast } from "../../ui";
import { useDataLayer } from "../../src/data/react";
import { shortLabels } from "../../../shared/updates";
import { useSettledAdministers } from "../admin/role";
import { setAuto, setSpeed, useAuto } from "./flow";
import { HintLines, SettingsRow, SettingsSection, SwitchRow } from "../settings/parts";
import { Line } from "./UpdateStatus";

const SPEEDS: readonly { readonly value: UpdateSpeed; readonly label: string }[] = [
  { value: "fast", label: "Fast" },
  { value: "steady", label: "Steady" },
];

const SPEED_HINT = [
  "Which builds of fleetd this workspace takes. Every build runs on fleetd's own workspace and cloud first, then reaches workspaces in stages.",
  ["Fast", "each build within hours of passing those checks (the default)"],
  ["Steady", "only builds that have been out 2 days with no problems"],
] as const;

/** `inGroup`: its rows, for a group that holds them (Hub › Machines' Updates); else a section of its own. */
export function AutoUpdates({ inGroup = false }: { inGroup?: boolean }) {
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
  const pace = async (speed: UpdateSpeed) => {
    if (speed === auto.speed) return;
    setSaving(true);
    const refused = await setSpeed(layer, speed);
    setSaving(false);
    if (refused !== null) toast({ title: "Update speed didn't change", description: refused, tone: "danger" });
  };
  const rows = (
    <>
      <SwitchRow
        title="Update automatically"
        {...(inGroup ? { mark: "none" as const } : {})}
        line={auto.on && auto.held !== null ? <Line text={shortLabels(auto.held)} /> : undefined}
        checked={auto.on}
        disabled={saving}
        onCheckedChange={(on) => void turn(on)}
        {...(inGroup ? { data: { "data-auto-updates": auto.on ? "on" : "off" } } : {})}
      />
      {/* A hub from before update speeds has none to choose. */}
      {auto.speed === undefined ? null : (
        <SettingsRow
          reveal="hub.update_speed"
          {...(inGroup ? { mark: "none" as const } : {})}
          title="Update speed"
          hint={<HintLines lines={SPEED_HINT} />}
          data={{ "data-update-speed": auto.speed }}
          control={<Segmented label="Update speed" options={SPEEDS} value={auto.speed} disabled={saving} onChange={(s) => void pace(s)} />}
        />
      )}
    </>
  );
  return inGroup ? rows : <SettingsSection data={{ "data-auto-updates": auto.on ? "on" : "off" }}>{rows}</SettingsSection>;
}

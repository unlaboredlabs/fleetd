// Update automatically, its switch and its status lines, on Hub › Updates: the hub's
// owners and admins turn it on or off; a member, whom the hub doesn't tell, is told whom to ask.
import { useState } from "react";
import { Text, toast } from "../../ui";
import { useDataLayer, useToolQuery } from "../../src/data/react";
import { useHubRole } from "../admin/role";
import { useNow } from "../live/clock";
import { adminNames, adminWho } from "../sessions/pickScreen";
import { autoStatus, autoWords } from "./auto";
import { setAutoUpdates, useAutoUpdates, useReady } from "./flow";
import { SettingsRow, SettingsSection, SwitchRow } from "../settings/parts";
import { Line } from "./UpdatesSheet";
import s from "./updates.module.css";

const noInput = {};

export function AutoUpdates() {
  const layer = useDataLayer();
  const auto = useAutoUpdates(layer.hub);
  const ready = useReady(layer.hub);
  const role = useHubRole();
  const member = !role.pending && !role.offline && !role.administers;
  const people = useToolQuery("people_list", noInput, { enabled: member });
  const [saving, setSaving] = useState(false);
  // By the minute: "today at …" turns into "yesterday at …" as the day does.
  const now = useNow(true, 60_000);
  if (member) {
    return (
      <Text size="sm" tone="quiet" data-auto-updates="member">
        {`The hub's owners and admins update the hub and its machines, and turn Update automatically on or off: ask ${adminWho(adminNames(people.data?.people ?? []))}.`}
      </Text>
    );
  }
  // Not known yet to administer the hub (never a member's flash of the switch), or an older hub: nothing to switch.
  if (!role.administers || auto === null) return null;
  const turn = async (on: boolean) => {
    setSaving(true);
    const refused = await setAutoUpdates(layer, on);
    setSaving(false);
    if (refused !== null) toast({ title: "Automatic updates didn't change", description: refused, tone: "danger" });
  };
  return (
    <SettingsSection data={{ "data-auto-updates": auto.settings.auto ? "on" : "off" }}>
      <SwitchRow title="Update automatically" line={autoWords(auto.settings.drainMinutes)} checked={auto.settings.auto} disabled={saving} onCheckedChange={(on) => void turn(on)} />
      {autoStatus(auto, ready, now).map((line) => {
        const says = (
          <span className={s.tabular}>
            {line.state === null ? null : (
              <Text size="sm" tone={line.state.tone}>
                {`${line.state.text} `}
              </Text>
            )}
            <Line text={line.text} />
          </span>
        );
        return line.label === null ? (
          <SettingsRow key={line.key} title={says} label={line.text} data={{ "data-auto-status": line.key }} />
        ) : (
          <SettingsRow key={line.key} title={<Text tone={line.labelTone}>{line.label}</Text>} label={line.label} line={says} data={{ "data-auto-status": line.key }} />
        );
      })}
    </SettingsSection>
  );
}

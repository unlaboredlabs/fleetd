// Update automatically, its switch and its status lines, on Hub › Updates: the hub's
// owners and admins turn it on or off; a member, whom the hub doesn't tell, is told whom to ask.
import { useState } from "react";
import { Switch, Text, toast } from "../../ui";
import { useDataLayer, useToolQuery } from "../../src/data/react";
import { useHubRole } from "../admin/role";
import { useNow } from "../live/clock";
import { adminNames, adminWho } from "../sessions/pickScreen";
import { autoStatus, autoWords } from "./auto";
import { setAutoUpdates, useAutoUpdates, useReady } from "./flow";
import { Line } from "./UpdatesSheet";
import s from "./updates.module.css";

const noInput = {};

export function AutoUpdates() {
  const auto = useAutoUpdates();
  const ready = useReady();
  const layer = useDataLayer();
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
    <div className={s.auto} data-auto-updates={auto.settings.auto ? "on" : "off"}>
      <Switch
        label="Update automatically"
        description={autoWords(auto.settings.drainMinutes)}
        checked={auto.settings.auto}
        disabled={saving}
        onCheckedChange={(on) => void turn(on)}
      />
      <ul className={s.status} aria-label="Automatic updates">
        {autoStatus(auto, ready, now).map((line) => (
          <li key={line.key} data-auto-status={line.key}>
            {line.label === null ? null : (
              <Text size="xs" tone={line.labelTone}>
                {line.label}
              </Text>
            )}
            <Text size="xs" tone="quiet" tabular>
              {line.state === null ? null : (
                <Text size="xs" tone={line.state.tone} strong>
                  {`${line.state.text} `}
                </Text>
              )}
              <Line text={line.text} />
            </Text>
          </li>
        ))}
      </ul>
    </div>
  );
}

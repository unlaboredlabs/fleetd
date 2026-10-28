// Settings › You › General: Appearance and time in the app, then Notifications (Notifications.tsx) and Version: this
// app's version and channel with Check for updates, and one read-only line on whether the hub and its machines are up
// to date (updates/model.ts hubStanding). Updating them takes admin on every machine, so it is on Hub › Machines, and
// only owners and admins get the way there.
import { useEffect, useState } from "react";
import { isEdge } from "../../../shared/pairing";
import { Button, Radio, RadioGroup, Switch, Text, THEME_MODES, useTheme } from "../../ui";
import { useAdministers } from "../admin/role";
import { navigate } from "../shell/navigation";
import { useUpdatesView } from "../updates/hooks";
import { hubStanding } from "../updates/model";
import { runApp } from "../updates/UpdatesHost";
import { AppSection, Line } from "../updates/UpdatesSheet";
import { Notifications } from "./Notifications";
import { PageHead, PagePart, Setting } from "./parts";
import s from "./settings.module.css";

export function General() {
  const { mode, setMode } = useTheme();
  return (
    <div className={s.scroll} data-screen="settings.general">
      <div className={s.column}>
        <PageHead title="General" />
        <Setting reveal="general.appearance" label="Appearance" help="Match system follows the OS as it changes.">
          <RadioGroup className={s.radios} value={mode} onValueChange={(v) => {
              const m = THEME_MODES.find((x) => x.value === v);
              if (m) setMode(m.value);
            }} aria-label="Appearance">
            {THEME_MODES.map((m) => (
              <Radio key={m.value} value={m.value} label={m.label} />
            ))}
          </RadioGroup>
        </Setting>
        <PresenceSetting />
        <Notifications />
        <Versions />
      </div>
    </div>
  );
}

/**
 * Which fleetd this app runs, with Check for updates, and one read-only line on the hub and its machines. Updating the
 * hub takes admin on every machine: its owners and admins do it in Hub › Machines › Updates.
 */
function Versions() {
  const view = useUpdatesView();
  const administers = useAdministers();
  const channel = view.app === null ? null : isEdge(view.app.raw) ? "Edge" : "Stable";
  const hub = hubStanding(view);
  return (
    <PagePart title="Version" reveal="general.updates" intro={channel === null ? undefined : `This app follows the ${channel} channel.`}>
      {view.app === null ? <Text tone="quiet">Loading…</Text> : <AppSection part={view.app} onApp={runApp} />}
      {hub === null ? (
        <Text size="sm" tone="quiet">
          Connect to a hub to see whether it is up to date.
        </Text>
      ) : (
        <div className={s.inline} data-hub-standing>
          <Text size="sm" tone={hub.tone === "quiet" ? "quiet" : hub.tone}>
            <Line text={hub.text} />
          </Text>
          {administers ? (
            <Button size="sm" variant="quiet" onClick={() => navigate({ id: "settings", tab: "hub.machines" })}>
              Updates in Hub › Machines
            </Button>
          ) : null}
        </div>
      )}
    </PagePart>
  );
}

/** App presence (main/presence.ts): main reads and keeps the switch, so it holds before any window loads. */
function PresenceSetting() {
  const [on, setOn] = useState<boolean | null>(null);
  useEffect(() => {
    let live = true;
    void window.fleetd.app.presence(null).then((value) => {
      if (live) setOn(value);
    });
    return () => {
      live = false;
    };
  }, []);
  return (
    <Setting reveal="general.presence" label="Time in the app" help="Counts toward your minutes per merged PR.">
      <Switch
        label="Tell the hub when I'm using the app"
        description="Once a minute: whether fleetd is in front, which project is on screen, and whether you used it in the last minute. Never what you type or see. It stays on your hub."
        checked={on ?? true}
        disabled={on === null}
        onCheckedChange={(next) => void window.fleetd.app.presence(next).then(setOn)}
      />
    </Setting>
  );
}

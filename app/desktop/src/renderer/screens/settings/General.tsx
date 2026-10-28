// Settings › General: Appearance and time in the app, then Notifications (Notifications.tsx) and Version & updates:
// this app's version and channel with Check for updates, the hub's and each machine's fleetd and whether each is up to
// date, as the updates sheet says them (updates/), and for an owner or admin the sheet itself, whose Update runs on
// the hub. Updating the hub and its machines takes admin on every machine, so only they see the way to it.
import { useEffect, useState } from "react";
import { isEdge } from "../../../shared/pairing";
import { Button, Radio, RadioGroup, Switch, Text, THEME_MODES, useTheme } from "../../ui";
import { useDataLayer } from "../../src/data/react";
import { useAdministers } from "../admin/role";
import { useUpdatesView } from "../updates/hooks";
import { runApp } from "../updates/UpdatesHost";
import { AppSection, HubSection } from "../updates/UpdatesSheet";
import { setUpdatesOpen } from "../updates/state";
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

/** Which fleetd this app, the hub and each machine run, whether each is up to date, and the way to update. */
function Versions() {
  const view = useUpdatesView();
  const administers = useAdministers();
  const { hub } = useDataLayer();
  const channel = view.app === null ? null : isEdge(view.app.raw) ? "Edge" : "Stable";
  return (
    <PagePart title="Version" reveal="general.updates" intro={channel === null ? undefined : `This app follows the ${channel} channel.`}>
      {view.app === null ? <Text tone="quiet">Loading…</Text> : <AppSection part={view.app} onApp={runApp} />}
      {view.hub === null ? (
        <Text size="sm" tone="quiet">
          Connect to a hub to see its version and its machines&apos;.
        </Text>
      ) : (
        <HubSection part={view.hub} nodes={view.nodes} />
      )}
      {administers && view.hub !== null ? (
        <div className={s.inline}>
          <Button variant={view.update === null ? "secondary" : "primary"} onClick={() => setUpdatesOpen(true, hub)}>
            {view.update === null ? "Open updates…" : "Update…"}
          </Button>
          <Text size="xs" tone="quiet">
            Updates the hub, then every machine, then this app.
          </Text>
        </div>
      ) : null}
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

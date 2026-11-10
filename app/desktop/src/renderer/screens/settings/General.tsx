// Settings › You › General: your name (Name.tsx), Appearance and time in the app, then Notifications
// (Notifications.tsx) and Version: this app's version and channel with Check for updates, and one read-only line on
// whether the hub and its machines are up to date (updates/model.ts hubStanding). Updating them takes admin on every
// machine, so it is on Hub › Machines, and only owners and admins get the way there.
import { useEffect, useState } from "react";
import { isEdge } from "../../../shared/pairing";
import { Button, Segmented, THEME_MODES, useTheme } from "../../ui";
import { useAdministers } from "../admin/role";
import { navigate } from "../shell/navigation";
import { AutoUpdates } from "../updates/AutoUpdates";
import { useUpdatesView } from "../updates/hooks";
import { hubStanding, type AppPart } from "../updates/model";
import { runApp } from "../updates/UpdatesHost";
import { Command, Line, Notes, Raw } from "../updates/UpdatesSheet";
import { YourName } from "./Name";
import { Notifications } from "./Notifications";
import { GroupNote, PageHead, SettingsRow, SettingsSection, SwitchRow } from "./parts";
import s from "./settings.module.css";

export function General() {
  const { mode, setMode } = useTheme();
  return (
    <div className={s.scroll} data-screen="settings.general">
      <div className={s.column}>
        <PageHead title="General" />
        <SettingsSection>
          <YourName />
          <SettingsRow
            reveal="general.appearance"
            title="Appearance"
            line="Match system follows the OS as it changes."
            control={<Segmented label="Appearance" options={THEME_MODES} value={mode} onChange={setMode} />}
          />
          <PresenceSetting />
        </SettingsSection>
        <Notifications />
        <Versions />
      </div>
    </div>
  );
}

/**
 * Which fleetd this app runs, with Check for updates, and one read-only line on the hub and its machines. Updating the
 * hub takes admin on every machine: its owners and admins do it in Hub › Updates; a member is told whom to ask.
 */
function Versions() {
  const view = useUpdatesView();
  const administers = useAdministers();
  const channel = view.app === null ? null : isEdge(view.app.raw) ? "Edge" : "Stable";
  const hub = hubStanding(view);
  return (
    <SettingsSection title="Version" reveal="general.updates" intro={channel === null ? undefined : `This app follows the ${channel} channel.`}>
      {view.app === null ? <GroupNote>Loading…</GroupNote> : <AppRow part={view.app} />}
      <SettingsRow
        title="The hub and its machines"
        line={hub === null ? "Connect to a hub to see whether it is up to date." : <span data-hub-standing><Line text={hub.text} /></span>}
        lineTone={hub === null || hub.tone === "quiet" ? "quiet" : hub.tone}
        control={
          hub !== null && administers ? (
            <Button variant="secondary" onClick={() => navigate({ id: "settings", tab: "hub.updates" })}>
              Open Hub › Updates
            </Button>
          ) : undefined
        }
      />
      {/* A member: whom to ask to update the hub or turn Update automatically on. */}
      {hub === null || administers ? null : (
        <GroupNote>
          <AutoUpdates />
        </GroupNote>
      )}
    </SettingsSection>
  );
}

/** This app: its version and channel, Check for updates (or the update's own action), and what's new. */
function AppRow({ part }: { part: AppPart }) {
  const { action } = part;
  return (
    <SettingsRow
      title={<Line text={part.title} />}
      label="This app"
      line={part.detail === undefined ? undefined : <Line text={part.detail} />}
      data={{ "data-updates-part": "app" }}
      control={
        <>
          <Raw version={part.raw} />
          {action === undefined ? null : (
            <Button variant="secondary" disabled={part.busy === true} onClick={() => runApp(action.run)}>
              {action.label}
            </Button>
          )}
        </>
      }
    >
      {part.command === undefined && part.notes.lines.length === 0 ? null : (
        <>
          {part.command === undefined ? null : <Command command={part.command} />}
          <Notes notes={part.notes} />
        </>
      )}
    </SettingsRow>
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
    <SwitchRow
      reveal="general.presence"
      title="Tell the hub when I'm using the app"
      line="Once a minute: whether the app is in front and which project is open, to measure your time per merged PR. Never what you type or see."
      checked={on ?? true}
      disabled={on === null}
      onCheckedChange={(next) => void window.fleetd.app.presence(next).then(setOn)}
    />
  );
}

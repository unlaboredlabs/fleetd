// Settings › You › General: your name (Name.tsx), Appearance (and on the Mac the see-through sidebar) and time in the
// app, then Notifications (Notifications.tsx) and Version: the one status of updates (updates/model.ts), with this
// app's own update when it has one. Updating the hub and its machines is its owners' and admins'; a member reads where
// things stand.
import { useEffect, useState } from "react";
import { canSeeThrough, Segmented, THEME_MODES, useSeeThrough, useTheme } from "../../ui";
import { useServes } from "../admin/role";
import { useUpdateStatus } from "../updates/hooks";
import { UpdateStatus } from "../updates/UpdateStatus";
import { YourName } from "./Name";
import { Notifications } from "./Notifications";
import { PageHead, SettingsRow, SettingsSection, SwitchRow } from "./parts";
import s from "./settings.module.css";
import { onWeb } from "../../src/web";

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
            control={<Segmented label="Appearance" options={THEME_MODES} value={mode} onChange={setMode} />}
          />
          {/* Only where the sidebar can be see-through: the Mac desktop app. */}
          {canSeeThrough() ? <SeeThroughSetting /> : null}
          {/* App presence is the desktop app's: main reads the OS's idle time. */}
          {onWeb() ? null : <PresenceSetting />}
        </SettingsSection>
        <Notifications />
        <Versions />
      </div>
    </div>
  );
}

/**
 * Where updates stand, in the same words as Hub › Machines › Updates: an admin updates everything from either. On the
 * web on fleetd cloud, nothing: the team updates itself and the page has no update of its own.
 */
function Versions() {
  const status = useUpdateStatus();
  const updates = useServes("hub_update");
  if (onWeb() && !updates) return null;
  return (
    <SettingsSection title="Version" reveal="general.updates">
      <UpdateStatus status={status} />
    </SettingsSection>
  );
}

/** The see-through sidebar (ui/seeThrough.ts), kept on this device and applied at once. */
function SeeThroughSetting() {
  const { on, setOn } = useSeeThrough();
  // Search finds it by Appearance's words ("see-through sidebar"), and lands beside it: an option of its own would show
  // on the web too.
  return <SwitchRow title="See-through sidebar" checked={on} onCheckedChange={setOn} />;
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
      hint="Once a minute: whether the app is in front and which bot is open, to measure your time per merged PR. Never what you type or see."
      checked={on ?? true}
      disabled={on === null}
      onCheckedChange={(next) => void window.fleetd.app.presence(next).then(setOn)}
    />
  );
}

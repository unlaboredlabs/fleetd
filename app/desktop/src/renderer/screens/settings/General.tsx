import { useEffect, useState } from "react";
import { Radio, RadioGroup, Switch, THEME_MODES, useTheme } from "../../ui";
import { PageHead, Setting } from "./parts";
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
      </div>
    </div>
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

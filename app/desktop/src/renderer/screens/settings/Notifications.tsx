// Settings → General → Notifications: which kinds alert you, with a sound or not, the Dock badge, and a test. The shell reads
// these when it posts (shell/effects.ts); nothing here talks to the fleet.
import { useState } from "react";
import { Button } from "../../ui";
import { setNotificationPrefs, useNotificationPrefs, type NotificationPrefs } from "../shell/notificationPrefs";
import type { NotifyKind } from "../shell/notifier";
import { SettingsRow, SettingsSection, SwitchRow } from "./parts";

const mac = window.fleetd.platform === "darwin";

const KINDS: ReadonlyArray<{ kind: NotifyKind; label: string }> = [
  { kind: "reply", label: "The lead asks you something" },
  { kind: "approval", label: "A command or secret waits for you" },
  { kind: "done", label: "The lead finishes what you asked" },
  { kind: "machine", label: "A machine goes offline or hits a limit" },
  { kind: "other", label: "Anything else that needs you" },
];

type Test = "idle" | "sent" | "unsupported";

export function Notifications() {
  const prefs = useNotificationPrefs();
  const [test, setTest] = useState<Test>("idle");
  const set = (change: Partial<NotificationPrefs>) => setNotificationPrefs({ ...prefs, ...change });
  const sendTest = async () => {
    const shown = await window.fleetd.app.notify({
      tag: "test",
      title: "fleetd",
      body: "Notifications are on. This is how fleetd tells you something needs you.",
      target: { kind: "notifications" },
      silent: !prefs.sound,
    });
    setTest(shown ? "sent" : "unsupported");
  };
  return (
    <SettingsSection title="Notifications" reveal="notifications">
      <SettingsRow reveal="notifications.kinds" title="Notify me when" line="Never for the chat in front of you." />
      {KINDS.map(({ kind, label }) => (
        <SwitchRow key={kind} title={label} checked={prefs.kinds[kind]} onCheckedChange={(on) => set({ kinds: { ...prefs.kinds, [kind]: on } })} />
      ))}
      <SwitchRow reveal="notifications.sound" title="Play a sound" line="The system's notification sound." checked={prefs.sound} onCheckedChange={(on) => set({ sound: on })} />
      <SwitchRow
        reveal="notifications.badge"
        title="Count the projects that need you"
        line={mac ? "As a badge on the fleetd icon in the Dock." : "As a badge where your desktop shows them."}
        checked={prefs.badge}
        onCheckedChange={(on) => set({ badge: on })}
      />
      <SettingsRow
        reveal="notifications.test"
        title="Test"
        line={
          // A live region from the start, so the line is read out when it appears.
          <span role="status">
            {test === "sent"
              ? mac
                ? "Sent. Nothing showed? Allow fleetd in System Settings, Notifications."
                : "Sent. Nothing showed? Check your desktop's notification settings."
              : test === "unsupported"
                ? "This system doesn’t show notifications."
                : "Shows one now, whatever is set above."}
          </span>
        }
        control={
          <Button variant="secondary" onClick={() => void sendTest()}>
            Send a test notification
          </Button>
        }
      />
    </SettingsSection>
  );
}

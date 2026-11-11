// Settings → General → Notifications: which kinds alert you, and a test. The shell reads these when it posts
// (shell/effects.ts); nothing here talks to the fleet. A sound and the Dock badge are the system's own per-app switches.
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
    });
    setTest(shown ? "sent" : "unsupported");
  };
  return (
    <SettingsSection title="Notifications" reveal="notifications">
      <SettingsRow reveal="notifications.kinds" title="Notify me when" hint="Never for the chat in front of you." />
      {KINDS.map(({ kind, label }) => (
        <SwitchRow key={kind} title={label} checked={prefs.kinds[kind]} onCheckedChange={(on) => set({ kinds: { ...prefs.kinds, [kind]: on } })} />
      ))}
      <SettingsRow
        reveal="notifications.test"
        title="Test notification"
        hint="Shows one now, whatever is set above."
        line={
          // A live region from the start, so the line is read out when it appears.
          <span role="status">
            {test === "sent"
              ? mac
                ? "Sent. Nothing showed? Allow fleetd in System Settings, Notifications."
                : "Sent. Nothing showed? Check your desktop's notification settings."
              : test === "unsupported"
                ? "This system doesn’t show notifications."
                : null}
          </span>
        }
        control={
          <Button variant="secondary" onClick={() => void sendTest()}>
            Send
          </Button>
        }
      />
    </SettingsSection>
  );
}

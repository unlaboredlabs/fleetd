// Settings → General → Notifications: which kinds alert you, with a sound or not, the Dock badge, and a test. The shell reads
// these when it posts (shell/effects.ts); nothing here talks to the fleet.
import { useState } from "react";
import { Button, Separator, Switch, Text } from "../../ui";
import { setNotificationPrefs, useNotificationPrefs, type NotificationPrefs } from "../shell/notificationPrefs";
import type { NotifyKind } from "../shell/notifier";
import { PagePart, Setting } from "./parts";
import s from "./settings.module.css";

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
    <PagePart title="Notifications" reveal="notifications">
      <Setting reveal="notifications.kinds" label="Notify me when" help="Never for the chat in front of you.">
        {KINDS.map(({ kind, label }) => (
          <Switch key={kind} label={label} checked={prefs.kinds[kind]} onCheckedChange={(on) => set({ kinds: { ...prefs.kinds, [kind]: on } })} />
        ))}
      </Setting>
      <Setting reveal="notifications.sound" label="Sound" help="The system's notification sound.">
        <Switch label="Play a sound" checked={prefs.sound} onCheckedChange={(on) => set({ sound: on })} />
      </Setting>
      <Setting
        reveal="notifications.badge"
        label={mac ? "Dock badge" : "App icon badge"}
        help={mac ? "On the fleetd icon in the Dock." : "Where your desktop shows badges."}
      >
        <Switch label="Count the projects that need you" checked={prefs.badge} onCheckedChange={(on) => set({ badge: on })} />
      </Setting>
      <Separator />
      <Setting reveal="notifications.test" label="Test" help="Shows one now, whatever is set above.">
        <div className={s.inline}>
          <Button variant="secondary" onClick={() => void sendTest()}>
            Send a test notification
          </Button>
        </div>
        {/* A live region from the start, so the line is read out when it appears. */}
        <div role="status">
          {test === "sent" ? (
            <Text tone="quiet">
              {mac
                ? "Sent. Nothing showed? Allow fleetd in System Settings, Notifications."
                : "Sent. Nothing showed? Check your desktop's notification settings."}
            </Text>
          ) : test === "unsupported" ? (
            <Text tone="quiet">This system doesn’t show notifications.</Text>
          ) : null}
        </div>
      </Setting>
    </PagePart>
  );
}

// Settings → Notifications (F9 mounts this): the Status digest, off by default.
import { Switch } from "../../ui";
import { setDigestEnabled, useDigestEnabled } from "./digest";

export function DigestSetting() {
  const on = useDigestEnabled();
  return (
    <Switch
      checked={on}
      onCheckedChange={setDigestEnabled}
      label="Morning and evening digest"
      description="At 09:00 and 18:00, a notification with the fleet's progress, what changed since the last one, and what needs you. Quiet hours apply."
    />
  );
}

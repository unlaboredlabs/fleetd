// The bot's Daily check-in on its Info screen, as the desktop's Automations tab has it: one switch, off until a person
// turns it on. On makes the check-in (daily at 09:00 in the phone's zone), off deletes it. The offers come in the chat,
// with buttons.
import { useState } from "react";
import { Switch } from "react-native";
import { CHECKIN_ABOUT, CHECKIN_TITLE, checkInInput, checkInLast, isCheckIn, type HubError } from "../../desktop";
import { useHub } from "../../hubContext";
import { refOf } from "../../store";
import { haptics } from "../../ui/haptics";
import { ListRow, ListSection } from "../../ui/List";
import { errorWords, Problem, useBotLocked, useRead } from "./parts";

const zone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

export function CheckIn({ chatKey, live }: { chatKey: string; live: boolean }) {
  const { session } = useHub();
  const ref = refOf(chatKey);
  // A member sees it; only an admin switches it.
  const locked = useBotLocked();
  const read = useRead(() => session.call("automation_list", { projectRef: ref }), [session, chatKey]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<HubError | null>(null);
  const [requestId] = useState(() => `checkin-${String(Date.now())}`);
  const list = read.value;
  if (list === undefined || !list.ok) return null;
  const a = list.output.automations.find(isCheckIn);
  const on = a !== undefined && !a.paused;

  const toggle = async (next: boolean) => {
    if (busy) return;
    haptics.select();
    setBusy(true);
    setError(null);
    const r = !next
      ? a === undefined
        ? undefined
        : await session.call("automation_delete", { automationId: a.automationId })
      : a !== undefined
        ? await session.call("automation_pause", { automationId: a.automationId, paused: false })
        : await session.call("automation_create", checkInInput(ref, zone(), requestId));
    setBusy(false);
    if (r !== undefined && !r.ok) setError(r.error);
    read.reload();
  };

  const last = a === undefined ? undefined : checkInLast(a);
  return (
    <>
      <ListSection footer={CHECKIN_ABOUT}>
        <ListRow
          title={CHECKIN_TITLE}
          icon="calendar"
          {...(on ? { detail: ["Daily at 09:00", last].filter(Boolean).join(" · ") } : {})}
          accessory={<Switch value={on} disabled={!live || locked || busy} onValueChange={(v) => void toggle(v)} accessibilityLabel={CHECKIN_TITLE} />}
        />
      </ListSection>
      <Problem text={error === null ? undefined : `Not changed: ${errorWords(error)}`} />
    </>
  );
}

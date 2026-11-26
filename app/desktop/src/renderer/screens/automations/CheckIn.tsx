// The Automations tab's Daily check-in: one switch per bot, off until a person turns it on. On, the hub makes the
// check-in (a watcher of kind `checkin`, daily at 09:00 in this computer's zone); off deletes it. Its line says when
// it runs next and how the last one went, and Check in now looks at once. The offers come in the chat, with buttons.
import { useState } from "react";
import type { Automation, ProjectRef } from "../../../shared/contracts";
import { Button, Text, Toggle } from "../../ui";
import { errorText, useHubCall, useRefetch } from "../settings/hub";
import { SettingsRow, SettingsSection } from "../settings/parts";
import settings from "../settings/settings.module.css";
import { BOT_ADMIN_ONLY, useBotLocked } from "../settings/botAdmin";
import { localZone, when } from "./model";
import { CHECKIN_ABOUT, CHECKIN_TITLE, checkInInput, checkInLast } from "./watchModel";

const READS = ["automation_list", "automation_runs"] as const;

export function CheckIn(props: { projectRef: ProjectRef; checkIn: Automation | undefined }) {
  const a = props.checkIn;
  const on = a !== undefined && !a.paused;
  const hubCall = useHubCall();
  const refetch = useRefetch();
  // A member sees it; only an admin switches it, as with the bot's other automations.
  const locked = useBotLocked();
  const [busy, setBusy] = useState(false);
  const [echo, setEcho] = useState<{ ok: boolean; text: string } | null>(null);
  const [requestId] = useState(() => crypto.randomUUID());

  const toggle = (next: boolean) => {
    setBusy(true);
    setEcho(null);
    const work = async () => {
      if (!next) {
        if (a) await hubCall("automation_delete", { automationId: a.automationId });
      } else if (a) await hubCall("automation_pause", { automationId: a.automationId, paused: false });
      else await hubCall("automation_create", checkInInput(props.projectRef, localZone(), requestId));
    };
    work().then(
      () => {
        setBusy(false);
        refetch([...READS]);
      },
      (e: unknown) => {
        setBusy(false);
        setEcho({ ok: false, text: errorText(e) });
      },
    );
  };

  /** Check in now: the same look as the day's, which posts an offer only when something waits. */
  const now = (id: string) => {
    setBusy(true);
    setEcho(null);
    hubCall("automation_run", { automationId: id }).then(
      (out) => {
        setBusy(false);
        setEcho(
          out.run.state === "running"
            ? { ok: true, text: "Checking in. An offer comes in the chat only if something waits." }
            : { ok: false, text: `Not now: ${out.run.why ?? "skipped"}.` },
        );
        refetch([...READS]);
      },
      (e: unknown) => {
        setBusy(false);
        setEcho({ ok: false, text: errorText(e) });
      },
    );
  };

  const line = on
    ? [a.nextRunAt ? `Next ${when(a.nextRunAt)}` : null, checkInLast(a)].filter(Boolean).join(" · ")
    : CHECKIN_ABOUT;
  return (
    <SettingsSection intro={locked ? BOT_ADMIN_ONLY : undefined} data={{ "data-group": "checkin" }}>
      <SettingsRow
        title={CHECKIN_TITLE}
        label={CHECKIN_TITLE}
        hint={on ? CHECKIN_ABOUT : undefined}
        line={line}
        control={<Toggle aria-label={CHECKIN_TITLE} checked={on} disabled={busy || locked} onCheckedChange={toggle} />}
      >
        {on ? (
          <div className={settings.actions}>
            <Button disabled={busy} onClick={() => now(a.automationId)}>
              Check in now
            </Button>
          </div>
        ) : null}
        <div role="status">
          {echo ? (
            <Text size="xs" tone={echo.ok ? "quiet" : "danger"}>
              {echo.text}
            </Text>
          ) : null}
        </div>
      </SettingsRow>
    </SettingsSection>
  );
}

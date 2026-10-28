// Memory caps: how long each memory file may grow, hub-wide (memory_caps_set, an admin's write), on Settings › Hub ›
// hub settings. The lead's `remember` and Settings → Projects → Instructions & memory's editors are held to what is set here.
import { useState } from "react";
import type { MemoryCaps as Caps } from "../../../shared/contracts";
import { Button, Field, Input, Text } from "../../ui";
import { useToolQuery } from "../../src/data/react";
import { errorText, useHubCall, useLive, useRefetch } from "./hub";
import { CAP_FIELDS, draftOf, parseCaps, type CapsDraft } from "./memoryCapsModel";
import s from "./settings.module.css";

const noInput = {};

/** The caps as the hub has them now, read on their own: Every project's page has no memory list around them. */
export function HubMemoryCaps() {
  const live = useLive();
  const read = useToolQuery("memory_get", noInput, { enabled: live });
  return <MemoryCaps caps={read.data?.caps} />;
}

export function MemoryCaps({ caps }: { caps: Caps | undefined }) {
  const hubCall = useHubCall();
  const refetch = useRefetch();
  const saved = caps === undefined ? undefined : draftOf(caps);
  const [draft, setDraft] = useState<{ from: CapsDraft | undefined; now: CapsDraft | undefined }>({ from: saved, now: saved });
  const [busy, setBusy] = useState(false);
  const [echo, setEcho] = useState<{ ok: boolean; text: string } | null>(null);
  // The hub's newer caps replace untouched fields; an edit in progress stays.
  const savedKey = JSON.stringify(saved);
  if (JSON.stringify(draft.from) !== savedKey && JSON.stringify(draft.now) === JSON.stringify(draft.from)) setDraft({ from: saved, now: saved });
  if (caps === undefined || draft.now === undefined) return null;
  const now = draft.now;
  const parsed = parseCaps(now);
  const dirty = JSON.stringify(now) !== savedKey;

  const save = () => {
    if (!parsed.ok) return;
    setBusy(true);
    setEcho(null);
    hubCall("memory_caps_set", parsed.caps).then(
      () => {
        setBusy(false);
        setEcho({ ok: true, text: "Saved. Writes past a cap are refused from now." });
        refetch(["memory_get"]);
      },
      (e: unknown) => {
        setBusy(false);
        setEcho({ ok: false, text: errorText(e) });
      },
    );
  };

  return (
    <div className={s.stack}>
      <div className={s.settingLabel}>
        <Text strong>Memory caps</Text>
        <Text size="xs" tone="quiet">
          The most characters each file holds, on this hub. A write past a cap is refused, so the lead merges entries instead.
        </Text>
      </div>
      {CAP_FIELDS.map((f) => (
        <Field key={f.key} label={f.label} description={f.help} error={!parsed.ok && parsed.key === f.key ? parsed.reason : undefined}>
          <Input inputMode="numeric" value={now[f.key]} onChange={(e) => setDraft({ from: draft.from, now: { ...now, [f.key]: e.target.value } })} />
        </Field>
      ))}
      <div className={s.actions}>
        <Button variant="primary" disabled={!dirty || !parsed.ok || busy} onClick={save}>
          {busy ? "Saving…" : "Save caps"}
        </Button>
        <Button variant="ghost" disabled={!dirty} onClick={() => setDraft({ from: draft.from, now: draft.from })}>
          Discard changes
        </Button>
      </div>
      <div role="status">
        {echo ? (
          <Text size="xs" tone={echo.ok ? "quiet" : "danger"}>
            {echo.text}
          </Text>
        ) : null}
      </div>
    </div>
  );
}

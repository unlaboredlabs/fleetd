// Administration › Google, Real-time mail (optional, #743): Gmail tells a Pub/Sub topic of new mail, and one machine
// reads its subscription with a service account's key. The steps are google/guide.ts realtimeParts, the same as the
// hub's setup step for Google; the key goes to main, which checks it and seals it to that machine's key (secret.googlePubsub →
// google_pubsub_set), and is never shown again. Turn off is google_pubsub_set with nothing, and the machine forgets
// the key. How mail arrives now, push or polling and why, is google_get's.
import { useState } from "react";
import type { GoogleGetOutput, GooglePubsubSetOutput } from "../../../shared/contracts";
import { CallError } from "../../src/data/queries";
import { useData, useDataLayer } from "../../src/data/react";
import { Button, Dialog, Field, Input, Select, Text, Textarea } from "../../ui";
import { errorText, useHubCall, useRefetch } from "../settings/hub";
import { GuideParts, Part } from "../setup/Guide";
import { cloudProject, GMAIL_SUBSCRIPTION, GMAIL_TOPIC, realtimeParts } from "./guide";
import { boxesOf, keyProblem, mailModeLine, subscriptionProblem, topicProblem } from "./model";
import s from "./google.module.css";
import settings from "../settings/settings.module.css";

export function RealTimeMail({ info, hub }: { info: GoogleGetOutput; hub: string }) {
  const hubCall = useHubCall();
  const refetch = useRefetch();
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<{ ok: boolean; text: string } | null>(null);
  const pubsub = info.client?.pubsub;
  const mode = mailModeLine(info);
  const off = () => {
    setBusy(true);
    hubCall("google_pubsub_set", {}).then(
      (out) => {
        setBusy(false);
        setConfirm(false);
        setSaid({ ok: true, text: out.next ?? "Real-time mail is off." });
        refetch(["google_get"]);
      },
      (e: unknown) => {
        setBusy(false);
        setConfirm(false);
        setSaid({ ok: false, text: errorText(e) });
      },
    );
  };
  return (
    <section aria-label="Real-time mail" className={s.guide}>
      <div className={s.head}>
        <div className={settings.stack}>
          <Text strong>
            Real-time mail{" "}
            <Text size="xs" tone="faint">
              Optional
            </Text>
          </Text>
          {info.client === undefined ? (
            <Text size="sm" tone="quiet">
              Set up the client first.
            </Text>
          ) : pubsub === undefined ? (
            <Text size="sm" tone="quiet">
              Off. A Navi whose new mail wakes it hears of it within about a minute; with real-time mail, within seconds.
            </Text>
          ) : (
            <>
              <Text size="sm" mono className={s.clientId} data-text="code">
                {pubsub.subscription}
              </Text>
              <Text size="xs" tone="quiet">{`Read on ${pubsub.machineId}, whose node holds the key.`}</Text>
              <Text size="sm" tone={mode.tone}>
                {mode.text}
              </Text>
            </>
          )}
        </div>
        {pubsub === undefined ? null : (
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => setConfirm(true)}>
            Turn off
          </Button>
        )}
      </div>
      {said === null ? null : (
        <div role={said.ok ? "status" : "alert"}>
          <Text size="sm" tone={said.ok ? "default" : "danger"}>
            {said.text}
          </Text>
        </div>
      )}
      {info.client === undefined ? null : (
        <details className={s.fold} open={open} onToggle={(e) => setOpen(e.currentTarget.open)}>
          <summary>
            <Text size="sm">{pubsub === undefined ? "Set up real-time mail" : "Change real-time mail"}</Text>
            <Text size="xs" tone="quiet">
              A Pub/Sub topic Gmail tells, a subscription one machine reads, and a key that may only read it.
            </Text>
          </summary>
          <GuideParts parts={realtimeParts(hub)} />
          <Part n={3} title="Paste what you get back">
            <MailForm hub={hub} info={info} onSaved={(text) => setSaid({ ok: true, text })} />
          </Part>
        </details>
      )}
      {confirm && pubsub !== undefined ? (
        <Dialog
          open
          onOpenChange={(o) => !o && !busy && setConfirm(false)}
          title="Turn off real-time mail?"
          description={`Navis whose mail wakes them go back to checking about every minute, and ${pubsub.machineId} forgets the service account key. Setting it up again takes the key again.`}
          footer={
            <>
              <Button onClick={() => setConfirm(false)} disabled={busy}>
                Cancel
              </Button>
              <Button variant="danger" disabled={busy} onClick={off}>
                {busy ? "Turning off…" : "Turn off"}
              </Button>
            </>
          }
        />
      ) : null}
    </section>
  );
}

/** Topic, subscription, the machine that reads it, and the key, sealed to that machine. */
function MailForm({ hub, info, onSaved }: { hub: string; info: GoogleGetOutput; onSaved: (text: string) => void }) {
  const { hub: hubId } = useDataLayer();
  const refetch = useRefetch();
  const machines = useData((d) => d.machines);
  const boxes = boxesOf(Object.values(machines)).sort((a, b) => a.machineId.localeCompare(b.machineId));
  const project = cloudProject(hub);
  const now = info.client?.pubsub;
  const [topic, setTopic] = useState(now?.topic ?? `projects/${project}/topics/${GMAIL_TOPIC}`);
  const [subscription, setSubscription] = useState(now?.subscription ?? `projects/${project}/subscriptions/${GMAIL_SUBSCRIPTION}`);
  const [machineId, setMachineId] = useState(now?.machineId ?? boxes[0]?.machineId ?? "");
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const box = boxes.find((b) => b.machineId === machineId);
  const issues = { topic: topicProblem(topic), subscription: subscriptionProblem(subscription), key: key.trim() === "" ? null : keyProblem(key) };
  const ready = issues.topic === null && issues.subscription === null && keyProblem(key) === null && box !== undefined;
  const save = async () => {
    if (box === undefined) return;
    setBusy(true);
    setProblem(null);
    const out = await window.fleetd.secret
      .googlePubsub(hubId, { topic: topic.trim(), subscription: subscription.trim(), machineId: box.machineId, boxPubKey: box.boxPubKey, key: key.trim() })
      .catch((e: unknown) => ({ ok: false as const, error: { code: "failed", message: errorText(e) } }));
    setBusy(false);
    if (!out.ok) {
      setProblem(errorText(new CallError(out.error)));
      return;
    }
    // Saved: the key leaves this page now.
    setKey("");
    refetch(["google_get"]);
    onSaved((out.output as GooglePubsubSetOutput).next ?? "Saved.");
  };
  return (
    <div className={s.form}>
      <Field label="Topic" error={issues.topic}>
        <Input mono aria-label="Topic" value={topic} disabled={busy} spellCheck={false} onChange={(e) => setTopic(e.target.value)} />
      </Field>
      <Field label="Subscription" error={issues.subscription}>
        <Input mono aria-label="Subscription" value={subscription} disabled={busy} spellCheck={false} onChange={(e) => setSubscription(e.target.value)} />
      </Field>
      <Field label="Read on" description="A machine that is usually online, such as the hub's own. Its node keeps the key and reads the subscription.">
        <Select aria-label="Read on" value={box === undefined ? undefined : machineId} disabled={busy} onValueChange={setMachineId} options={boxes.map((b) => ({ value: b.machineId, label: b.machineId }))} />
      </Field>
      <Field label="Service account key" error={issues.key}>
        <Textarea
          mono
          aria-label="Service account key"
          className={settings.secretValue}
          data-secret=""
          value={key}
          minRows={3}
          maxRows={8}
          disabled={busy}
          autoComplete="off"
          spellCheck={false}
          placeholder={`{ "type": "service_account", "project_id": "${project}", … }`}
          onChange={(e) => setKey(e.target.value)}
        />
      </Field>
      <Text size="xs" tone="quiet">
        {box === undefined
          ? "No machine takes secrets yet: update fleetd on the machine that should read the subscription, then save."
          : `The key is sealed on this computer to ${box.machineId}'s key, so only its node can open it. The hub keeps a fingerprint, and the key is never shown again or in a chat.`}
      </Text>
      <span>
        <Button variant="primary" disabled={busy || !ready} onClick={() => void save()}>
          {busy ? "Saving…" : "Save"}
        </Button>
      </span>
      {problem === null ? null : (
        <div role="alert">
          <Text size="sm" tone="danger">
            {problem}
          </Text>
        </div>
      )}
    </div>
  );
}

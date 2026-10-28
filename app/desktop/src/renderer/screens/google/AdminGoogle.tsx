// Administration › Google: the hub's Google OAuth client, which every Navi's Google connection goes through. The steps
// in Google Cloud Console are the setup step's own (google/guide.ts googleParts), with google_get's scopes and redirect.
// The client secret is sealed in main to each machine's key (secret.googleClient → google_client_set) and never comes
// back; Test asks Google to redeem a code that can't work (google_client_test), and `invalid_grant` means it knows the
// client. Real-time mail, optional, is below it (AdminMail.tsx). Each person then connects their own account from their
// Navi's Integrations.
import { Check } from "lucide-react";
import { useState } from "react";
import type { GoogleClientSetOutput, GoogleClientTestOutput, GoogleGetOutput } from "../../../shared/contracts";
import { lacksTool } from "../../src/data/errors";
import { CallError } from "../../src/data/queries";
import { useData, useDataLayer, useToolQuery } from "../../src/data/react";
import { Button, Field, Input, Separator, Text } from "../../ui";
import { useHubState } from "../onboarding/hooks";
import { errorText, useHubCall, useLive, useRefetch } from "../settings/hub";
import { PageHead } from "../settings/parts";
import { GuideParts, Part } from "../setup/Guide";
import { googleParts } from "./guide";
import { RealTimeMail } from "./AdminMail";
import { boxesOf, clientIdProblem, dayWords, DOCS, listWords, notHolding, secretProblem } from "./model";
import s from "./google.module.css";
import settings from "../settings/settings.module.css";

const noInput = {};

type Tested = { ok: true; text: string } | { ok: false; text: string };

const testedOf = (out: GoogleClientTestOutput): Tested =>
  out.check.ok
    ? { ok: true, text: `Google knows this client and its secret. Tested on ${out.machineId}.` }
    : { ok: false, text: `${out.check.problem ?? "Google refused the client."} Tested on ${out.machineId}.` };

function useBoxes() {
  const machines = useData((d) => d.machines);
  return boxesOf(Object.values(machines)).sort((a, b) => a.machineId.localeCompare(b.machineId));
}

export function AdminGoogle() {
  const live = useLive();
  const read = useToolQuery("google_get", noInput, { enabled: live });
  // The hub's address, for the names the steps suggest (fleetd-<host>).
  const state = useHubState();
  const address = state.phase === "unpaired" ? "http://127.0.0.1:4790" : state.hub;
  const hub = address.includes("://") ? address : `http://${address}`;
  const head = (
    <PageHead title="Google">
      Navis read and draft mail, events and files through a Google OAuth client you own. You set it up once, here; then each person connects their own
      account from their Navi&rsquo;s Integrations.
    </PageHead>
  );
  if (!live || read.data === undefined) {
    const text = !live ? "Not connected. Connect to a hub to set up Google." : read.error !== null ? errorText(read.error) : "Loading…";
    const old = read.error instanceof CallError && lacksTool(read.error.error);
    return (
      <div className={settings.scroll} data-screen={read.error !== null ? "admin.google.error" : "admin.google.loading"}>
        <div className={settings.column}>
          {head}
          <Text tone={read.error !== null && !old ? "danger" : "quiet"}>{old ? "This hub is too old for Google. Update fleetd on the hub first." : text}</Text>
        </div>
      </div>
    );
  }
  return (
    <div className={settings.scroll} data-screen="admin.google">
      <div className={settings.column}>
        {head}
        <ClientStatus info={read.data} />
        <Separator />
        <Guide info={read.data} hub={hub} />
        <Separator />
        <RealTimeMail info={read.data} hub={hub} />
      </div>
    </div>
  );
}

/** The client as the hub keeps it, the machines holding its secret, and Test. */
function ClientStatus({ info }: { info: GoogleGetOutput }) {
  const hubCall = useHubCall();
  const boxes = useBoxes();
  const [testing, setTesting] = useState(false);
  const [tested, setTested] = useState<Tested | null>(null);
  const client = info.client;
  if (client === undefined) {
    return (
      <section aria-label="OAuth client" className={s.status}>
        <Text strong>No client yet</Text>
        <Text size="sm" tone="quiet">
          Until there is one, Navis offer no Google, and their people are told to ask an admin. Follow the steps below.
        </Text>
      </section>
    );
  }
  const holding = (client.sealedOn ?? []).map((x) => x.machineId);
  const missing = notHolding(info, boxes);
  const test = () => {
    setTesting(true);
    hubCall("google_client_test", {}, { timeoutMs: 60_000 }).then(
      (out) => {
        setTesting(false);
        setTested(testedOf(out));
      },
      (e: unknown) => {
        setTesting(false);
        setTested({ ok: false, text: errorText(e) });
      },
    );
  };
  return (
    <section aria-label="OAuth client" className={s.status}>
      <div className={s.head}>
        <div className={settings.stack}>
          <Text size="sm" mono className={s.clientId} data-text="code">
            {client.clientId}
          </Text>
          <Text size="xs" tone="quiet">
            {`Secret sealed on ${holding.length === 0 ? "no machine" : listWords(holding)}. Saved ${dayWords(client.updatedAt)}.`}
          </Text>
        </div>
        <Button size="sm" disabled={testing} onClick={test}>
          {testing ? "Testing…" : "Test"}
        </Button>
      </div>
      {missing.length === 0 ? null : (
        <Text size="sm" tone="warning">
          {`${listWords(missing)} ${missing.length === 1 ? "doesn't" : "don't"} hold the secret: offline when it was saved, or added since. Save the client again below while ${missing.length === 1 ? "it is" : "they are"} online, so ${missing.length === 1 ? "its" : "their"} Navis can connect.`}
        </Text>
      )}
      {tested === null ? null : <TestLine tested={tested} />}
    </section>
  );
}

function TestLine({ tested }: { tested: Tested }) {
  return (
    <div role={tested.ok ? "status" : "alert"}>
      <Text size="sm" tone={tested.ok ? "success" : "danger"} className={s.tested}>
        {tested.ok ? <Check size={14} aria-hidden /> : null}
        {tested.text}
      </Text>
    </div>
  );
}

/** The steps in Google Cloud Console and the form for what comes back; folded away once a client is saved. */
function Guide({ info, hub }: { info: GoogleGetOutput; hub: string }) {
  const parts = googleParts(hub, info.scopes, info.redirect);
  // A machine without the secret needs it saved again: the form opens.
  const missing = notHolding(info, useBoxes()).length > 0;
  const steps = (
    <>
      <GuideParts parts={parts} />
      <Part n={parts.length + 1} title="Paste what you get back">
        <ClientForm />
      </Part>
    </>
  );
  // Open on a fresh hub, or while a machine lacks the secret; then as the admin leaves it, so saving keeps the form,
  // and what it said, in place.
  const [open, setOpen] = useState(info.client === undefined || missing);
  return (
    <section aria-label="Set up the client" className={s.guide}>
      <details className={s.fold} open={open} onToggle={(e) => setOpen(e.currentTarget.open)}>
        <summary>
          <Text size="sm" strong={info.client === undefined}>
            {info.client === undefined ? "Set up the client" : "Save the client again, or replace it"}
          </Text>
          <Text size="xs" tone="quiet">
            {info.client === undefined
              ? "In Google Cloud Console, signed in with the Google account that should own the app."
              : "The steps in Google Cloud Console, and the Client ID and secret to paste."}
          </Text>
        </summary>
        {steps}
      </details>
      <span>
        <Button variant="ghost" size="sm" onClick={() => void window.fleetd.openExternal(`${DOCS}#client`)}>
          Step by step in the docs
        </Button>
      </span>
    </section>
  );
}

/** Client ID and secret: the secret goes to main, sealed to every machine's key, and is never shown again. */
function ClientForm() {
  const { hub } = useDataLayer();
  const hubCall = useHubCall();
  const refetch = useRefetch();
  const boxes = useBoxes();
  const [id, setId] = useState("");
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [saved, setSaved] = useState<{ line: string; tested: Tested | null } | null>(null);
  const idIssue = id.trim() === "" ? null : clientIdProblem(id);
  const secretIssue = secret.trim() === "" ? null : secretProblem(secret);
  const ready = clientIdProblem(id) === null && secretProblem(secret) === null && boxes.length > 0;
  const save = async () => {
    setBusy(true);
    setProblem(null);
    setSaved(null);
    const out = await window.fleetd.secret.googleClient(hub, { clientId: id.trim(), secret: secret.trim(), boxes }).catch((e: unknown) => ({ ok: false as const, error: { code: "failed", message: errorText(e) } }));
    if (!out.ok) {
      setBusy(false);
      setProblem(errorText(new CallError(out.error)));
      return;
    }
    // Saved: the secret leaves this page now.
    setSecret("");
    setId("");
    const set = out.output as GoogleClientSetOutput;
    const missing = set.missingOn ?? [];
    const line =
      missing.length === 0
        ? `Saved, and sealed on ${listWords(set.client.sealedOn?.map((x) => x.machineId) ?? [])}.`
        : `Saved. ${listWords(missing)} ${missing.length === 1 ? "was" : "were"} offline and ${missing.length === 1 ? "doesn't" : "don't"} hold it: save again while ${missing.length === 1 ? "it is" : "they are"} online.`;
    setSaved({ line, tested: null });
    refetch(["google_get"]);
    const tested = await hubCall("google_client_test", {}, { timeoutMs: 60_000 }).then(testedOf, (e: unknown): Tested => ({ ok: false, text: errorText(e) }));
    setBusy(false);
    setSaved({ line, tested });
  };
  return (
    <div className={s.form}>
      <Field label="Client ID" error={idIssue}>
        <Input mono aria-label="Client ID" value={id} disabled={busy} autoComplete="off" spellCheck={false} placeholder="….apps.googleusercontent.com" onChange={(e) => setId(e.target.value)} />
      </Field>
      <Field label="Client secret" error={secretIssue}>
        <Input
          mono
          aria-label="Client secret"
          className={settings.secretValue}
          data-secret=""
          value={secret}
          disabled={busy}
          autoComplete="off"
          spellCheck={false}
          placeholder="GOCSPX-…"
          onChange={(e) => setSecret(e.target.value)}
        />
      </Field>
      <Text size="xs" tone="quiet">
        {boxes.length === 0
          ? "No machine takes secrets yet: update fleetd on the machines that run Navis, then save."
          : `The secret is sealed on this computer to the key of ${listWords(boxes.map((b) => b.machineId))}, so only their nodes can open it. The hub keeps a fingerprint, and it is never in a chat or transcript.`}
      </Text>
      <span>
        <Button variant="primary" disabled={busy || !ready} onClick={() => void save()}>
          {busy ? (saved === null ? "Saving…" : "Testing…") : "Save and test"}
        </Button>
      </span>
      {problem === null ? null : (
        <div role="alert">
          <Text size="sm" tone="danger">
            {problem}
          </Text>
        </div>
      )}
      {saved === null ? null : (
        <div className={settings.stack}>
          <div role="status">
            <Text size="sm">{saved.line}</Text>
          </div>
          {saved.tested === null ? null : <TestLine tested={saved.tested} />}
        </div>
      )}
    </div>
  );
}

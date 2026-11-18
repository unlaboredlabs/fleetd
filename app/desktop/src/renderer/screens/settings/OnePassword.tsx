// Settings › Your accounts › 1Password (D235): the person's own 1Password service account token, which fill_credential
// uses in the orders they start when the project has no OP_SERVICE_ACCOUNT_TOKEN of its own (that one wins). Pasted
// once: main seals it to every machine, and the page never gets it back. Test lists the
// vaults it reads: agents run as the person on their machine, so it should read one vault, kept for fleetd (D313). On a
// hub with a vault, it's only where items are imported from: fills use the vault.
import { useState } from "react";
import type { OnePasswordTest, OnePasswordToken } from "../../../shared/contracts";
import { lacksTool } from "../../src/data/errors";
import { CallError } from "../../src/data/queries";
import { useData, useDataLayer, useToolQuery } from "../../src/data/react";
import { useNow } from "../live";
import { HubText } from "../projects/HubText";
import { when } from "../live/when";
import { vaultServed } from "./vaultModel";
import { Button, Field, InlineCode, Input, Text } from "../../ui";
import { sealedLine } from "./claudeModel";
import { ConfirmRemove, MissingOn, Problem, useMachines } from "./claudeParts";
import { errorText, useHubCall, useLive, useRefetch } from "./hub";
import { RowMenu, SettingsRow } from "./parts";
import s from "./settings.module.css";

/** 1Password's page that makes a service account (hub/setup's ONEPASSWORD_NEW). */
export const SERVICE_ACCOUNTS = "https://start.1password.com/developer-tools/infrastructure-secrets/serviceaccount/";
/** The node may install the 1Password SDK on its first Test (up to 3 minutes), then asks 1Password. */
const TEST_MS = 240_000;

const noInput = {};

type Tried = { readonly test: OnePasswordTest } | { readonly error: string };

/**
 * A Test's verdict: "Reads fleetd (on devbox, today 14:02)." for one vault; more than one wants a look, as the hub's
 * hub/onepassword_vault check says; or 1Password's words, the token masked.
 */
export function vaultsLine(test: OnePasswordTest, nowMs: number): { ok: boolean; text: string; short?: string } {
  const at = `on ${test.machineId}, ${when(test.at, nowMs)}`;
  if (!test.ok) {
    const said = (test.error ?? "1Password said nothing").trim().replace(/\.$/u, "");
    return { ok: false, text: `Failed ${at}: ${said}.` };
  }
  const names = test.vaults ?? [];
  if (names.length === 0) return { ok: false, text: `It reads no vault (${at}). Give the service account access to the vault with your logins.` };
  if (names.length === 1) return { ok: true, text: `Reads ${names[0] ?? ""} (${at}).` };
  const list = `${names.slice(0, -1).join(", ")} and ${names[names.length - 1] ?? ""}`;
  return {
    ok: false,
    short: `Reads ${list}: it should read only fleetd's vault. Replace it with a service account that does.`,
    text: `Reads ${list} (${at}): an agent on a machine holding it could read every item in each. Make a service account that reads only fleetd's vault, paste its token here, and revoke this one in 1Password.`,
  };
}

/** On a hub with a vault, 1Password is only where items come from (vault-design §6): fills use the vault. */
const IMPORT_INTRO =
  "Optional: a place to import logins, cards and addresses from into the team vault. Agents fill from the vault, never from 1Password; your leads can search it and offer you items to import.";

/** 1Password, as one row of Your accounts. */
export function OnePasswordSettings() {
  const live = useLive();
  const vault = useData((st) => vaultServed(st.features));
  const read = useToolQuery("onepassword_get", noInput, { enabled: live });
  const hint = vault
    ? IMPORT_INTRO
    : "The logins your agents sign in to sites with, in the orders you start. They name a 1Password item and fleetd types the value in; no agent ever sees it.";
  const note = (line: string, tone: "quiet" | "danger" = "quiet") => <SettingsRow reveal="onepassword" mark="off" title="1Password" hint={hint} line={line} lineTone={tone} />;
  if (!live) return note("Not connected. Connect to a hub to set up 1Password.");
  if (read.error instanceof CallError && lacksTool(read.error.error)) return note("This hub reads 1Password only with a bot's OP_SERVICE_ACCOUNT_TOKEN variable. Update fleetd on the hub to save your own.");
  if (read.error instanceof CallError && read.error.error.code === "forbidden") return note("This device's key belongs to no person. Pair the app as yourself to set it up.");
  if (read.isLoadingError) return note(errorText(read.error), "danger");
  if (read.data === undefined) return note("Loading…");
  return <ServiceAccount token={read.data.token} hint={hint} />;
}

function ServiceAccount({ token, hint }: { token: OnePasswordToken | undefined; hint: string }) {
  const machines = useMachines();
  const hubCall = useHubCall();
  const refetch = useRefetch();
  const { hub } = useDataLayer();
  const [value, setValue] = useState("");
  const [connecting, setConnecting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [tried, setTried] = useState<Tried>();
  const [removing, setRemoving] = useState(false);
  const nowMs = useNow(true, 60_000);
  const test = async () => {
    setTesting(true);
    const t = await hubCall("onepassword_test", {}, { timeoutMs: TEST_MS }).then(
      (out): Tried => ({ test: out.test }),
      (e: unknown): Tried => ({ error: errorText(e) }),
    );
    setTesting(false);
    setTried(t);
    refetch(["onepassword_get"]);
  };
  const save = async () => {
    setBusy(true);
    setProblem(null);
    const out = await window.fleetd.secret.onePassword(hub, { token: value, boxes: machines.boxes }).catch((e: unknown) => ({ ok: false as const, problem: errorText(e) }));
    setBusy(false);
    if (!out.ok) {
      setProblem("problem" in out ? out.problem : errorText(new CallError(out.error)));
      return;
    }
    setValue("");
    setConnecting(false);
    refetch(["onepassword_get"]);
    await test();
  };
  const form = (
    <div className={s.connectForm}>
      <ol className={s.steps}>
        <li>
          <Text size="sm">Make a vault for fleetd with only the logins and card your agents may use.</Text>
        </li>
        <li>
          <Text size="sm">Make a service account that reads only that vault.</Text>
        </li>
        <li>
          <Text size="sm">
            Paste its token below. 1Password shows it once; it starts with <InlineCode>ops_</InlineCode>.
          </Text>
        </li>
      </ol>
      <div className={s.inline}>
        <Button size="sm" variant="ghost" onClick={() => void window.fleetd.openExternal(SERVICE_ACCOUNTS)}>
          1Password › Service accounts
        </Button>
      </div>
      <Field label="Token">
        <Input mono aria-label="Token" className={s.secretValue} data-secret="" value={value} disabled={busy} autoComplete="off" spellCheck={false} placeholder="ops_…" onChange={(e) => setValue(e.target.value)} />
      </Field>
      <div className={s.inline}>
        <Button variant="primary" disabled={busy || value.trim() === ""} onClick={() => void save()}>
          {busy ? "Saving…" : "Save and test"}
        </Button>
        <Button variant="ghost" disabled={busy} onClick={() => (setConnecting(false), setValue(""), setProblem(null))}>
          Cancel
        </Button>
      </div>
    </div>
  );
  const shown = tried ?? (token?.lastTest === undefined ? undefined : { test: token.lastTest });
  const verdict = shown === undefined ? null : "error" in shown ? { ok: false, text: shown.error } : vaultsLine(shown.test, nowMs);
  const failed = verdict !== null && !verdict.ok;
  const sealed = token === undefined ? "" : ` ${sealedLine(token.sealedOn)}.`;
  return (
    <SettingsRow
      reveal="onepassword.token"
      mark={token === undefined ? "off" : failed ? "needs" : "ready"}
      markLabel={token === undefined ? "1Password: not set up" : failed ? "1Password: needs a look" : "1Password: set up"}
      title="1Password"
      hint={`${hint} The token is kept encrypted on the hub's machines. A bot's own 1Password token wins over it.${sealed}`}
      line={
        testing ? (
          <span role="status">Testing…</span>
        ) : token === undefined ? (
          "Not set up"
        ) : failed ? (
          <span title={verdict.text}>
            <HubText>{"short" in verdict ? (verdict.short ?? verdict.text) : verdict.text}</HubText>
          </span>
        ) : verdict === null ? (
          "Service account"
        ) : (
          <HubText>{verdict.text.replace(/ \(.*\)\.$/u, "")}</HubText>
        )
      }
      lineTone={!testing && failed ? "warning" : "quiet"}
      control={
        token === undefined ? (
          connecting ? undefined : (
            <Button size="sm" onClick={() => setConnecting(true)}>
              Set up
            </Button>
          )
        ) : (
          <RowMenu
            label="1Password"
            disabled={testing}
            items={[
              { label: "Test", onSelect: () => void test() },
              { label: "Replace token", onSelect: () => setConnecting(true) },
              { label: "Remove", onSelect: () => setRemoving(true), danger: true },
            ]}
          />
        )
      }
    >
      {token === undefined ? null : <MissingOn sealedOn={token.sealedOn} machines={machines.ids} there="agents there fill no logins with it" />}
      {connecting ? form : null}
      <Problem text={problem} />
      {removing ? (
        <ConfirmRemove
          title="Remove your 1Password token?"
          description="Each machine forgets it. Agents started from then on fill logins only where their bot has its own OP_SERVICE_ACCOUNT_TOKEN."
          action="Remove"
          onRemove={() => hubCall("onepassword_remove", {}).then(() => (setTried(undefined), refetch(["onepassword_get"])))}
          onClose={() => setRemoving(false)}
        />
      ) : null}
    </SettingsRow>
  );
}

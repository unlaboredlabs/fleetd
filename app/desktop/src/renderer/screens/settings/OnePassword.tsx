// Settings › Your accounts › 1Password (D235): the person's own 1Password service account token, which fill_credential
// uses in the orders they start and in their Only-me projects when the project has no OP_SERVICE_ACCOUNT_TOKEN of its
// own (that one wins). Pasted once: main seals it to every machine, and the page never gets it back. Test lists the
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
import { ConfirmRemove, MissingOn, Problem, TestButton, useMachines } from "./claudeParts";
import { errorText, useHubCall, useLive, useRefetch } from "./hub";
import { GroupNote, SettingsRow, SettingsSection } from "./parts";
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
export function vaultsLine(test: OnePasswordTest, nowMs: number): { ok: boolean; text: string } {
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
    text: `Reads ${list} (${at}): an agent on a machine holding it could read every item in each. Make a service account that reads only fleetd's vault, paste its token here, and revoke this one in 1Password.`,
  };
}

/** On a hub with a vault, 1Password is only where items come from (vault-design §6): fills use the vault. */
const IMPORT_INTRO =
  "Optional: a place to import logins, cards and addresses from into your vault. Agents fill from the vault, never from 1Password; your leads can search it and offer you items to import.";

export function OnePasswordSettings() {
  const live = useLive();
  const vault = useData((st) => vaultServed(st.features));
  const read = useToolQuery("onepassword_get", noInput, { enabled: live });
  return (
    <SettingsSection
      title="1Password"
      reveal="onepassword"
      hint={
        vault
          ? IMPORT_INTRO
          : "The logins your agents sign in to sites with, in the orders you start and your Only-me projects. They name a 1Password item and fleetd types the value in; no agent ever sees it."
      }
    >
      {!live ? (
        <GroupNote>Not connected. Connect to a hub to set up 1Password.</GroupNote>
      ) : read.error instanceof CallError && lacksTool(read.error.error) ? (
        <GroupNote>This hub reads 1Password only with a project&apos;s OP_SERVICE_ACCOUNT_TOKEN variable. Update fleetd on the hub to save your own.</GroupNote>
      ) : read.error instanceof CallError && read.error.error.code === "forbidden" ? (
        <GroupNote>This device&apos;s key belongs to no person, so it has no 1Password of its own. Pair the app as yourself to set it up.</GroupNote>
      ) : read.isLoadingError ? (
        <GroupNote tone="danger">{errorText(read.error)}</GroupNote>
      ) : read.data === undefined ? (
        <GroupNote>Loading…</GroupNote>
      ) : (
        <ServiceAccount token={read.data.token} />
      )}
    </SettingsSection>
  );
}

function ServiceAccount({ token }: { token: OnePasswordToken | undefined }) {
  const machines = useMachines();
  const hubCall = useHubCall();
  const refetch = useRefetch();
  const { hub } = useDataLayer();
  const [value, setValue] = useState("");
  const [replacing, setReplacing] = useState(false);
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
    setReplacing(false);
    refetch(["onepassword_get"]);
    await test();
  };
  const form = (
    <>
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
      {/* Save shows once there is a token to save. */}
      {value.trim() === "" && !busy && !replacing ? null : (
        <div className={s.inline}>
          {value.trim() === "" && !busy ? null : (
            <Button variant="primary" disabled={busy} onClick={() => void save()}>
              {busy ? "Saving…" : "Save and test"}
            </Button>
          )}
          {replacing ? (
            <Button variant="ghost" disabled={busy} onClick={() => (setReplacing(false), setValue(""), setProblem(null))}>
              Cancel
            </Button>
          ) : null}
        </div>
      )}
    </>
  );
  const help = "The token is kept encrypted on the hub's machines. A project's own 1Password token wins over it.";
  const shown = tried ?? (token?.lastTest === undefined ? undefined : { test: token.lastTest });
  const verdict = shown === undefined ? null : "error" in shown ? { ok: false, text: shown.error } : vaultsLine(shown.test, nowMs);
  return (
    <SettingsRow
      reveal="onepassword.token"
      title="Service account"
      hint={help}
      line={token === undefined ? null : sealedLine(token.sealedOn)}
      control={
        token === undefined ? undefined : (
          <>
            <TestButton testing={testing} onTest={() => void test()} />
            {replacing ? null : (
              <Button size="sm" variant="ghost" onClick={() => setReplacing(true)}>
                Replace
              </Button>
            )}
            <Button size="sm" variant="ghost" onClick={() => setRemoving(true)}>
              Remove
            </Button>
          </>
        )
      }
    >
      {token === undefined ? (
        form
      ) : (
        <>
          <MissingOn sealedOn={token.sealedOn} machines={machines.ids} there="agents there fill no logins with it" />
          {verdict === null ? null : (
            <div role={verdict.ok ? "status" : "alert"}>
              <Text size="sm" tone={verdict.ok ? "quiet" : "danger"}>
                <HubText>{verdict.text}</HubText>
              </Text>
            </div>
          )}
          {replacing ? form : null}
        </>
      )}
      <Problem text={problem} />
      {removing ? (
        <ConfirmRemove
          title="Remove your 1Password token?"
          description="Each machine forgets it. Agents started from then on fill logins only where their project has its own OP_SERVICE_ACCOUNT_TOKEN."
          action="Remove"
          onRemove={() => hubCall("onepassword_remove", {}).then(() => (setTried(undefined), refetch(["onepassword_get"])))}
          onClose={() => setRemoving(false)}
        />
      ) : null}
    </SettingsRow>
  );
}

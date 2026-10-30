// Settings › Your accounts › 1Password (D235): the person's own 1Password service account token, which fill_credential
// uses in the orders they start and in their Navi when the project has no OP_SERVICE_ACCOUNT_TOKEN of its own (that one
// wins). Pasted once: main seals it to every machine, and the page never gets it back. Test lists the vaults it reads.
import { useState } from "react";
import type { OnePasswordTest, OnePasswordToken } from "../../../shared/contracts";
import { lacksTool } from "../../src/data/errors";
import { CallError } from "../../src/data/queries";
import { useDataLayer, useToolQuery } from "../../src/data/react";
import { useNow } from "../live";
import { HubText } from "../projects/HubText";
import { when } from "../status/view";
import { Button, Field, InlineCode, Input, Text } from "../../ui";
import { sealedLine } from "./claudeModel";
import { ConfirmRemove, MissingOn, Problem, TestButton, useMachines } from "./claudeParts";
import { errorText, useHubCall, useLive, useRefetch } from "./hub";
import { PagePart, Setting } from "./parts";
import s from "./settings.module.css";

/** 1Password's guide to making a service account. */
export const SERVICE_ACCOUNTS = "https://developer.1password.com/docs/service-accounts/get-started/";
/** The node may install the 1Password SDK on its first Test (up to 3 minutes), then asks 1Password. */
const TEST_MS = 240_000;

const noInput = {};

type Tried = { readonly test: OnePasswordTest } | { readonly error: string };

/** A Test's verdict: "Reads Agents and Shared (on devbox, today 14:02)." or 1Password's words, the token masked. */
export function vaultsLine(test: OnePasswordTest, nowMs: number): { ok: boolean; text: string } {
  const at = `on ${test.machineId}, ${when(test.at, nowMs)}`;
  if (!test.ok) {
    const said = (test.error ?? "1Password said nothing").trim().replace(/\.$/u, "");
    return { ok: false, text: `Failed ${at}: ${said}.` };
  }
  const names = test.vaults ?? [];
  if (names.length === 0) return { ok: false, text: `It reads no vault (${at}). Give the service account access to the vault with your logins.` };
  const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  return { ok: true, text: `Reads ${list ?? ""} (${at}).` };
}

export function OnePasswordSettings() {
  const live = useLive();
  const read = useToolQuery("onepassword_get", noInput, { enabled: live });
  return (
    <PagePart
      title="1Password"
      reveal="onepassword"
      intro="The logins your agents sign in to sites with, in the orders you start and your Navi. They name a 1Password item and fleetd types the value in; no agent ever sees it."
    >
      {!live ? (
        <Text tone="quiet">Not connected. Connect to a hub to set up 1Password.</Text>
      ) : read.error instanceof CallError && lacksTool(read.error.error) ? (
        <Text tone="quiet">This hub reads 1Password only with a project&apos;s OP_SERVICE_ACCOUNT_TOKEN variable. Update fleetd on the hub to save your own.</Text>
      ) : read.error instanceof CallError && read.error.error.code === "forbidden" ? (
        <Text tone="quiet">This device&apos;s key belongs to no person, so it has no 1Password of its own. Pair the app as yourself to set it up.</Text>
      ) : read.isLoadingError ? (
        <Text tone="danger">{errorText(read.error)}</Text>
      ) : read.data === undefined ? (
        <Text tone="quiet">Loading…</Text>
      ) : (
        <ServiceAccount token={read.data.token} />
      )}
    </PagePart>
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
          <Text size="sm">In 1Password, make a service account that can read the vault with your agents&apos; logins. Read access is enough.</Text>
        </li>
        <li>
          <Text size="sm">Give each login item its website: agents fill a login only on that site.</Text>
        </li>
        <li>
          <Text size="sm">
            Paste the service account&apos;s token below. It starts with <InlineCode>ops_</InlineCode>.
          </Text>
        </li>
      </ol>
      <div className={s.inline}>
        <Button size="sm" variant="ghost" onClick={() => void window.fleetd.openExternal(SERVICE_ACCOUNTS)}>
          1Password › Service accounts
        </Button>
      </div>
      <Field label="Token" description="Shown once in 1Password when you make the service account.">
        <Input mono aria-label="Token" className={s.secretValue} data-secret="" value={value} disabled={busy} autoComplete="off" spellCheck={false} placeholder="ops_…" onChange={(e) => setValue(e.target.value)} />
      </Field>
      <div className={s.inline}>
        <Button variant="primary" disabled={busy || value.trim() === ""} onClick={() => void save()}>
          {busy ? "Saving…" : "Save and test"}
        </Button>
        {replacing ? (
          <Button variant="ghost" disabled={busy} onClick={() => (setReplacing(false), setValue(""), setProblem(null))}>
            Cancel
          </Button>
        ) : null}
      </div>
    </>
  );
  const shown = tried ?? (token?.lastTest === undefined ? undefined : { test: token.lastTest });
  const verdict = shown === undefined ? null : "error" in shown ? { ok: false, text: shown.error } : vaultsLine(shown.test, nowMs);
  return (
    <Setting
      reveal="onepassword.token"
      label="Service account"
      help="Sealed on this computer to the hub's machines: fleetd never shows it again, and no agent sees it. A project's own OP_SERVICE_ACCOUNT_TOKEN variable wins over it."
    >
      {token === undefined ? (
        form
      ) : (
        <>
          <div className={s.inline}>
            <Text size="sm">{`Saved. ${sealedLine(token.sealedOn)}`}</Text>
            <TestButton testing={testing} onTest={() => void test()} />
            {replacing ? null : (
              <Button size="sm" variant="ghost" onClick={() => setReplacing(true)}>
                Replace
              </Button>
            )}
            <Button size="sm" variant="ghost" onClick={() => setRemoving(true)}>
              Remove
            </Button>
          </div>
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
    </Setting>
  );
}

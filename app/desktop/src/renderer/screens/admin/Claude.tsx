// Settings › Hub accounts › Claude (teams step 8, D200): the hub's API configuration (its Claude API key, sealed in main to
// every machine and never shown back, and an optional endpoint), with Test, and a line under it on what leads and
// automations run on (the key, else the hub owner's own subscription); whether members may run their work on it (on by
// default). Each person's account, with any usage pause on it, is on their People row; their own choice and
// subscription are theirs, in Settings › Your accounts › Claude.
import { useState, type ReactNode } from "react";
import type { ClaudeAccountsGetOutput, ClaudeHubApi, Person, UsageStatus } from "../../../shared/contracts";
import { lacksTool } from "../../src/data/errors";
import { CallError } from "../../src/data/queries";
import { useToolQuery } from "../../src/data/react";
import { useNow } from "../live";
import { HubText } from "../projects/HubText";
import { Button, Field, Input, Text } from "../../ui";
import { CONSOLE_KEYS, KEY_PLACEHOLDER, pauseLine, runsOnLine, sealedLine } from "../settings/claudeModel";
import { ConfirmRemove, MissingOn, Problem, TestButton, TestResult, useMachines, useSave, useTest, type Tried } from "../settings/claudeParts";
import { errorText, useHubCall, useLive, useRefetch } from "../settings/hub";
import { GroupNote, SettingsRow, SettingsSection, SwitchRow } from "../settings/parts";
import { toHash } from "../shell/routes";
import { usePeople } from "./usePeople";
import s from "../settings/settings.module.css";

const noInput = {};

export function ClaudeAdmin({ me }: { me: Person | undefined }) {
  const live = useLive();
  const read = useToolQuery("claude_accounts_get", noInput, { enabled: live });
  const usage = useToolQuery("usage_status", noInput, { enabled: live });
  return (
    <SettingsSection
      title="Claude"
      reveal="admin.claude"
      hint="The hub's Claude API key, and who may use it. Each person picks their own in You › Your accounts."
    >
      {!live ? (
        <GroupNote>Connect to a hub to see and change this.</GroupNote>
      ) : read.error instanceof CallError && lacksTool(read.error.error) ? (
        <GroupNote>This hub runs every agent on each machine&apos;s own Claude login. Update fleetd on the hub to give it an API key.</GroupNote>
      ) : read.isLoadingError ? (
        <GroupNote tone="danger">{`Couldn't read the hub's Claude accounts: ${errorText(read.error)}`}</GroupNote>
      ) : read.data === undefined ? (
        <GroupNote>Loading…</GroupNote>
      ) : (
        <Accounts data={read.data} usage={usage.data?.machines ?? []} me={me} />
      )}
    </SettingsSection>
  );
}

function Accounts({ data, usage, me }: { data: ClaudeAccountsGetOutput; usage: ReadonlyArray<UsageStatus>; me: Person | undefined }) {
  const nowMs = useNow(true, 60_000);
  const people = (data.people ?? []).map((p) => p.person);
  const hubPause = pauseLine({ kind: "hub" }, usage, nowMs);
  return (
    <>
      <HubKey api={data.hubApi} pause={hubPause}>
        <Owner data={data} usage={usage} me={me} nowMs={nowMs} runsOn={runsOnLine(data.leadsRunOn, people, me?.personId)} />
      </HubKey>
      <Members on={data.settings.membersUseHubApi} hubApi={data.hubApi !== undefined} />
    </>
  );
}

function HubKey({ api, pause, children }: { api: ClaudeHubApi | undefined; pause: string | null; children: ReactNode }) {
  const machines = useMachines();
  const save = useSave();
  const test = useTest();
  const hubCall = useHubCall();
  const [editing, setEditing] = useState(false);
  const [key, setKey] = useState("");
  const [endpoint, setEndpoint] = useState(api?.endpoint ?? "");
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [tried, setTried] = useState<Tried>();
  const [removing, setRemoving] = useState(false);
  const nowMs = useNow(true, 60_000);
  const typedEndpoint = endpoint.trim();
  const changed = key.trim() !== "" || typedEndpoint !== (api?.endpoint ?? "");
  const submit = () => {
    setBusy(true);
    setProblem(null);
    void save({
      account: "hub_api",
      ...(key.trim() === "" ? {} : { key }),
      ...(typedEndpoint === "" ? {} : { endpoint: typedEndpoint }),
      boxes: machines.boxes,
    }).then((out) => {
      setBusy(false);
      if (!out.ok) {
        setProblem(out.problem);
        return;
      }
      setKey("");
      setEditing(false);
      // A save the hub took forgets the last Test of what it replaced: so does the screen, unless it tried the new one.
      setTried(out.tried ?? undefined);
    });
  };
  const runTest = () => {
    setTesting(true);
    void test("hub_api").then((t) => {
      setTesting(false);
      setTried(t);
    });
  };
  const open = editing || api === undefined;
  return (
    <SettingsRow
      title="Hub API key"
      hint="From the Claude Console. fleetd never shows it again, and no agent sees it."
      line={api === undefined ? null : `${sealedLine(api.sealedOn)}${api.endpoint === undefined ? "" : ` Through ${api.endpoint}.`}`}
      control={
        api === undefined ? undefined : (
          <>
            <TestButton testing={testing} onTest={runTest} />
            {editing ? null : (
              <Button size="sm" variant="ghost" onClick={() => (setEndpoint(api.endpoint ?? ""), setEditing(true))}>
                Change
              </Button>
            )}
            <Button size="sm" variant="ghost" onClick={() => setRemoving(true)}>
              Remove
            </Button>
          </>
        )
      }
    >
      {api === undefined ? null : (
        <>
          <MissingOn sealedOn={api.sealedOn} machines={machines.ids} />
          <TestResult tried={tried ?? (api.lastTest === undefined ? undefined : { test: api.lastTest })} nowMs={nowMs} />
          {pause === null ? null : (
            <Text size="sm" tone="warning">
              <HubText>{pause}</HubText>
            </Text>
          )}
        </>
      )}
      {open ? (
        <>
          <div className={s.inline}>
            <Button size="sm" variant="ghost" onClick={() => void window.fleetd.openExternal(CONSOLE_KEYS)}>
              Claude Console › API keys
            </Button>
          </div>
          <Field label="API key" description={api === undefined ? undefined : "Leave it empty to keep the saved key."}>
            <Input mono aria-label="API key" className={s.secretValue} data-secret="" value={key} disabled={busy} autoComplete="off" spellCheck={false} placeholder={KEY_PLACEHOLDER} onChange={(e) => setKey(e.target.value)} />
          </Field>
          <Field label="Endpoint (optional)" description="Only for a gateway or proxy.">
            <Input mono aria-label="Endpoint" value={endpoint} disabled={busy} autoComplete="off" spellCheck={false} placeholder="https://api.anthropic.com" onChange={(e) => setEndpoint(e.target.value)} />
          </Field>
          <div className={s.inline}>
            <Button variant="primary" disabled={busy || (api === undefined ? key.trim() === "" : !changed)} onClick={submit}>
              {busy ? "Saving…" : "Save and test"}
            </Button>
            {editing ? (
              <Button variant="ghost" disabled={busy} onClick={() => (setEditing(false), setKey(""), setProblem(null))}>
                Cancel
              </Button>
            ) : null}
            {busy || (api === undefined ? key.trim() !== "" : changed) ? null : (
              <Text size="sm" tone="quiet">
                {api === undefined ? "Paste a key to save it." : "Type a new key or endpoint to save it."}
              </Text>
            )}
          </div>
        </>
      ) : null}
      {children}
      <Problem text={problem} />
      {removing ? (
        <ConfirmRemove
          title="Remove the hub's API key?"
          description="Each machine forgets it. Leads and automations run on the hub owner's subscription from their next start, else each machine's own login; members who used the key connect their own subscription."
          action="Remove"
          onRemove={() => hubCall("claude_hub_api_remove", {})}
          onClose={() => setRemoving(false)}
        />
      ) : null}
    </SettingsRow>
  );
}

function Members({ on, hubApi }: { on: boolean; hubApi: boolean }) {
  const hubCall = useHubCall();
  const refetch = useRefetch();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const flip = (next: boolean) => {
    setBusy(true);
    setProblem(null);
    hubCall("claude_settings_set", { membersUseHubApi: next }).then(
      () => {
        setBusy(false);
        refetch(["claude_accounts_get", "setup_list"]);
      },
      (e: unknown) => {
        setBusy(false);
        setProblem(errorText(e));
      },
    );
  };
  return (
    <>
      <SwitchRow
        reveal="admin.claude.members"
        title="Members may use the hub's API key"
        hint="Off: each member connects their own subscription before their next order. Owners and admins always may."
        line={hubApi ? null : "Takes effect once the hub has a key."}
        checked={on}
        disabled={busy}
        onCheckedChange={flip}
      />
      {problem === null ? null : (
        <GroupNote tone="danger">
          <span role="alert">
            <HubText>{problem}</HubText>
          </span>
        </GroupNote>
      )}
    </>
  );
}

/**
 * Under the key, one quiet line: what leads and automations run on, the key, else the hub owner's own subscription.
 * Without a key, that subscription and its state follow; only the owner connects it, from Settings. A hub that has
 * nothing for them to run on says why instead.
 */
function Owner({ data, usage, me, nowMs, runsOn }: { data: ClaudeAccountsGetOutput; usage: ReadonlyArray<UsageStatus>; me: Person | undefined; nowMs: number; runsOn: string }) {
  const list = usePeople();
  const owner = list.data?.people.find((p) => p.role === "owner" && p.removedAt === undefined);
  const whose = owner === undefined ? "the hub owner's" : me?.personId === owner.personId ? "your" : `${owner.name}'s`;
  const lead = (
    <Text size="sm" tone="quiet" data-leads-run-on="">
      {`Leads and automations run on ${data.hubApi === undefined ? "the hub's key, once it has one" : "this key"}, else ${whose} subscription.`}
    </Text>
  );
  const refused =
    data.leadsRunOn.kind === "refused" ? (
      <Text size="sm" tone="warning">
        <HubText>{runsOn}</HubText>
      </Text>
    ) : null;
  if (owner === undefined || data.hubApi !== undefined)
    return (
      <>
        {lead}
        {refused}
      </>
    );
  const theirs = (data.people ?? []).find((p) => p.person.personId === owner.personId);
  const sub = theirs?.subscription;
  const you = me?.personId === owner.personId;
  const line = `The hub owner's subscription (${you ? "yours" : `${owner.name}'s`}) ${sub === undefined ? "isn't connected." : `is connected. ${sealedLine(sub.sealedOn)}`}`;
  // Their pause is on their row below; said here too only while leads run on it.
  const leadsOnIt = data.leadsRunOn.kind === "account" && data.leadsRunOn.account.kind === "person" && data.leadsRunOn.account.personId === owner.personId;
  const pause = theirs === undefined || !leadsOnIt ? null : pauseLine({ kind: "person", personId: owner.personId }, usage, nowMs);
  return (
    <div className={s.stack}>
      {lead}
      {refused}
      <Text size="sm" tone="quiet">
        {line}
      </Text>
      {sub?.lastTest === undefined ? null : <TestResult tried={{ test: sub.lastTest }} nowMs={nowMs} />}
      {pause === null ? null : (
        <Text size="sm" tone="warning">
          <HubText>{pause}</HubText>
        </Text>
      )}
      {you ? (
        <span>
          <Button size="sm" onClick={() => (window.location.hash = toHash({ id: "settings", tab: "accounts" }))}>
            {sub === undefined ? "Connect yours in Settings" : "Open Your accounts › Claude"}
          </Button>
        </span>
      ) : sub === undefined ? (
        <Text size="xs" tone="quiet">{`${owner.name} connects it in their own Settings › Your accounts › Claude.`}</Text>
      ) : null}
    </div>
  );
}


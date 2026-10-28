// Administration › Connections › Claude (teams step 8, D200): the hub's API configuration (its Claude API key, sealed in main to
// every machine and never shown back, and an optional endpoint), with Test; whether members may run their work on it
// (on by default); what projects' leads and work nobody started run on (the key, else the hub owner's own
// subscription); and each person's account, with any usage pause on it. A person's own choice and subscription are
// theirs, in Settings › Connections › Claude.
import { useState } from "react";
import type { ClaudeAccountsGetOutput, ClaudeHubApi, Person, PersonClaude, UsageStatus } from "../../../shared/contracts";
import { lacksTool } from "../../src/data/errors";
import { CallError } from "../../src/data/queries";
import { useToolQuery } from "../../src/data/react";
import { useNow } from "../live";
import { HubText } from "../projects/HubText";
import { Button, Field, Input, Switch, Text } from "../../ui";
import { CONSOLE_KEYS, KEY_PLACEHOLDER, pauseLine, runsOnLine, sealedLine, theirRunsOn } from "../settings/claudeModel";
import { ConfirmRemove, MissingOn, Problem, TestButton, TestResult, useMachines, useSave, useTest, type Tried } from "../settings/claudeParts";
import { errorText, useHubCall, useLive, useRefetch } from "../settings/hub";
import { PagePart, Setting } from "../settings/parts";
import { toHash } from "../shell/routes";
import { usePeople } from "./usePeople";
import s from "../settings/settings.module.css";
import a from "./admin.module.css";

const noInput = {};

export function ClaudeAdmin({ me }: { me: Person | undefined }) {
  const live = useLive();
  const read = useToolQuery("claude_accounts_get", noInput, { enabled: live });
  const usage = useToolQuery("usage_status", noInput, { enabled: live });
  return (
    <PagePart
      title="Claude"
      reveal="admin.claude"
      intro="The hub's Claude API key, which projects' leads and work nobody asked for run on, and who else may use it. Each person picks their own account in Settings › Connections › Claude."
    >
      {!live ? (
        <Text tone="quiet">Connect to a hub to see and change this.</Text>
      ) : read.error instanceof CallError && lacksTool(read.error.error) ? (
        <Text tone="quiet">This hub runs every agent on each machine&apos;s own Claude login. Update fleetd on the hub to give it an API key.</Text>
      ) : read.isLoadingError ? (
        <Text tone="danger">{`Couldn't read the hub's Claude accounts: ${errorText(read.error)}`}</Text>
      ) : read.data === undefined ? (
        <Text tone="quiet">Loading…</Text>
      ) : (
        <Accounts data={read.data} usage={usage.data?.machines ?? []} me={me} />
      )}
    </PagePart>
  );
}

function Accounts({ data, usage, me }: { data: ClaudeAccountsGetOutput; usage: ReadonlyArray<UsageStatus>; me: Person | undefined }) {
  const nowMs = useNow(true, 60_000);
  const people = (data.people ?? []).map((p) => p.person);
  const hubPause = pauseLine({ kind: "hub" }, usage, nowMs);
  return (
    <>
      <HubKey api={data.hubApi} pause={hubPause} />
      <Members on={data.settings.membersUseHubApi} hubApi={data.hubApi !== undefined} />
      <Setting reveal="admin.claude.leads" label="Leads and unrequested work" help="Projects' leads serve everyone, as do automations and train fixes: they run on the hub's key, else the hub owner's subscription, never a member's.">
        <Text>
          <HubText>{runsOnLine(data.leadsRunOn, people, me?.personId)}</HubText>
        </Text>
        <Owner data={data} usage={usage} me={me} nowMs={nowMs} />
      </Setting>
      <Setting reveal="admin.claude.people" label="Everyone's account" help="What the orders each person starts, and their Navi, run on. One person's usage limit pauses only their own work.">
        <div className={a.list} role="list" aria-label="Claude accounts">
          {(data.people ?? []).map((p) => (
            <PersonLine key={p.person.personId} p={p} usage={usage} me={me} nowMs={nowMs} />
          ))}
        </div>
      </Setting>
    </>
  );
}

function HubKey({ api, pause }: { api: ClaudeHubApi | undefined; pause: string | null }) {
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
      if (out.tried !== null) setTried(out.tried);
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
    <Setting
      reveal="admin.claude.key"
      label="Hub API key"
      help="From the Claude Console, billed to that account. It is sealed on this computer to every machine: fleetd never shows it again, and no agent sees it."
    >
      {api === undefined ? null : (
        <>
          <div className={s.inline}>
            <Text size="sm">{`Saved. ${sealedLine(api.sealedOn)}${api.endpoint === undefined ? "" : ` Through ${api.endpoint}.`}`}</Text>
            <TestButton testing={testing} onTest={runTest} />
            {editing ? null : (
              <Button size="sm" variant="ghost" onClick={() => (setEndpoint(api.endpoint ?? ""), setEditing(true))}>
                Change
              </Button>
            )}
            <Button size="sm" variant="ghost" onClick={() => setRemoving(true)}>
              Remove
            </Button>
          </div>
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
          {api === undefined ? (
            <Text size="sm" tone="quiet">
              Without one, leads run on the hub owner&apos;s own subscription, and each person connects theirs.
            </Text>
          ) : null}
          <div className={s.inline}>
            <Button size="sm" variant="ghost" onClick={() => void window.fleetd.openExternal(CONSOLE_KEYS)}>
              Claude Console › API keys
            </Button>
          </div>
          <Field label="API key" description={api === undefined ? "ANTHROPIC_API_KEY." : "Leave it empty to keep the saved key."}>
            <Input mono aria-label="API key" className={s.secretValue} data-secret="" value={key} disabled={busy} autoComplete="off" spellCheck={false} placeholder={KEY_PLACEHOLDER} onChange={(e) => setKey(e.target.value)} />
          </Field>
          <Field label="Endpoint (optional)" description="ANTHROPIC_BASE_URL, for a gateway or proxy. Empty: Anthropic's own.">
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
          </div>
        </>
      ) : null}
      <Problem text={problem} />
      {removing ? (
        <ConfirmRemove
          title="Remove the hub's API key?"
          description="Each machine forgets it. Leads and unrequested work run on the hub owner's subscription from their next start, else each machine's own login; members who used the key connect their own subscription."
          action="Remove"
          onRemove={() => hubCall("claude_hub_api_remove", {})}
          onClose={() => setRemoving(false)}
        />
      ) : null}
    </Setting>
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
    <Setting reveal="admin.claude.members" label="Members" help="Owners and admins may always use the hub's key. It never changes what leads and unrequested work run on.">
      <Switch
        label="Members may use the hub's API key"
        description={hubApi ? "Off: each member connects their own subscription before their next order." : "Takes effect once the hub has a key."}
        checked={on}
        disabled={busy}
        onCheckedChange={flip}
      />
      <Problem text={problem} />
    </Setting>
  );
}

/** The hub owner's own subscription, which leads fall back to without a key. Only the owner connects it, from Settings. */
function Owner({ data, usage, me, nowMs }: { data: ClaudeAccountsGetOutput; usage: ReadonlyArray<UsageStatus>; me: Person | undefined; nowMs: number }) {
  const list = usePeople();
  const owner = list.data?.people.find((p) => p.role === "owner" && p.removedAt === undefined);
  if (owner === undefined) return null;
  const theirs = (data.people ?? []).find((p) => p.person.personId === owner.personId);
  const sub = theirs?.subscription;
  const you = me?.personId === owner.personId;
  const line = `The hub owner's subscription (${you ? "yours" : `${owner.name}'s`}) ${sub === undefined ? "isn't connected." : `is connected. ${sealedLine(sub.sealedOn)}`}`;
  // Their pause is on their row below; said here too only while leads run on it.
  const leadsOnIt = data.leadsRunOn.kind === "account" && data.leadsRunOn.account.kind === "person" && data.leadsRunOn.account.personId === owner.personId;
  const pause = theirs === undefined || !leadsOnIt ? null : pauseLine({ kind: "person", personId: owner.personId }, usage, nowMs);
  return (
    <div className={s.stack}>
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
          <Button size="sm" onClick={() => (window.location.hash = toHash({ id: "settings", tab: "connections" }))}>
            {sub === undefined ? "Connect yours in Settings" : "Open Settings › Connections › Claude"}
          </Button>
        </span>
      ) : sub === undefined ? (
        <Text size="xs" tone="quiet">{`${owner.name} connects it in their own Settings › Connections › Claude.`}</Text>
      ) : null}
    </div>
  );
}

function PersonLine({ p, usage, me, nowMs }: { p: PersonClaude; usage: ReadonlyArray<UsageStatus>; me: Person | undefined; nowMs: number }) {
  const you = p.person.personId === me?.personId;
  const pause = pauseLine({ kind: "person", personId: p.person.personId }, usage, nowMs);
  const sub = p.subscription === undefined ? "No subscription connected." : p.subscription.lastTest?.ok === false ? "Subscription connected; its last Test failed." : "Subscription connected.";
  return (
    <div className={a.row} role="listitem" aria-label={p.person.name}>
      <div className={a.who}>
        <div className={a.name}>
          <Text strong>{p.person.name}</Text>
          {you ? (
            <Text size="xs" tone="quiet">
              you
            </Text>
          ) : null}
        </div>
        <Text size="xs" tone="quiet">
          {sub}
        </Text>
        {pause === null ? null : (
          <Text size="xs" tone="warning">
            <HubText>{pause}</HubText>
          </Text>
        )}
      </div>
      <div className={a.controls}>
        <Text size="sm" tone={p.runsOn.kind === "refused" ? "warning" : "quiet"}>
          {theirRunsOn(p.runsOn)}
        </Text>
      </div>
    </div>
  );
}

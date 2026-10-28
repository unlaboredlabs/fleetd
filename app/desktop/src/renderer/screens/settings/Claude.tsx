// Settings › Claude: which Claude account the orders a person starts, and their Navi, run on (teams step 8, D200).
// Their own subscription, connected here with the long-lived token `claude setup-token` prints (main seals it to
// every machine; the page never gets it back), or the hub's API key when an admin set one up and lets them use it.
// The hub's own key and who may use it are Administration's (admin/Claude.tsx), never here.
import { useState } from "react";
import type { ClaudeAccountsGetOutput, ClaudeChoice, PersonClaude } from "../../../shared/contracts";
import { lacksTool } from "../../src/data/errors";
import { CallError } from "../../src/data/queries";
import { useToolQuery } from "../../src/data/react";
import { useNow } from "../live";
import { HubText } from "../projects/HubText";
import { Button, Field, InlineCode, Input, Radio, RadioGroup, Text } from "../../ui";
import { CONNECT, runsOnLine, sealedLine, SETUP_TOKEN, shownChoice, TOKEN_PLACEHOLDER } from "./claudeModel";
import { ConfirmRemove, MissingOn, Problem, TestButton, TestResult, useMachines, useSave, useTest, type Tried } from "./claudeParts";
import { errorText, useHubCall, useLive, useRefetch } from "./hub";
import { PageHead, Setting } from "./parts";
import s from "./settings.module.css";

const noInput = {};

export function ClaudeSettings() {
  const live = useLive();
  const read = useToolQuery("claude_accounts_get", noInput, { enabled: live });
  return (
    <div className={s.scroll} data-screen="settings.claude">
      <div className={s.column}>
        <PageHead title="Claude">Which Claude account the orders you start and your Navi run on. Nobody else's work ever runs on your subscription.</PageHead>
        {!live ? (
          <Text tone="quiet">Not connected. Connect to a hub to choose your Claude account.</Text>
        ) : read.error instanceof CallError && lacksTool(read.error.error) ? (
          <Text tone="quiet">This hub runs every agent on each machine&apos;s own Claude login. Update fleetd on the hub to choose your own account.</Text>
        ) : read.isLoadingError ? (
          <Text tone="danger">{errorText(read.error)}</Text>
        ) : read.data === undefined ? (
          <Text tone="quiet">Loading…</Text>
        ) : read.data.me === undefined ? (
          <Text tone="quiet">This device&apos;s key belongs to no person, so it has no Claude account of its own. Pair the app as yourself to choose one.</Text>
        ) : (
          <Mine data={read.data} me={read.data.me} />
        )}
      </div>
    </div>
  );
}

function Mine({ data, me }: { data: ClaudeAccountsGetOutput; me: PersonClaude }) {
  const people = [me.person];
  const refused = me.runsOn.kind === "refused" ? me.runsOn : null;
  return (
    <>
      <Setting reveal="claude.in-use" label="In use" help="What the agents of the orders you start, and your Navi, run on from their next start.">
        {refused === null ? (
          <Text>
          <HubText>{runsOnLine(me.runsOn, people, me.person.personId)}</HubText>
        </Text>
        ) : (
          <div className={s.notice} role="status">
            <div className={s.stack}>
              <Text strong>{CONNECT}</Text>
              <Text size="sm" tone="quiet">
                <HubText>{refused.fix}</HubText>
              </Text>
            </div>
          </div>
        )}
      </Setting>
      <Choice me={me} hubApi={data.hubApi !== undefined} />
      <Subscription me={me} />
    </>
  );
}

function Choice({ me, hubApi }: { me: PersonClaude; hubApi: boolean }) {
  const hubCall = useHubCall();
  const refetch = useRefetch();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const shown = shownChoice(me);
  // The hub's API is an option only when the admin set it up and lets this person use it; one chosen before the
  // admin turned it off stays shown, so they see why it no longer runs.
  const offer = me.mayUseHubApi || me.choice === "hub_api";
  if (!offer) {
    return (
      <Setting reveal="claude.choice" label="Runs on" help="Only your own subscription, on this hub.">
        <Text size="sm" tone="quiet">
          {hubApi ? "This hub's admins keep its API key for leads and unrequested work, so your work runs on your own subscription." : "This hub has no API key, so your work runs on your own subscription."}
        </Text>
      </Setting>
    );
  }
  const pick = (v: string) => {
    const choice: ClaudeChoice = v === "hub_api" ? "hub_api" : "subscription";
    setBusy(true);
    setProblem(null);
    hubCall("claude_choice_set", { choice }).then(
      () => {
        setBusy(false);
        refetch(["claude_accounts_get"]);
      },
      (e: unknown) => {
        setBusy(false);
        setProblem(errorText(e));
      },
    );
  };
  return (
    <Setting reveal="claude.choice" label="Runs on" help="Switch any time: agents started from then on use it; a running one keeps its account.">
      <RadioGroup className={s.radios} value={shown ?? ""} onValueChange={pick} disabled={busy} aria-label="Runs on">
        <Radio
          value="subscription"
          label="My own Claude subscription"
          description={me.subscription === undefined ? "Connect it below first." : "Your plan's limits; only your work runs on it."}
        />
        <Radio
          value="hub_api"
          label="The hub's API key"
          disabled={!me.mayUseHubApi}
          description={me.mayUseHubApi ? "Billed to the hub's Claude account." : "The hub's admins turned this off for members."}
        />
      </RadioGroup>
      <Problem text={problem} />
    </Setting>
  );
}

function Subscription({ me }: { me: PersonClaude }) {
  const machines = useMachines();
  const save = useSave();
  const test = useTest();
  const hubCall = useHubCall();
  const [token, setToken] = useState("");
  const [replacing, setReplacing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [tried, setTried] = useState<Tried>();
  const [removing, setRemoving] = useState(false);
  const sub = me.subscription;
  const nowMs = useNow(true, 60_000);
  const connect = () => {
    setBusy(true);
    setProblem(null);
    void save({ account: "mine", token, boxes: machines.boxes }).then((out) => {
      setBusy(false);
      if (!out.ok) {
        setProblem(out.problem);
        return;
      }
      setToken("");
      setReplacing(false);
      if (out.tried !== null) setTried(out.tried);
    });
  };
  const runTest = () => {
    setTesting(true);
    void test("mine").then((t) => {
      setTesting(false);
      setTried(t);
    });
  };
  const help = "A long-lived token from your own Claude account. It is sealed on this computer to the hub's machines: fleetd never shows it again, and no agent sees it.";
  const form = (
    <>
      <ol className={s.steps}>
        <li>
          <Text size="sm">
            On any computer with Claude Code, run <InlineCode>{SETUP_TOKEN}</InlineCode> and sign in with the Claude account you want your work to use.
          </Text>
        </li>
        <li>
          <Text size="sm">Paste the token it prints below.</Text>
        </li>
      </ol>
      <Field label="Token" description="CLAUDE_CODE_OAUTH_TOKEN. Valid for a year; run the command again to replace it.">
        <Input mono aria-label="Token" className={s.secretValue} data-secret="" value={token} disabled={busy} autoComplete="off" spellCheck={false} placeholder={TOKEN_PLACEHOLDER} onChange={(e) => setToken(e.target.value)} />
      </Field>
      <div className={s.inline}>
        <Button variant="primary" disabled={busy || token.trim() === ""} onClick={connect}>
          {busy ? "Connecting…" : "Connect and test"}
        </Button>
        {replacing ? (
          <Button variant="ghost" disabled={busy} onClick={() => (setReplacing(false), setToken(""), setProblem(null))}>
            Cancel
          </Button>
        ) : null}
      </div>
    </>
  );
  return (
    <Setting reveal="claude.subscription" label="Your subscription" help={help}>
      {sub === undefined ? (
        form
      ) : (
        <>
          <div className={s.inline}>
            <Text size="sm">{`Connected. ${sealedLine(sub.sealedOn)}`}</Text>
            <TestButton testing={testing} onTest={runTest} />
            {replacing ? null : (
              <Button size="sm" variant="ghost" onClick={() => setReplacing(true)}>
                Replace
              </Button>
            )}
            <Button size="sm" variant="ghost" onClick={() => setRemoving(true)}>
              Disconnect
            </Button>
          </div>
          <MissingOn sealedOn={sub.sealedOn} machines={machines.ids} />
          <TestResult tried={tried ?? (sub.lastTest === undefined ? undefined : { test: sub.lastTest })} nowMs={nowMs} />
          {replacing ? form : null}
        </>
      )}
      <Problem text={problem} />
      {removing ? (
        <ConfirmRemove
          title="Disconnect your subscription?"
          description="Each machine forgets the token. Agents started from then on run on the hub's API key if you may use it; otherwise you connect again before your next order."
          action="Disconnect"
          onRemove={() => hubCall("claude_subscription_remove", {})}
          onClose={() => setRemoving(false)}
        />
      ) : null}
    </Setting>
  );
}

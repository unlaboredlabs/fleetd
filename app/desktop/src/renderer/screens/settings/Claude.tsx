// Settings › Accounts › Claude: which Claude account the orders a person starts, and their own projects' leads, run on (teams step 8, D200).
// Their own subscription, connected here with the long-lived token `claude setup-token` prints (main seals it to
// every machine; the page never gets it back), or the hub's API key when an admin set one up and lets them use it.
// The hub's own key and who may use it are the Hub group's (admin/Claude.tsx), never here.
import { useState } from "react";
import type { ClaudeAccountsGetOutput, ClaudeChoice, PersonClaude } from "../../../shared/contracts";
import { lacksTool } from "../../src/data/errors";
import { CallError } from "../../src/data/queries";
import { useHub, useToolQuery } from "../../src/data/react";
import { useNow } from "../live";
import { HubText } from "../projects/HubText";
import { Button, Field, InlineCode, SecretInput, Segmented, Text } from "../../ui";
import { CONNECT, runsOnLine, sealedLine, SETUP_TOKEN, shownChoice, TOKEN_PLACEHOLDER } from "./claudeModel";
import { ConfirmRemove, MissingOn, Problem, TestResult, useMachines, useNoMachine, useSave, useTest, type Tried } from "./claudeParts";
import { errorText, useHubCall, useLive, useRefetch } from "./hub";
import { Notice, RowMenu, SettingsRow } from "./parts";
import s from "./settings.module.css";

const noInput = {};

const HINT = "What the agents of the orders you start run on from their next start. Nobody else's work uses it.";

/** Claude, as one row of Your accounts: its state as a dot and one line, its actions behind its "…". */
export function ClaudeSettings() {
  const live = useLive();
  const read = useToolQuery("claude_accounts_get", noInput, { enabled: live });
  const note = (line: string, tone: "quiet" | "danger" = "quiet") => <SettingsRow reveal="claude" mark="off" title="Claude" hint={HINT} line={line} lineTone={tone} />;
  if (!live) return note("Not connected. Connect to a workspace to choose your Claude account.");
  if (read.error instanceof CallError && lacksTool(read.error.error)) return note("This workspace runs every agent on each machine's own Claude login. Update fleetd on the workspace to choose your own account.");
  if (read.isLoadingError) return note(errorText(read.error), "danger");
  if (read.data === undefined) return note("Loading…");
  if (read.data.me === undefined) return note("This device's key belongs to no person. Pair the app as yourself to choose one.");
  return <Mine data={read.data} me={read.data.me} />;
}

/**
 * The hub's API is an option (Runs on) only when the admin set it up and lets this person use it; one chosen before the
 * admin turned it off stays shown, so they see why it no longer runs.
 */
function Mine({ data, me }: { data: ClaudeAccountsGetOutput; me: PersonClaude }) {
  const machines = useMachines();
  const noMachine = useNoMachine();
  const team = useHub().cloud === true;
  const save = useSave();
  const test = useTest();
  const hubCall = useHubCall();
  const [token, setToken] = useState("");
  const [connecting, setConnecting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [tried, setTried] = useState<Tried>();
  const [removing, setRemoving] = useState(false);
  const nowMs = useNow(true, 60_000);
  const sub = me.subscription;
  const refused = me.runsOn.kind === "refused" ? me.runsOn : null;
  // Nothing to run on: refused, or a machine's own login on a team with no machine.
  const none = refused !== null || (me.runsOn.kind === "machine_login" && noMachine);
  // Runs on shows only when there is a choice; without one, the hint says why the hub's key isn't offered.
  const offer = me.mayUseHubApi || me.choice === "hub_api";
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
      setConnecting(false);
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
  // At rest only a failed last test shows; a test just run says how it went either way.
  const lastFailed = sub?.lastTest !== undefined && !sub.lastTest.ok ? { test: sub.lastTest } : undefined;
  const form = (
    <div className={s.connectForm}>
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
      <Field label="Token">
        <SecretInput mono aria-label="Token" value={token} disabled={busy} placeholder={TOKEN_PLACEHOLDER} onChange={(e) => setToken(e.target.value)} />
      </Field>
      <div className={s.inline}>
        <Button variant="primary" disabled={busy || token.trim() === ""} onClick={connect}>
          {busy ? "Connecting…" : "Connect and test"}
        </Button>
        <Button variant="ghost" disabled={busy} onClick={() => (setConnecting(false), setToken(""), setProblem(null))}>
          Cancel
        </Button>
      </div>
    </div>
  );
  const hint = [HINT, !offer && data.hubApi !== undefined ? `The workspace's API key is kept for leads and unrequested work.` : null, sub === undefined ? null : `${sealedLine(sub.sealedOn)}.`]
    .filter((x) => x !== null)
    .join(" ");
  return (
    <SettingsRow
      reveal="claude"
      mark={none ? "needs" : "ready"}
      markLabel={none ? CONNECT : "Claude: in use"}
      title="Claude"
      hint={hint}
      line={refused === null ? <HubText>{runsOnLine(me.runsOn, [me.person], me.person.personId, noMachine)}</HubText> : <HubText>{`${CONNECT}. ${refused.fix}`}</HubText>}
      lineTone={none ? "warning" : "quiet"}
      control={
        sub === undefined ? (
          connecting ? undefined : (
            <Button size="sm" onClick={() => setConnecting(true)}>
              Connect subscription
            </Button>
          )
        ) : (
          <RowMenu
            label="Claude"
            disabled={testing}
            items={[
              { label: testing ? "Testing…" : "Test", onSelect: runTest },
              { label: "Replace token", onSelect: () => setConnecting(true) },
              { label: "Disconnect", onSelect: () => setRemoving(true), danger: true },
            ]}
          />
        )
      }
    >
      {offer ? <Choice me={me} /> : null}
      {sub === undefined ? null : <MissingOn sealedOn={sub.sealedOn} machines={machines.ids} />}
      <TestResult tried={tried ?? lastFailed} nowMs={nowMs} />
      {connecting ? form : null}
      <Problem text={problem} />
      {removing ? (
        <ConfirmRemove
          title="Disconnect your subscription?"
          description={
            team
              ? "Agents started from then on run on the workspace's API key if you may use it; otherwise you connect again before you start work."
              : "Each machine forgets the token. Agents started from then on run on the workspace's API key if you may use it; otherwise you connect again before your next order."
          }
          action="Disconnect"
          onRemove={() => hubCall("claude_subscription_remove", {})}
          onClose={() => setRemoving(false)}
        />
      ) : null}
    </SettingsRow>
  );
}

/** Runs on, as a line of its own under Claude's title: the two accounts as one switch. */
function Choice({ me }: { me: PersonClaude }) {
  const hubCall = useHubCall();
  const refetch = useRefetch();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const shown = shownChoice(me);
  const pick = (choice: ClaudeChoice) => {
    setBusy(true);
    setProblem(null);
    hubCall("claude_choice_set", { choice }).then(
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
      <div className={s.subRow} title={`Your subscription: your plan's limits, and only your work runs on it. The workspace's API key: billed to the workspace's Claude account. Agents started after a switch use the new one.`}>
        <Text size="sm" tone="quiet">
          Runs on
        </Text>
        <Segmented<ClaudeChoice>
          label="Runs on"
          value={shown ?? "subscription"}
          disabled={busy}
          onChange={pick}
          options={[
            { value: "subscription", label: "My subscription" },
            ...(me.mayUseHubApi || shown === "hub_api" ? [{ value: "hub_api" as const, label: "Workspace's API key" }] : []),
          ]}
        />
      </div>
      {!me.mayUseHubApi && shown === "hub_api" ? (
        <Notice
          tone="warning"
          action={
            <Button size="sm" variant="secondary" disabled={busy} onClick={() => pick("subscription")}>
              Use my subscription
            </Button>
          }
        >
          The workspace&apos;s admins turned their API key off for members.
        </Notice>
      ) : null}
      <Problem text={problem} />
    </>
  );
}

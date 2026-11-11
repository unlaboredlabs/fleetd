// Settings › Hub › Machines › one machine (#/settings/hub/machines/<id>): everything about it in one place, its name
// and the way back in the window's top row. First its state in a line, and while it isn't online, Repair at the line's
// end: again over SSH when the hub reaches the machine, else a line that enrolls it again (machine_join with rejoin),
// in the Add machine flow, opened in place under it. Then only what is wrong with it, read from the hub's own checks
// (doctor_list, refetched on doctor.changed): a row per check that failed or warns (claude installed and logged in,
// the git identity its commits carry, GitHub access, the screens it can host), each with its one fix: a command to run
// on the machine, with Copy, or for claude's login, Log in, which runs `claude auth login` on the machine through its
// node. The person signs in on their own device and pastes the code the page shows; the token stays on the machine.
// A machine whose checks all pass shows nothing about them. A machine just joined, which the hub hasn't checked yet,
// is checked as its page opens. Then its role
// (settings/MachineRoles.tsx), its screens and how many it hosts at once (settings/Screens.tsx), and its max agents
// (settings/Agents.tsx), all read from machine_roles and the hub's slot state. Last, Remove (RemoveMachine.tsx): once
// the hub's resync has dropped the machine, the page goes back to the list.
import { useEffect, useMemo, useRef, useState } from "react";
import { versionLabel } from "../../../shared/updates";
import { callKey } from "../../src/data/queries";
import { useData, useDataLayer, useToolQuery } from "../../src/data/react";
import { Button, copyText, Field, Input, Text, Truncate, toast } from "../../ui";
import { AddMachine, type View } from "../addMachine";
import { useNow } from "../live";
import { CommandLine } from "../onboarding/Prose";
import { openExternal } from "../prs/PrDetail";
import { HubText } from "../projects/HubText";
import { errorText, useHubCall, useLive } from "../settings/hub";
import { revealNext } from "../settings/search";
import { MachineCap } from "../settings/Agents";
import { MachineRole } from "../settings/MachineRoles";
import { DangerButton, GroupNote, PageFrame, PageHead, SettingsRow, SettingsSection } from "../settings/parts";
import { MachineScreens } from "../settings/Screens";
import { toHash } from "../shell/routes";
import { fixPlace, MACHINE_WAIT_MS, problemsOf, REMOVE_LINE, REPAIR_LINE, repairOf, statusWords, type Problem } from "./machines";
import { RemoveMachine } from "./RemoveMachine";
import s from "../settings/settings.module.css";
import a from "./admin.module.css";

const allChecks = {};
const noInput = {};

const toList = () => (window.location.hash = toHash({ id: "settings", tab: "hub.machines" }));

export function MachinePage({ machineId }: { machineId: string }) {
  const known = useData((d) => d.machines[machineId]);
  // The feed's status is newer than the snapshot's when it has one, as the list reads it.
  const status = useData((d) => d.live.machines[machineId]?.status);
  const [removed, setRemoved] = useState(false);
  // Removed from here: the page says so at once, whatever the hub's resync still has to drop.
  const machine = useMemo(() => {
    if (removed) return undefined;
    return known === undefined || status === undefined || status === known.status ? known : { ...known, status };
  }, [known, status, removed]);
  const fresh = useData((d) => d.fresh);
  const checks = useToolQuery("doctor_list", allChecks);
  const roles = useToolQuery("machine_roles", noInput).data?.machines.find((m) => m.machineId === machineId);
  const hosts = useToolQuery("machine_hosts", noInput).data?.hosts;
  const layer = useDataLayer();
  const nowMs = useNow(true, 60_000);
  const [rerunning, setRerunning] = useState(false);
  const [repair, setRepair] = useState<{ view: View; at: number }>();
  const [removing, setRemoving] = useState(false);

  const rerun = async () => {
    setRerunning(true);
    const out = await layer.call("doctor_list", { rerun: true }, { timeoutMs: 120_000 });
    setRerunning(false);
    if (out.ok) layer.queryClient.setQueryData(callKey("doctor_list", allChecks), out.output);
    else toast({ title: "The checks didn't run", description: out.error.message, tone: "danger" });
  };

  // A machine that has just joined (or whose node linked after the hub's last round) has no checks yet, or some the
  // hub couldn't answer: the hub checks it now, rather than the page waiting for its next round. Once per page.
  const checked = useRef(false);
  const mine = checks.data?.checks.filter((c) => c.machineId === machineId);
  const unchecked = machine !== undefined && machine.status !== "offline" && mine !== undefined && (mine.length === 0 || mine.some((c) => c.status === "unknown"));
  useEffect(() => {
    if (!unchecked || checked.current) return;
    checked.current = true;
    void rerun();
    // Only when it turns unchecked: rerun is the same call each render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unchecked]);

  // ...and back to the list once the resync has dropped it, so the list never shows it again.
  const gone = removed && known === undefined;
  useEffect(() => {
    if (gone) toList();
  }, [gone]);

  const name = known?.name ?? machineId;
  const frame = useMemo(
    () => ({
      title: name,
      lead: (
        <Button variant="ghost" size="sm" onClick={toList}>
          ‹ Machines
        </Button>
      ),
    }),
    [name],
  );
  const problems = checks.data === undefined ? [] : problemsOf(checks.data.checks, machineId);
  return (
    <PageFrame.Provider value={frame}>
      <div className={s.scroll} data-screen="settings.hub.machine">
        <div className={s.column}>
          <PageHead
            title={name}
            aside={
              machine === undefined || machine.status === "online" ? null : (
                <span className={a.repair}>
                  <Button title={REPAIR_LINE} onClick={() => setRepair({ view: repairOf(machineId, hosts), at: Date.now() })}>
                    Repair…
                  </Button>
                </span>
              )
            }
          >
            {machine === undefined ? (
              removed ? (
                `Removed ${name}.`
              ) : fresh ? (
                "This hub has no such machine. It may have been removed."
              ) : (
                "Loading…"
              )
            ) : (
              <>
                <Text tone={machine.status === "online" ? "quiet" : "warning"}>{statusWords(machine, nowMs)}</Text>
                {` · fleetd ${versionLabel(machine.nodeVersion)}`}
              </>
            )}
          </PageHead>
          {/* Repair's steps, in place: nothing shows until it is asked for, or while this page's run goes on. */}
          {repair === undefined ? null : <AddMachine open={repair} closed onClose={() => setRepair(undefined)} />}
          {/* Only what is wrong: nothing while its checks pass, load, or wait for the hub. */}
          {machine === undefined ? null : checks.error ? (
            <SettingsSection>
              <GroupNote tone="danger">{`Couldn't read ${machine.name}'s checks: ${errorText(checks.error)}`}</GroupNote>
            </SettingsSection>
          ) : problems.length === 0 ? null : (
            <div className={a.problems}>
              <SettingsSection data={{ "data-problems": String(problems.length) }}>
                {problems.map((problem) =>
                  problem.login === true ? (
                    <LoginRow key={problem.key} problem={problem} machineId={machineId} onLoggedIn={() => void rerun()} />
                  ) : (
                    <ProblemRow key={problem.key} problem={problem} name={machine.name} />
                  ),
                )}
              </SettingsSection>
              <span className={a.checked}>
                <Button variant="link" size="sm" disabled={rerunning} onClick={() => void rerun()}>
                  {rerunning ? "Checking…" : "Check again"}
                </Button>
              </span>
            </div>
          )}
          {machine === undefined || roles === undefined ? null : (
            <SettingsSection title="Role" reveal="hub.roles">
              <MachineRole machine={roles} />
            </SettingsSection>
          )}
          {machine !== undefined && roles !== undefined && (roles.mac !== undefined || roles.roles.includes("sessions")) ? (
            <SettingsSection title="Screens" reveal="hub.screens">
              <MachineScreens machine={roles} />
            </SettingsSection>
          ) : null}
          {machine === undefined || roles?.mac !== undefined || (roles !== undefined && !roles.roles.includes("agents")) ? null : (
            <SettingsSection title="Max agents" reveal="hub.caps">
              <MachineCap machineId={machineId} />
            </SettingsSection>
          )}
          {machine === undefined ? null : (
            <SettingsSection>
              <SettingsRow
                title={`Remove ${machine.name}`}
                hint={REMOVE_LINE}
                control={
                  <DangerButton onClick={() => setRemoving(true)}>
                    Remove…
                  </DangerButton>
                }
              />
            </SettingsSection>
          )}
          {machine !== undefined && removing ? <RemoveMachine machine={machine} onClose={() => setRemoving(false)} onRemoved={() => setRemoved(true)} /> : null}
        </div>
      </div>
    </PageFrame.Provider>
  );
}

const marks = (problem: Problem) => ({ "data-problem": problem.key, "data-state": problem.failed ? "failed" : "warn" }) as const;

/**
 * One thing wrong, and its one fix: what to do, then where its command runs (the machine or the hub's, as the hub
 * says) and the command with Copy. A screen kind the hub has no command for points at Screens, where it turns on.
 */
function ProblemRow({ problem, name }: { problem: Problem; name: string }) {
  const hosts = useToolQuery("machine_hosts", noInput).data?.hosts;
  const fix = problem.fix;
  const where = fix === undefined ? null : fixPlace(fix, name, hosts);
  const run = fix?.command === undefined || where === null ? "" : `Run on ${where}:`;
  const what = fix?.label ? <HubText>{fix.label}</HubText> : null;
  return (
    <SettingsRow
      title={<HubText>{problem.words}</HubText>}
      label={problem.words}
      line={what === null && run === "" ? undefined : (
        <>
          {what}
          {what === null || run === "" ? run : `. ${run}`}
        </>
      )}
      control={
        problem.screens === true ? (
          <Button size="sm" onClick={() => revealNext(document.querySelector("[data-part='hub.screens']") === null ? "hub.roles" : "hub.screens")}>
            Screens
          </Button>
        ) : undefined
      }
      data={{ ...marks(problem), "data-fix": where ?? undefined }}
    >
      {fix?.command === undefined ? null : <CommandLine command={fix.command} />}
    </SettingsRow>
  );
}

type Login =
  | { readonly step: "idle" }
  | { readonly step: "starting" }
  | { readonly step: "url"; readonly url: string }
  | { readonly step: "finishing"; readonly url: string }
  | { readonly step: "done"; readonly message: string };

/**
 * Claude logged out, and its login from here: Log in starts `claude auth login` on the machine (machine_claude_login),
 * which answers the page to sign in at. The person opens it on this device, signs in with the account the machine
 * should use, and pastes the code the page shows. Only that code passes through the hub, once; the token stays on the
 * machine. Once logged in the hub checks again, and the row goes with its check.
 */
function LoginRow({ problem, machineId, onLoggedIn }: { problem: Problem; machineId: string; onLoggedIn: () => void }) {
  const call = useHubCall();
  const live = useLive();
  const [login, setLogin] = useState<Login>({ step: "idle" });
  const [code, setCode] = useState("");
  const [error, setError] = useState<string>();
  const [copied, setCopied] = useState(false);

  const start = () => {
    setError(undefined);
    setCode("");
    setLogin({ step: "starting" });
    call("machine_claude_login", { machineId }, { timeoutMs: MACHINE_WAIT_MS }).then(
      (out) => setLogin(out.loginUrl === undefined ? { step: "idle" } : { step: "url", url: out.loginUrl }),
      (e: unknown) => {
        setError(errorText(e));
        setLogin({ step: "idle" });
      },
    );
  };
  const finish = (url: string) => {
    if (code.trim() === "") return;
    setError(undefined);
    setLogin({ step: "finishing", url });
    call("machine_claude_login", { machineId, code: code.trim() }, { timeoutMs: MACHINE_WAIT_MS }).then(
      (out) => {
        setCode("");
        setLogin({ step: "done", message: out.message });
        onLoggedIn();
      },
      (e: unknown) => {
        setError(errorText(e));
        // A used or wrong code is spent: the login has ended, so it starts again.
        setLogin({ step: "idle" });
      },
    );
  };

  const waiting = login.step === "idle" || login.step === "starting";
  return (
    <SettingsRow
      title={<HubText>{problem.words}</HubText>}
      label={problem.words}
      line={
        error !== undefined ? (
          <span role="alert">{error}</span>
        ) : login.step === "done" ? (
          `Logged in on ${machineId}. ${login.message}`
        ) : login.step === "starting" ? (
          `Starting claude auth login on ${machineId}…`
        ) : !live && waiting ? (
          "Not connected to the hub."
        ) : undefined
      }
      lineTone={error === undefined ? "quiet" : "danger"}
      control={
        waiting ? (
          <Button size="sm" disabled={!live || login.step === "starting"} onClick={start}>
            {login.step === "starting" ? "Starting…" : error === undefined ? "Log in…" : "Try again"}
          </Button>
        ) : undefined
      }
      data={marks(problem)}
    >
      {login.step === "url" || login.step === "finishing" ? (
        <form
          className={a.loginForm}
          aria-label="Sign in"
          onSubmit={(e) => {
            e.preventDefault();
            finish(login.url);
          }}
        >
          <Text size="sm">{`Open this page and sign in with the Claude account ${machineId} should use.`}</Text>
          <div className={a.link}>
            {/* An address, not words: held to the code rule, not the text one. */}
            <span className={a.url} data-text="code">
              <Truncate mono size="sm">
                {login.url}
              </Truncate>
            </span>
            <Button size="sm" onClick={() => openExternal(login.url)}>
              Open
            </Button>
            <Button size="sm" variant="quiet" onClick={() => void copyText(login.url).then(setCopied)}>
              {copied ? "Copied" : "Copy"}
            </Button>
          </div>
          <Field label="The code the page shows">
            <Input value={code} mono autoComplete="off" placeholder="Code" onChange={(e) => setCode(e.target.value)} disabled={login.step === "finishing"} />
          </Field>
          <span>
            <Button type="submit" size="sm" variant="primary" disabled={code.trim() === "" || login.step === "finishing" || !live}>
              {login.step === "finishing" ? "Logging in…" : "Log in"}
            </Button>
          </span>
        </form>
      ) : null}
    </SettingsRow>
  );
}

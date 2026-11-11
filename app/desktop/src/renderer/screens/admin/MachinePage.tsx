// Settings › Hub › Machines › one machine (#/settings/hub/machines/<id>): everything about it in one place, its name
// and the way back in the window's top row. First its state in a line, and while it isn't online, Repair at the line's
// end: again over SSH when the hub reaches the machine, else a line that enrolls it again (machine_join with rejoin),
// in the Add machine flow, opened in place under it. Then what it needs, as a checklist read from the hub's own
// checks (doctor_list, refetched on doctor.changed): claude installed and logged in, the git identity its commits
// carry, GitHub access, and the screens it can host. Each item that wants a look has its fix: a command to run on the
// machine, with Copy, or for claude's login, Log in, which runs `claude auth login` on the machine through its node.
// The person signs in on their own device and pastes the code the page shows; the token stays on the machine. A
// machine just joined, which the hub hasn't checked yet, is checked as its page opens. Then its role
// (settings/MachineRoles.tsx), its screens and how many it hosts at once (settings/Screens.tsx), and its max agents
// (settings/Agents.tsx), all read from machine_roles and the hub's slot state. Last, Remove (RemoveMachine.tsx): once
// the hub's resync has dropped the machine, the page goes back to the list.
import { useEffect, useMemo, useRef, useState } from "react";
import type { DoctorFix } from "../../../shared/contracts";
import { versionLabel } from "../../../shared/updates";
import { callKey } from "../../src/data/queries";
import { useData, useDataLayer, useToolQuery } from "../../src/data/react";
import { Button, copyText, Field, Input, StateGlyph, Text, Truncate, toast, type GlyphState } from "../../ui";
import { AddMachine, type View } from "../addMachine";
import { useNow } from "../live";
import { CommandLine } from "../onboarding/Prose";
import { openExternal } from "../prs/PrDetail";
import { HubText } from "../projects/HubText";
import { errorText, useHubCall, useLive } from "../settings/hub";
import { revealNext } from "../settings/search";
import { MachineCap } from "../settings/Agents";
import { MachineRole } from "../settings/MachineRoles";
import { DangerButton, GroupNote, PageFrame, PageHead, SettingsList, SettingsListRow, SettingsRow, SettingsSection } from "../settings/parts";
import { MachineScreens } from "../settings/Screens";
import { toHash } from "../shell/routes";
import { when } from "../live/when";
import { checklistOf, fixPlace, MACHINE_WAIT_MS, REMOVE_LINE, REPAIR_LINE, repairOf, statusWords, type ChecklistItem, type ItemState } from "./machines";
import { RemoveMachine } from "./RemoveMachine";
import s from "../settings/settings.module.css";
import a from "./admin.module.css";

const allChecks = {};
const noInput = {};

const GLYPH: Readonly<Record<ItemState, GlyphState>> = { done: "done", failed: "failed", warn: "waiting", waiting: "queued" };

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
  // This machine's own run, which another machine's or the hub's doesn't move (absent from older hubs).
  const checkedAt = mine?.find((c) => c.checkedAt !== undefined)?.checkedAt;
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
  const items = checks.data === undefined ? undefined : checklistOf(checks.data.checks, machineId);
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
          {machine === undefined ? null : (
            <SettingsSection title="Checklist">
              {checks.error ? (
                <GroupNote tone="danger">{`Couldn't read the checks: ${errorText(checks.error)}`}</GroupNote>
              ) : items === undefined ? (
                <GroupNote>Loading…</GroupNote>
              ) : (
                <>
                  <SettingsList label="Checklist">
                    {items.map((item) => (
                      <Item key={item.key} item={item} machineId={machineId} name={machine.name} onLoggedIn={() => void rerun()} />
                    ))}
                  </SettingsList>
                  <div className={a.checked}>
                    {checkedAt === undefined ? null : (
                      <Text size="sm" tone="quiet">
                        {`Checked ${when(checkedAt, nowMs)}.`}
                      </Text>
                    )}
                    <Button variant="link" size="sm" disabled={rerunning} onClick={() => void rerun()}>
                      {rerunning ? "Checking…" : "Check again"}
                    </Button>
                  </div>
                </>
              )}
            </SettingsSection>
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
                line={REMOVE_LINE}
                control={<DangerButton onClick={() => setRemoving(true)}>Remove…</DangerButton>}
              />
            </SettingsSection>
          )}
          {machine !== undefined && removing ? <RemoveMachine machine={machine} onClose={() => setRemoving(false)} onRemoved={() => setRemoved(true)} /> : null}
        </div>
      </div>
    </PageFrame.Provider>
  );
}

function Item({ item, machineId, name, onLoggedIn }: { item: ChecklistItem; machineId: string; name: string; onLoggedIn: () => void }) {
  return (
    <SettingsListRow
      icon={<StateGlyph state={GLYPH[item.state]} size="sm" />}
      name={<Text tone={item.state === "failed" ? "danger" : item.state === "warn" ? "warning" : "default"}>{item.title}</Text>}
      label={item.title}
      data={{ "data-item": item.key, "data-state": item.state }}
    >
      <div className={s.stack}>
        {item.lines.map((line) => (
          <Text key={line} size="sm" tone="quiet">
            <HubText>{line}</HubText>
          </Text>
        ))}
        {item.login ? <ClaudeLogin machineId={machineId} onLoggedIn={onLoggedIn} /> : item.fix ? <Fix fix={item.fix} name={name} /> : null}
        {item.screens === true ? (
          <span className={a.more}>
            <Button variant="link" size="sm" onClick={() => revealNext(document.querySelector("[data-part='hub.screens']") === null ? "hub.roles" : "hub.screens")}>
              Turn them on under Screens
            </Button>
          </span>
        ) : null}
      </div>
    </SettingsListRow>
  );
}

/** The hub's fix: what to do, then where its command runs (the machine or the hub's, as the hub says) and the command with Copy. */
function Fix({ fix, name }: { fix: DoctorFix; name: string }) {
  const hosts = useToolQuery("machine_hosts", noInput).data?.hosts;
  const where = fixPlace(fix, name, hosts);
  const what = fix.label ? <HubText>{fix.label}</HubText> : null;
  return (
    <div className={a.fix} data-fix={where ?? ""}>
      {what === null && (fix.command === undefined || where === null) ? null : (
        <Text size="sm">
          {what}
          {fix.command === undefined || where === null ? null : `${what === null ? "" : ". "}Run on ${where}:`}
        </Text>
      )}
      {fix.command === undefined ? null : <CommandLine command={fix.command} />}
    </div>
  );
}

type Login =
  | { readonly step: "idle" }
  | { readonly step: "starting" }
  | { readonly step: "url"; readonly url: string }
  | { readonly step: "finishing"; readonly url: string }
  | { readonly step: "done"; readonly message: string };

/**
 * Claude's login from here: Log in starts `claude auth login` on the machine (machine_claude_login), which answers the
 * page to sign in at. The person opens it on this device, signs in with the account the machine should use, and
 * pastes the code the page shows. Only that code passes through the hub, once; the token stays on the machine.
 */
export function ClaudeLogin({ machineId, onLoggedIn }: { machineId: string; onLoggedIn: () => void }) {
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

  return (
    <div className={a.login} aria-label="Claude login">
      {login.step === "done" ? (
        <Text size="sm">{`Logged in on ${machineId}. ${login.message}`}</Text>
      ) : login.step === "idle" || login.step === "starting" ? (
        <span>
          <Button size="sm" variant="secondary" disabled={!live || login.step === "starting"} onClick={start}>
            {login.step === "starting" ? `Starting claude auth login on ${machineId}…` : error === undefined ? "Log in…" : "Try again"}
          </Button>
        </span>
      ) : (
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
          <Field label="The code the page shows" description="It goes to the machine once; claude keeps its login there.">
            <Input value={code} mono autoComplete="off" placeholder="Code" onChange={(e) => setCode(e.target.value)} disabled={login.step === "finishing"} />
          </Field>
          <span>
            <Button type="submit" size="sm" variant="primary" disabled={code.trim() === "" || login.step === "finishing" || !live}>
              {login.step === "finishing" ? "Logging in…" : "Log in"}
            </Button>
          </span>
        </form>
      )}
      {error === undefined ? null : (
        <p role="alert">
          <Text size="sm" tone="danger">
            {error}
          </Text>
        </p>
      )}
    </div>
  );
}

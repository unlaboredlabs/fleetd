// Add machine (W105): an owner or admin makes a computer one of the hub's machines, without a terminal. Three ways:
//   - This computer: one click. Main first reads this computer's fleetd dir: one holding the hub goes through the hub
//     (machine_add local), one holding an enrolled node is a machine already; on any other, main downloads the hub's
//     own fleetd build, checks it, and joins with a one-time code (src/main/joinHere.ts).
//   - A machine the hub can reach: pick one of machine_hosts, see machine_add_plan's steps, Add, and watch each step;
//     a failed step shows its output, the fix and Retry (finished steps are skipped). A host the hub can't log in to
//     shows `ssh-copy-id <host>` to run on the hub's machine, and Try again.
//   - Any other machine: name it, and paste the one line machine_join makes (fleetd pair --worker's) in its terminal.
//     "Waiting for <name>…" turns into "Joined" once its node is online; a code that expires first says so.
//   - A Mac for agents (D298, D309): a 6-digit code the fleetd app on the Mac takes (MacCode.tsx), which sets it up
//     with no terminal; Use Terminal instead shows the same line with --mac, between the hub's own guide for it (setup step "mac"): the
//     admin block the person pastes in their own account first, and the two permission clicks at the Mac after. A
//     machine of that name already moves into the agents' user (--rejoin). Its checks are on #/setup/mac.
// Repair on a machine's page opens the plan of a machine the hub reaches, or a line that enrolls it again.
// A run goes on in the hub when the page closes; opening it again shows the run still going or the last one that
// failed. Every step is a machine_add.step event, which reads machine_add_status again.
//
// One component with no page around it, so Settings › Hub › Machines and the hub's first-run setup
// show the same flow: a quiet label, then one soft group holding the step at hand. Settings keeps the ways in behind
// its plus (`closed`), so the machines lead that page; a run still going shows all the same. Mount it only where the
// person is an owner or admin.
import { X } from "lucide-react";
import { useEffect, useState } from "react";
import type { MachineAddRun, MachineHost, MachineJoinOutput, SetupStep } from "../../../shared/contracts";
import type { JoinHere, ThisComputer } from "../../../shared/joinHere";
import { useData, useDataLayer, useToolQuery } from "../../src/data/react";
import { Button, copyText, Field, InlineCode, Input, StateGlyph, Text } from "../../ui";
import { errorText, useHubCall, useLive, useRefetch } from "../settings/hub";
import { useReveal } from "../settings/search";
import { useServes } from "../admin/role";
import {
  glyphOf,
  hereLine,
  hereOf,
  hostLine,
  joinSteps,
  lineState,
  lineWords,
  machineIdProblem,
  onlyHereLine,
  pickable,
  resumable,
  runLine,
  runTitle,
  sentence,
  shortOutput,
  sshProblem,
  stepTitle,
  untilLine,
  type Here,
} from "./model";
import { GuideParts, RunOn } from "../setup/Guide";
import { Head } from "./Head";
import { MacCode } from "./MacCode";
import { toHash } from "../shell/routes";
import s from "./addMachine.module.css";

const MAC_LINE = "For iOS builds and simulators.";

const MAC_HEAD = "Paste both parts in Terminal on the Mac, in the account logged in at its screen.";

export type View =
  | { readonly kind: "choose" }
  | { readonly kind: "hosts" }
  | { readonly kind: "plan"; readonly host: MachineHost }
  | { readonly kind: "run"; readonly runId: string }
  | { readonly kind: "here" }
  /** A Mac for agents: its 6-digit code (MacCode.tsx). */
  | { readonly kind: "mac" }
  /** Any other machine; with a machine id, a repair's line for it (`rejoin`); `mac`: the agents' Mac. */
  | { readonly kind: "line"; readonly machineId?: string; readonly rejoin?: boolean; readonly mac?: boolean };

const noInput = {};

/** This computer's host name, once main has said. */
const useHostName = (): string | undefined => {
  const [name, setName] = useState<string>();
  useEffect(() => {
    let live = true;
    void window.fleetd.system.hostName().then((n) => live && setName(n));
    return () => {
      live = false;
    };
  }, []);
  return name;
};

/**
 * What this computer's fleetd dir holds, as main read it: a hub, an enrolled node, or neither. Read again whenever
 * `again` changes (a join or an add ended), so a computer that has just joined never shows a
 * stale Repair.
 */
const useThisComputer = (again: string): ThisComputer | undefined => {
  const [here, setHere] = useState<ThisComputer>();
  useEffect(() => {
    let live = true;
    void window.fleetd.machines.thisComputer().then((h) => live && setHere(h));
    return () => {
      live = false;
    };
  }, [again]);
  return here;
};

/** The join of this computer to this hub, as main reports it: another hub's join is that hub's page's. */
const useJoinHere = (): JoinHere | null => {
  const { hub } = useDataLayer();
  const [join, setJoin] = useState<JoinHere | null>(null);
  useEffect(() => {
    let live = true;
    void window.fleetd.machines.joinHereState(hub).then((j) => live && j !== null && setJoin(j));
    const off = window.fleetd.machines.onJoinHere(hub, setJoin);
    return () => {
      live = false;
      off();
    };
  }, [hub]);
  return join;
};

const useOnline = (machineId: string | undefined): boolean =>
  useData((d) => (machineId === undefined ? false : (d.machines[machineId]?.status ?? "offline") !== "offline"));

/**
 * `open`: a view to show, from outside (a machine's Repair); `at` tells one click from the next. `closed`: nothing
 * shows until there is something to follow (a run still going or just failed, this computer's join, a view asked
 * for), so a page can keep the ways in behind its plus. `onClose`: the ways in can be closed, and Done leaves too.
 */
export function AddMachine({
  open,
  closed = false,
  onClose,
}: { open?: { readonly view: View; readonly at: number } | undefined; closed?: boolean | undefined; onClose?: (() => void) | undefined } = {}) {
  const layer = useDataLayer();
  const live = useLive();
  const call = useHubCall();
  const refetch = useRefetch();
  // fleetd cloud reaches no machine over SSH: no hosts, runs or plans to read there, and no row for them.
  const ssh = useServes("machine_hosts");
  const status = useToolQuery("machine_add_status", noInput, { enabled: useServes("machine_add_status") });
  const hosts = useToolQuery("machine_hosts", noInput, { enabled: ssh });
  const hostName = useHostName();
  const join = useJoinHere();
  const ref = useReveal<HTMLElement>("hub.add-machine");
  const ended = status.data?.runs.find((r) => r.state !== "running")?.runId ?? "";
  // Nothing about this computer is decided before the hub has said which computer it runs on.
  const info = useToolQuery("hub_info", noInput);
  const hubFingerprint = info.data?.machineFingerprint;
  const computer = useThisComputer(`${join?.state ?? ""}|${ended}`);
  const machines = useData((d) => d.machines);
  const [view, setView] = useState<View>();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string>();
  // A view asked for from outside, once per click.
  const [opened, setOpened] = useState<number>();
  if (open !== undefined && open.at !== opened) {
    setOpened(open.at);
    setView(open.view);
  }

  // Opening on a run still going (or one that just failed), or on this computer's join.
  const runs = status.data?.runs;
  const shown: View =
    view ??
    (join?.state === "running"
      ? { kind: "here" }
      : (() => {
          const r = runs === undefined ? undefined : resumable(runs);
          return r === undefined ? { kind: "choose" } : { kind: "run", runId: r.runId };
        })());

  // The hub's own machine, where a command that lets the hub reach another one runs.
  const hubMachine = hosts.data?.hosts.find((h) => h.source === "hub")?.machineId ?? "the hub's machine";
  const hostList = ssh ? hosts.data?.hosts : [];
  const here =
    hostList && hostName !== undefined && computer !== undefined && !info.isPending ? hereOf(hostList, hubFingerprint, hostName, computer, new Set(Object.keys(machines))) : undefined;

  const add = (target: { host: string } | { local: true }) => {
    setBusy(true);
    setProblem(undefined);
    call("machine_add", target)
      .then(
        (out) => {
          setView({ kind: "run", runId: out.run.runId });
          refetch(["machine_add_status"]);
        },
        (e: unknown) => setProblem(errorText(e)),
      )
      .finally(() => setBusy(false));
  };

  /** Back to the ways in, with the hosts read again: the one just added is a machine now. */
  const back = () => {
    setView({ kind: "choose" });
    refetch(["machine_hosts"]);
  };
  /** Done: back to the ways in, and out where they can be closed. */
  const done = () => {
    back();
    onClose?.();
  };

  const addHere = (h: Here) => {
    setProblem(undefined);
    if (h.kind === "hub") return add({ local: true });
    if (h.kind === "node" || h.kind === "other-hub") return;
    setView({ kind: "here" });
    void window.fleetd.machines.joinHere(layer.hub, h.machineId);
  };

  if (closed && shown.kind === "choose") return null;
  // A view asked for from outside has no ways in behind it: Back leaves.
  const asked = open !== undefined && shown === open.view && onClose !== undefined;
  const leave = asked ? done : back;
  return (
    <section ref={ref} className={s.panel} aria-label="Add machine" data-state={shown.kind}>
      {!live ? (
        <Text tone="quiet">Connect to the hub to add a machine.</Text>
      ) : shown.kind === "choose" ? (
        <Choose
          here={here}
          ssh={ssh}
          busy={busy}
          onHere={addHere}
          onHosts={() => setView({ kind: "hosts" })}
          onLine={() => setView({ kind: "line" })}
          onMac={() => setView({ kind: "mac" })}
          onClose={onClose}
        />
      ) : shown.kind === "hosts" ? (
        <Hosts read={hosts} hubMachine={hubMachine} onPick={(host) => setView({ kind: "plan", host })} onBack={() => setView({ kind: "choose" })} />
      ) : shown.kind === "plan" ? (
        <Plan host={shown.host} hubMachine={hubMachine} busy={busy} onAdd={() => add(shown.host.host === undefined ? { local: true } : { host: shown.host.host })} onBack={asked ? done : () => setView({ kind: "hosts" })} />
      ) : shown.kind === "run" ? (
        <Run
          run={runs?.find((r) => r.runId === shown.runId)}
          pending={status.isPending}
          busy={busy}
          onRetry={(r) => add(r.host === undefined ? { local: true } : { host: r.host })}
          onBack={leave}
          onDone={done}
        />
      ) : shown.kind === "mac" ? (
        <MacCode onLine={() => setView({ kind: "line", mac: true })} onBack={leave} onDone={done} />
      ) : shown.kind === "line" ? (
        <Line
          key={`${shown.machineId ?? ""}-${String(shown.mac === true)}-${String(open?.at ?? 0)}`}
          machineId={shown.machineId}
          rejoin={shown.rejoin === true}
          mac={shown.mac === true}
          onBack={leave}
          onDone={done}
        />
      ) : (
        <JoinHereRun join={join} onRetry={() => here && addHere(here)} onBack={leave} onDone={done} />
      )}
      {problem === undefined ? null : <Text tone="danger">{problem}</Text>}
    </section>
  );
}

function Choose(props: {
  here: Here | undefined;
  /** The hub reaches machines over SSH: not fleetd cloud, where one line under the ways in says how they join. */
  ssh: boolean;
  busy: boolean;
  onHere: (h: Here) => void;
  onHosts: () => void;
  onLine: () => void;
  onMac: () => void;
  onClose: (() => void) | undefined;
}) {
  const { here } = props;
  return (
    <>
      <Head
        title="Add machine"
        line="A machine runs agents and their browsers and devices. It needs claude installed."
        aside={
          props.onClose === undefined ? undefined : (
            <Button variant="ghost" iconOnly aria-label="Close" title="Close" className={s.close} onClick={props.onClose}>
              <X size={16} aria-hidden />
            </Button>
          )
        }
      />
      <ul className={s.rows}>
        <li className={s.row}>
          <div className={s.rowText}>
            <Text>This computer</Text>
            <Text size="sm" tone="quiet">
              {hereLine(here)}
            </Text>
          </div>
          {here?.kind === "node" || here?.kind === "other-hub" ? null : (
            <Button className={s.rowAction} disabled={here === undefined || props.busy} onClick={() => here && props.onHere(here)}>
              {here?.joined ? "Repair" : "Add this computer"}
            </Button>
          )}
        </li>
        {props.ssh ? (
          <li className={s.row}>
            <div className={s.rowText}>
              <Text>A machine the hub can reach</Text>
              <Text size="sm" tone="quiet">
                Over SSH from the hub: one in its ~/.ssh/config or on its tailnet.
              </Text>
            </div>
            <Button className={s.rowAction} onClick={props.onHosts}>
              Choose…
            </Button>
          </li>
        ) : null}
        <li className={s.row}>
          <div className={s.rowText}>
            <Text>{props.ssh ? "Any other machine" : "Another machine"}</Text>
            <Text size="sm" tone="quiet">
              {props.ssh ? "A laptop, or one behind NAT: one line to paste in its terminal. It must reach the hub." : "One line to paste in its terminal. On fleetd cloud, machines join this way, not over SSH."}
            </Text>
          </div>
          <Button className={s.rowAction} onClick={props.onLine}>
            Get the line…
          </Button>
        </li>
        <li className={s.row}>
          <div className={s.rowText}>
            <Text>A Mac for agents</Text>
            <Text size="sm" tone="quiet">
              {MAC_LINE}
            </Text>
          </div>
          <Button className={s.rowAction} onClick={props.onMac}>
            Set up…
          </Button>
        </li>
      </ul>
    </>
  );
}

function Hosts(props: { read: ReturnType<typeof useToolQuery<"machine_hosts">>; hubMachine: string; onPick: (h: MachineHost) => void; onBack: () => void }) {
  const hosts = props.read.data?.hosts;
  return (
    <>
      <Head
        title="A machine the hub can reach"
        line={
          <>
            The hub connects with its own SSH keys, so <InlineCode>ssh &lt;host&gt; true</InlineCode> must work from the hub without a password.
          </>
        }
      />
      {props.read.error ? (
        <div className={s.body}>
          <Text tone="danger">{`Couldn't list them: ${errorText(props.read.error)}`}</Text>
        </div>
      ) : hosts === undefined ? (
        <div className={s.body}>
          <Text tone="quiet">Looking…</Text>
        </div>
      ) : pickable(hosts).length === 0 ? (
        <div className={s.body}>
          <Text tone="quiet">{`The hub finds none. Name the machine in ~/.ssh/config on ${props.hubMachine}, or add it as any other machine.`}</Text>
        </div>
      ) : (
        <ul className={s.rows} aria-label="Hosts">
          {pickable(hosts).map((h) => (
            <li key={h.machineId} className={s.row}>
              <div className={s.rowText}>
                <Text tone={h.joined ? "quiet" : "default"}>{h.machineId}</Text>
                <Text size="sm" tone="quiet">
                  {h.joined ? `${hostLine(h)} · a machine already` : hostLine(h)}
                </Text>
              </div>
              <Button className={s.rowAction} variant={h.joined ? "quiet" : "secondary"} onClick={() => props.onPick(h)}>
                {h.joined ? "Repair…" : "Plan…"}
              </Button>
            </li>
          ))}
        </ul>
      )}
      <div className={s.actions}>
        <Button onClick={props.onBack}>Back</Button>
      </div>
    </>
  );
}

/** The steps, each a word and a glyph; their commands on request, and always for the step that failed. */
function Steps(props: { steps: ReadonlyArray<SetupStep> }) {
  const [commands, setCommands] = useState(false);
  const any = props.steps.some((x) => x.command !== undefined);
  return (
    <div className={s.head}>
      <ol className={s.steps} aria-label="Steps">
        {props.steps.map((step, i) => (
          <StepRow key={`${i}-${step.title}`} step={step} command={commands || step.state === "failed"} />
        ))}
      </ol>
      {any ? (
        <span className={s.more}>
          <Button variant="link" size="sm" onClick={() => setCommands(!commands)}>
            {commands ? "Hide commands" : "Show commands"}
          </Button>
        </span>
      ) : null}
    </div>
  );
}

function StepRow({ step, command }: { step: SetupStep; command: boolean }) {
        const short = shortOutput(step);
        return (
          <li className={s.step} data-step={step.state}>
            <StateGlyph state={glyphOf(step.state)} size="sm" />
            <div className={s.stepBody}>
              <Text size="sm" tone={step.state === "planned" ? "quiet" : step.state === "failed" ? "danger" : "default"}>
                {stepTitle(step.title)}
              </Text>
              {step.command === undefined || !command ? null : (
                <Text as="code" size="xs" tone="faint" mono className={s.command}>
                  {step.command.length > 240 ? `${step.command.slice(0, 240)}…` : step.command}
                </Text>
              )}
              {short === undefined ? null : (
                <Text size="xs" tone="quiet" mono>
                  {`→ ${short}`}
                </Text>
              )}
              {step.state === "failed" && step.output ? <pre className={s.output}>{step.output}</pre> : null}
            </div>
          </li>
        );
}

function Notes(props: { notes: ReadonlyArray<string> }) {
  if (props.notes.length === 0) return null;
  return (
    <ul className={s.notes} aria-label="Notes">
      {props.notes.map((n) => (
        <li key={n}>
          <Text size="sm" tone="quiet">
            {n}
          </Text>
        </li>
      ))}
    </ul>
  );
}

function Plan(props: { host: MachineHost; hubMachine: string; busy: boolean; onAdd: () => void; onBack: () => void }) {
  const input = props.host.host === undefined ? { local: true as const } : { host: props.host.host };
  const plan = useToolQuery("machine_add_plan", input);
  const m = props.host.machineId;
  return (
    <>
      <Head
        title={props.host.joined ? `Repair ${m}` : `Add ${m}`}
        line={plan.data ? `${plan.data.platform} · ${hostLine(props.host)}. Nothing has changed on it yet.` : `Reading ${m} over SSH; nothing changes on it.`}
      />
      <div className={s.body}>
        {plan.error ? (
          <PlanError host={props.host.host} hubMachine={props.hubMachine} error={plan.error} />
        ) : plan.data === undefined ? (
          <Text tone="quiet">Reading the machine…</Text>
        ) : (
          <>
            <Steps steps={plan.data.steps} />
            <Notes notes={plan.data.notes} />
          </>
        )}
        <div className={s.actions}>
          {plan.error ? (
            <Button variant="primary" disabled={plan.isFetching} onClick={() => void plan.refetch()}>
              {plan.isFetching ? "Trying…" : "Try again"}
            </Button>
          ) : (
            <Button variant="primary" disabled={plan.data === undefined || props.busy} onClick={props.onAdd}>
              {props.host.joined ? `Repair ${m}` : `Add ${m}`}
            </Button>
          )}
          <Button onClick={props.onBack}>Back</Button>
        </div>
      </div>
    </>
  );
}

/**
 * Why the hub couldn't read the machine over SSH, and what to run on the hub's machine for it (sshProblem): its key
 * refused, a host key it doesn't know, or the host not answering at all. Else the hub's own words and fix.
 */
function PlanError(props: { host: string | undefined; hubMachine: string; error: Error }) {
  const problem = props.host === undefined ? undefined : sshProblem(props.host, props.error.message);
  if (problem === undefined) return <Text tone="danger">{errorText(props.error)}</Text>;
  return (
    <div className={s.head} data-ssh={problem.kind}>
      <Text tone="danger">{sentence(props.error.message.split("\n")[0] ?? "")}</Text>
      <RunOn where={props.hubMachine} command={problem.command} note={problem.note} />
    </div>
  );
}

function Run(props: { run: MachineAddRun | undefined; pending: boolean; busy: boolean; onRetry: (r: MachineAddRun) => void; onBack: () => void; onDone: () => void }) {
  const { run } = props;
  const online = useOnline(run?.machineId);
  if (run === undefined) {
    return (
      <div className={s.body}>
        {props.pending ? (
          <Text tone="quiet">Loading…</Text>
        ) : (
          <>
            <Text tone="quiet">The hub no longer has this run: it restarted. Add the machine again; finished steps are skipped.</Text>
            <div className={s.actions}>
              <Button onClick={props.onBack}>Back</Button>
            </div>
          </>
        )}
      </div>
    );
  }
  return (
    <>
      <Head title={runTitle(run)} line={runLine(run, online)} />
      <div className={s.body}>
        <Steps steps={run.steps} />
        {run.state === "failed" ? (
          <div className={s.head}>
            {run.message === undefined ? null : <Text tone="danger">{sentence(run.message.split("\n")[0] ?? "")}</Text>}
            {run.fix === undefined ? null : (
              <Text size="sm" tone="quiet">
                {sentence(run.fix)}
              </Text>
            )}
          </div>
        ) : null}
        <Notes notes={run.notes} />
        {run.state === "running" ? null : (
          <div className={s.actions}>
            {run.state === "failed" ? (
              <Button variant="primary" disabled={props.busy} onClick={() => props.onRetry(run)}>
                Retry
              </Button>
            ) : null}
            {run.state === "failed" ? <Button onClick={props.onBack}>Back</Button> : <Button onClick={props.onDone}>Done</Button>}
          </div>
        )}
      </div>
    </>
  );
}

function JoinHereRun(props: { join: JoinHere | null; onRetry: () => void; onBack: () => void; onDone: () => void }) {
  const online = useOnline(props.join?.machineId);
  const { join } = props;
  if (join === null) {
    return (
      <div className={s.body}>
        <Text tone="quiet">Starting…</Text>
      </div>
    );
  }
  return (
    <>
      <Head title={`${join.machineId}, this computer`} line={runLine(join, online)} />
      <div className={s.body}>
        <Steps steps={joinSteps(join, online)} />
        {join.state === "failed" && join.message !== undefined ? <Text tone="danger">{join.message}</Text> : null}
        {join.state === "running" ? null : (
          <div className={s.actions}>
            {join.state === "failed" ? (
              <Button variant="primary" onClick={props.onRetry}>
                Retry
              </Button>
            ) : null}
            {join.state === "failed" ? <Button onClick={props.onBack}>Back</Button> : <Button onClick={props.onDone}>Done</Button>}
          </div>
        )}
      </div>
    </>
  );
}

/** A minute-grained clock, for a code's expiry: no ticking on screen. */
const useNow = (): number => {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 15_000);
    return () => window.clearInterval(id);
  }, []);
  return now;
};

/**
 * Any other machine: its name, then the one line machine_join makes, with Copy and the code's expiry. Under it, a
 * calm "Waiting for <name>…" that turns into "Joined" once the machine's node is online. A repair (`rejoin`) has its
 * name already, and makes its line at once.
 */
function Line(props: { machineId: string | undefined; rejoin: boolean; mac?: boolean; onBack: () => void; onDone: () => void }) {
  const call = useHubCall();
  const layer = useDataLayer();
  const machines = useData((d) => d.machines);
  const mac = props.mac === true;
  // The hub's own guide for the Mac: the admin block before the line, the two permission clicks after it.
  const guided = useServes("setup_list");
  const guide = useToolQuery("setup_list", noInput, { enabled: mac && guided }).data?.steps.find((step) => step.id === "mac")?.parts;
  const [name, setName] = useState(props.machineId ?? (mac ? "mac" : ""));
  const [tried, setTried] = useState(false);
  // A repair's line is being made as it opens.
  const [busy, setBusy] = useState(props.rejoin);
  const [error, setError] = useState<string>();
  const [made, setMade] = useState<{ readonly join: MachineJoinOutput; readonly onlineAtStart: boolean }>();
  /** The link to its node the hub had when the line was made, or the first it reported since. */
  const [baseline, setBaseline] = useState<string>();
  const [copied, setCopied] = useState<boolean>();
  const [wentOffline, setWentOffline] = useState(false);
  const now = useNow();
  const problem = machineIdProblem(name);
  const machineId = made?.join.machineId ?? name.trim();
  const online = useOnline(made === undefined ? undefined : machineId);
  // When the hub's link to its node last came up: a rejoin restarts the node, which moves it.
  const linked = useData((d) => d.live.machines[machineId]?.linkedSince);
  // Once its line is made, the machine coming online is the point, not a clash. A Mac that is a machine already moves
  // into the agents' user: its line enrolls it again.
  const exists = machines[name.trim()] !== undefined;
  const taken = !props.rejoin && !mac && made === undefined && exists;
  const rejoin = props.rejoin || (mac && exists);

  const request = (id: string) =>
    call("machine_join", { machineId: id, ...(rejoin ? { rejoin: true } : {}), ...(mac ? { mac: true } : {}) })
      .then(
        (join) => {
          setMade({ join, onlineAtStart: (machines[id]?.status ?? "offline") !== "offline" });
          setBaseline(layer.store.getState().live.machines[id]?.linkedSince);
        },
        (e: unknown) => setError(errorText(e)),
      )
      .finally(() => setBusy(false));
  const make = () => {
    setTried(true);
    if (problem !== undefined || taken) return;
    setBusy(true);
    setError(undefined);
    setCopied(undefined);
    setWentOffline(false);
    void request(name.trim());
  };
  // A repair knows its machine: its line comes at once.
  useEffect(() => {
    if (props.rejoin && props.machineId !== undefined) void request(props.machineId);
    // Once, as the view opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A repair of a machine still online joins once its node has restarted: a new link to it, which a quick restart
  // shows by the link's time alone (the hub keeps it online through one), or a longer one offline for a while.
  if (made !== undefined && !online && !wentOffline) setWentOffline(true);
  if (made !== undefined && baseline === undefined && linked !== undefined) setBaseline(linked);
  const relinked = baseline !== undefined && linked !== undefined && linked !== baseline;
  const state = made === undefined ? undefined : lineState({ expiresAt: made.join.expiresAt, onlineAtStart: made.onlineAtStart }, online, now, wentOffline || relinked);
  return (
    <>
      <Head
        title={mac ? "A Mac for agents" : props.rejoin ? `Repair ${props.machineId ?? ""}` : "Any other machine"}
        line={
          mac
            ? MAC_HEAD
            : props.rejoin
              ? "Run this line in a terminal on it: it installs this hub's fleetd again and enrolls the machine with a new code."
              : "Run one line in a terminal on it: it installs this hub's fleetd and joins. The machine needs claude and must reach the hub."
        }
      />
      {mac && guide?.[0] !== undefined ? <GuideParts parts={[guide[0]]} /> : null}
      {props.rejoin ? null : (
        <form
          className={s.lineForm}
          aria-label="Name the machine"
          onSubmit={(e) => {
            e.preventDefault();
            make();
          }}
        >
          <Field
            label="Name"
            description={
              mac && exists && made === undefined
                ? `${name.trim()} is a machine already: its line makes it the agents' Mac, keeping its name and history.`
                : mac
                  ? "Its machine id. If this Mac runs fleetd already, give that machine's name: its line replaces it, keeping its history."
                  : "Its machine id: lower-case letters, digits and dashes."
            }
            error={tried ? (problem ?? (taken ? `${name.trim()} is a machine already: Repair it from the list.` : undefined)) : undefined}>
            <Input value={name} placeholder="laptop" autoComplete="off" mono onChange={(e) => setName(e.target.value)} disabled={made !== undefined && state !== "expired"} />
          </Field>
          {made === undefined || state === "expired" ? (
            <span>
              <Button type="submit" variant={made === undefined ? "primary" : "secondary"} disabled={busy}>
                {busy ? "Making…" : made === undefined ? "Make the line" : "Make a new line"}
              </Button>
            </span>
          ) : null}
        </form>
      )}
      {error === undefined ? null : <Text tone="danger">{error}</Text>}
      {made === undefined ? (
        props.rejoin && error === undefined ? <Text tone="quiet">Making the line…</Text> : null
      ) : (
        <div className={s.head} aria-label="The line">
          <div className={s.line}>
            <code className={s.lineText}>{made.join.line}</code>
            <Button size="sm" onClick={() => void copyText(made.join.line).then(setCopied)}>
              {copied === true ? "Copied" : "Copy"}
            </Button>
          </div>
          <Text size="sm" tone="quiet">
            {mac
              ? `${untilLine(made.join.expiresAt)} Paste it in Terminal on the Mac, logged in at its screen (su and ssh won't do). It opens Privacy & Security and waits for each grant.`
              : `${untilLine(made.join.expiresAt)} It joins as ${made.join.machineId}${made.join.gitIdentity === undefined ? "" : `, committing as ${made.join.gitIdentity}`}.`}
          </Text>
          {onlyHereLine(made.join.hubUrl) === undefined ? null : (
            <Text size="xs" tone="warning">
              {onlyHereLine(made.join.hubUrl)}
            </Text>
          )}
          {copied === false ? (
            <Text size="xs" tone="danger">
              {"Couldn't copy it. Select the line and copy it by hand."}
            </Text>
          ) : null}
        </div>
      )}
      {mac && made !== undefined ? <GuideParts parts={guide?.slice(2, rejoin ? 4 : 3) ?? []} from={2} /> : null}
      {mac ? (
        <>
          <Text size="sm" tone="quiet">
            Agents act as this Mac account. To keep them out of yours, give them their own user (see Setup › A Mac for agents).
          </Text>
          <span>
            <Button size="sm" variant="link" onClick={() => (window.location.hash = toHash({ id: "settings", tab: "hub.setup" }))}>
              Open Setup
            </Button>
          </span>
        </>
      ) : null}
      {state === undefined ? null : (
        <div className={s.wait} data-line={state}>
          <StateGlyph state={state === "joined" ? "done" : state === "expired" ? "failed" : "queued"} size="sm" />
          <Text size="sm" tone={state === "expired" ? "danger" : "default"}>
            {lineWords(state, made?.join.machineId ?? machineId)}
          </Text>
        </div>
      )}
      <div className={s.actions}>
        {state === "joined" && mac ? (
          <Button variant="primary" onClick={() => (window.location.hash = "#/setup/mac")}>
            {"Open the Mac's checks"}
          </Button>
        ) : state === "joined" ? (
          <Button variant="primary" onClick={() => (window.location.hash = toHash({ id: "settings", tab: "hub.machines", machine: machineId }))}>
            {`Open ${machineId}`}
          </Button>
        ) : null}
        {props.rejoin && state === "expired" ? (
          <Button variant="secondary" disabled={busy} onClick={make}>
            Make a new line
          </Button>
        ) : null}
        {state === "joined" ? <Button onClick={props.onDone}>Done</Button> : <Button onClick={props.onBack}>Back</Button>}
      </div>
    </>
  );
}

// Add machine (W105): an owner or admin makes a computer one of the hub's machines, without a terminal. Three ways:
//   - This computer: one click. Main first reads this computer's fleetd dir: one holding the hub goes through the hub
//     (machine_add local), one holding an enrolled node is a machine already; on any other, main downloads the hub's
//     own fleetd build, checks it, and joins with a one-time code (src/main/joinHere.ts).
//   - A machine the hub can reach: pick one of machine_hosts, see machine_add_plan's steps, Add, and watch each step;
//     a failed step shows its output, the fix and Retry (finished steps are skipped).
//   - Any other machine: name it, and paste the one line machine_join makes (fleetd pair --worker's) in its terminal.
//     "Waiting for <name>…" turns into "Joined" once its node is online; a code that expires first says so.
// Repair from the machine list opens the plan of a machine the hub reaches, or a line that enrolls it again.
// A run goes on in the hub when the page closes; opening it again shows the run still going or the last one that
// failed. Every step is a machine_add.step event, which reads machine_add_status again.
//
// One component with no page around it, so Administration › Machines and the hub's first-run setup (docs/design,
// its Machines step) show the same flow. Mount it only where the person is an owner or admin.
import { useEffect, useState, type ReactNode } from "react";
import type { MachineAddRun, MachineHost, MachineJoinOutput, SetupStep } from "../../../shared/contracts";
import type { JoinHere, ThisComputer } from "../../../shared/joinHere";
import { useData, useDataLayer, useToolQuery } from "../../src/data/react";
import { Button, copyText, Field, InlineCode, Input, StateGlyph, Text } from "../../ui";
import { errorText, useHubCall, useLive, useRefetch } from "../settings/hub";
import {
  glyphOf,
  hereLine,
  hereOf,
  hostLine,
  joinSteps,
  lineState,
  lineWords,
  machineIdProblem,
  pickable,
  resumable,
  runLine,
  runTitle,
  sentence,
  shortOutput,
  stepTitle,
  untilLine,
  type Here,
} from "./model";
import { toHash } from "../shell/routes";
import s from "./addMachine.module.css";

export type View =
  | { readonly kind: "choose" }
  | { readonly kind: "hosts" }
  | { readonly kind: "plan"; readonly host: MachineHost }
  | { readonly kind: "run"; readonly runId: string }
  | { readonly kind: "here" }
  /** Any other machine; with a machine id, a repair's line for it (`rejoin`). */
  | { readonly kind: "line"; readonly machineId?: string; readonly rejoin?: boolean };

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

/** `open`: a view to show, from outside (the machine list's Repair); `at` tells one click from the next. */
export function AddMachine({ open }: { open?: { readonly view: View; readonly at: number } | undefined } = {}) {
  const layer = useDataLayer();
  const live = useLive();
  const call = useHubCall();
  const refetch = useRefetch();
  const status = useToolQuery("machine_add_status", noInput);
  const hosts = useToolQuery("machine_hosts", noInput);
  const hostName = useHostName();
  const join = useJoinHere();
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

  const here =
    hosts.data && hostName !== undefined && computer !== undefined && !info.isPending ? hereOf(hosts.data.hosts, hubFingerprint, hostName, computer, new Set(Object.keys(machines))) : undefined;

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

  /** Back to the three ways, with the hosts read again: the one just added is a machine now. */
  const done = () => {
    setView({ kind: "choose" });
    refetch(["machine_hosts"]);
  };

  const addHere = (h: Here) => {
    setProblem(undefined);
    if (h.kind === "hub") return add({ local: true });
    if (h.kind === "node" || h.kind === "other-hub") return;
    setView({ kind: "here" });
    void window.fleetd.machines.joinHere(layer.hub, h.machineId);
  };

  return (
    <section className={s.panel} aria-label="Add machine" data-state={shown.kind}>
      {!live ? (
        <Text tone="quiet">Connect to the hub to add a machine.</Text>
      ) : shown.kind === "choose" ? (
        <Choose here={here} busy={busy} onHere={addHere} onHosts={() => setView({ kind: "hosts" })} onLine={() => setView({ kind: "line" })} />
      ) : shown.kind === "hosts" ? (
        <Hosts read={hosts} onPick={(host) => setView({ kind: "plan", host })} onBack={() => setView({ kind: "choose" })} />
      ) : shown.kind === "plan" ? (
        <Plan host={shown.host} busy={busy} onAdd={() => add(shown.host.host === undefined ? { local: true } : { host: shown.host.host })} onBack={() => setView({ kind: "hosts" })} />
      ) : shown.kind === "run" ? (
        <Run
          run={runs?.find((r) => r.runId === shown.runId)}
          pending={status.isPending}
          busy={busy}
          onRetry={(r) => add(r.host === undefined ? { local: true } : { host: r.host })}
          onDone={done}
        />
      ) : shown.kind === "line" ? (
        <Line key={`${shown.machineId ?? ""}-${String(open?.at ?? 0)}`} machineId={shown.machineId} rejoin={shown.rejoin === true} onDone={done} />
      ) : (
        <JoinHereRun join={join} onRetry={() => here && addHere(here)} onDone={done} />
      )}
      {problem === undefined ? null : <Text tone="danger">{problem}</Text>}
    </section>
  );
}

function Head(props: { title: string; line?: ReactNode }) {
  return (
    <div className={s.head}>
      <Text strong>{props.title}</Text>
      {props.line === undefined ? null : (
        <Text size="xs" tone="quiet">
          {props.line}
        </Text>
      )}
    </div>
  );
}

function Choose(props: { here: Here | undefined; busy: boolean; onHere: (h: Here) => void; onHosts: () => void; onLine: () => void }) {
  const { here } = props;
  return (
    <>
      <Head title="Add machine" line="A machine runs agents and their browsers and devices. It needs claude installed." />
      <ul className={s.rows}>
        <li className={s.row}>
          <div className={s.rowText}>
            <Text>This computer</Text>
            <Text size="xs" tone="quiet">
              {hereLine(here)}
            </Text>
          </div>
          {here?.kind === "node" || here?.kind === "other-hub" ? null : (
            <Button className={s.rowAction} disabled={here === undefined || props.busy} onClick={() => here && props.onHere(here)}>
              {here?.joined ? "Repair" : "Add this computer"}
            </Button>
          )}
        </li>
        <li className={s.row}>
          <div className={s.rowText}>
            <Text>A machine the hub can reach</Text>
            <Text size="xs" tone="quiet">
              Over SSH from the hub: one in its ~/.ssh/config or on its tailnet.
            </Text>
          </div>
          <Button className={s.rowAction} onClick={props.onHosts}>
            Choose…
          </Button>
        </li>
        <li className={s.row}>
          <div className={s.rowText}>
            <Text>Any other machine</Text>
            <Text size="xs" tone="quiet">
              A laptop, or one behind NAT: one line to paste in its terminal. It must reach the hub.
            </Text>
          </div>
          <Button className={s.rowAction} onClick={props.onLine}>
            Get the line…
          </Button>
        </li>
      </ul>
    </>
  );
}

function Hosts(props: { read: ReturnType<typeof useToolQuery<"machine_hosts">>; onPick: (h: MachineHost) => void; onBack: () => void }) {
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
        <Text tone="danger">{`Couldn't list them: ${errorText(props.read.error)}`}</Text>
      ) : hosts === undefined ? (
        <Text tone="quiet">Looking…</Text>
      ) : (
        <ul className={s.rows} aria-label="Hosts">
          {pickable(hosts).map((h) => (
            <li key={h.machineId} className={s.row}>
              <div className={s.rowText}>
                <Text tone={h.joined ? "quiet" : "default"}>{h.machineId}</Text>
                <Text size="xs" tone="quiet">
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
        <Button variant="ghost" onClick={props.onBack}>
          Back
        </Button>
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
        <span>
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
          <Text size="xs" tone="quiet">
            {n}
          </Text>
        </li>
      ))}
    </ul>
  );
}

function Plan(props: { host: MachineHost; busy: boolean; onAdd: () => void; onBack: () => void }) {
  const input = props.host.host === undefined ? { local: true as const } : { host: props.host.host };
  const plan = useToolQuery("machine_add_plan", input);
  const m = props.host.machineId;
  return (
    <>
      <Head
        title={props.host.joined ? `Repair ${m}` : `Add ${m}`}
        line={plan.data ? `${plan.data.platform} · ${hostLine(props.host)}. Nothing has changed on it yet.` : `Reading ${m} over SSH; nothing changes on it.`}
      />
      {plan.error ? (
        <Text tone="danger">{errorText(plan.error)}</Text>
      ) : plan.data === undefined ? (
        <Text tone="quiet">Reading the machine…</Text>
      ) : (
        <>
          <Steps steps={plan.data.steps} />
          <Notes notes={plan.data.notes} />
        </>
      )}
      <div className={s.actions}>
        <Button variant="primary" disabled={plan.data === undefined || props.busy} onClick={props.onAdd}>
          {props.host.joined ? `Repair ${m}` : `Add ${m}`}
        </Button>
        <Button variant="ghost" onClick={props.onBack}>
          Back
        </Button>
      </div>
    </>
  );
}

function Run(props: { run: MachineAddRun | undefined; pending: boolean; busy: boolean; onRetry: (r: MachineAddRun) => void; onDone: () => void }) {
  const { run } = props;
  const online = useOnline(run?.machineId);
  if (run === undefined) {
    return props.pending ? (
      <Text tone="quiet">Loading…</Text>
    ) : (
      <>
        <Text tone="quiet">The hub no longer has this run: it restarted. Add the machine again; finished steps are skipped.</Text>
        <div className={s.actions}>
          <Button onClick={props.onDone}>Back</Button>
        </div>
      </>
    );
  }
  return (
    <>
      <Head title={runTitle(run)} line={runLine(run, online)} />
      <Steps steps={run.steps} />
      {run.state === "failed" ? (
        <div className={s.head}>
          {run.message === undefined ? null : <Text tone="danger">{sentence(run.message.split("\n")[0] ?? "")}</Text>}
          {run.fix === undefined ? null : (
            <Text size="xs" tone="quiet">
              {sentence(run.fix)}
            </Text>
          )}
        </div>
      ) : null}
      <Notes notes={run.notes} />
      <div className={s.actions}>
        {run.state === "failed" ? (
          <Button variant="primary" disabled={props.busy} onClick={() => props.onRetry(run)}>
            Retry
          </Button>
        ) : null}
        {run.state === "running" ? null : (
          <Button variant={run.state === "failed" ? "ghost" : "secondary"} onClick={props.onDone}>
            {run.state === "failed" ? "Back" : "Done"}
          </Button>
        )}
      </div>
    </>
  );
}

function JoinHereRun(props: { join: JoinHere | null; onRetry: () => void; onDone: () => void }) {
  const online = useOnline(props.join?.machineId);
  const { join } = props;
  if (join === null) return <Text tone="quiet">Starting…</Text>;
  return (
    <>
      <Head title={`${join.machineId}, this computer`} line={runLine(join, online)} />
      <Steps steps={joinSteps(join, online)} />
      {join.state === "failed" && join.message !== undefined ? <Text tone="danger">{join.message}</Text> : null}
      <div className={s.actions}>
        {join.state === "failed" ? (
          <Button variant="primary" onClick={props.onRetry}>
            Retry
          </Button>
        ) : null}
        {join.state === "running" ? null : (
          <Button variant={join.state === "failed" ? "ghost" : "secondary"} onClick={props.onDone}>
            {join.state === "failed" ? "Back" : "Done"}
          </Button>
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
function Line(props: { machineId: string | undefined; rejoin: boolean; onDone: () => void }) {
  const call = useHubCall();
  const machines = useData((d) => d.machines);
  const [name, setName] = useState(props.machineId ?? "");
  const [tried, setTried] = useState(false);
  // A repair's line is being made as it opens.
  const [busy, setBusy] = useState(props.rejoin);
  const [error, setError] = useState<string>();
  const [made, setMade] = useState<{ readonly join: MachineJoinOutput; readonly onlineAtStart: boolean }>();
  const [copied, setCopied] = useState<boolean>();
  const now = useNow();
  const problem = machineIdProblem(name);
  const machineId = made?.join.machineId ?? name.trim();
  const online = useOnline(made === undefined ? undefined : machineId);
  // Once its line is made, the machine coming online is the point, not a clash.
  const taken = !props.rejoin && made === undefined && machines[name.trim()] !== undefined;

  const request = (id: string) =>
    call("machine_join", props.rejoin ? { machineId: id, rejoin: true } : { machineId: id })
      .then(
        (join) => setMade({ join, onlineAtStart: (machines[id]?.status ?? "offline") !== "offline" }),
        (e: unknown) => setError(errorText(e)),
      )
      .finally(() => setBusy(false));
  const make = () => {
    setTried(true);
    if (problem !== undefined || taken) return;
    setBusy(true);
    setError(undefined);
    setCopied(undefined);
    void request(name.trim());
  };
  // A repair knows its machine: its line comes at once.
  useEffect(() => {
    if (props.rejoin && props.machineId !== undefined) void request(props.machineId);
    // Once, as the view opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const state = made === undefined ? undefined : lineState({ expiresAt: made.join.expiresAt, onlineAtStart: made.onlineAtStart }, online, now);
  return (
    <>
      <Head
        title={props.rejoin ? `Repair ${props.machineId ?? ""}` : "Any other machine"}
        line={
          props.rejoin
            ? "Run this line in a terminal on it: it installs this hub's fleetd again and enrolls the machine with a new code."
            : "Run one line in a terminal on it: it installs this hub's fleetd and joins. The machine needs claude and must reach the hub."
        }
      />
      {props.rejoin ? null : (
        <form
          className={s.lineForm}
          aria-label="Name the machine"
          onSubmit={(e) => {
            e.preventDefault();
            make();
          }}
        >
          <Field label="Name" description="Its machine id: lower-case letters, digits and dashes." error={tried ? (problem ?? (taken ? `${name.trim()} is a machine already: Repair it from the list.` : undefined)) : undefined}>
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
          <Text size="xs" tone="quiet">
            {`${untilLine(made.join.expiresAt)} It joins as ${made.join.machineId}${made.join.gitIdentity === undefined ? "" : `, committing as ${made.join.gitIdentity}`}.`}
          </Text>
          {copied === false ? (
            <Text size="xs" tone="danger">
              {"Couldn't copy it. Select the line and copy it by hand."}
            </Text>
          ) : null}
        </div>
      )}
      {state === undefined ? null : (
        <div className={s.wait} data-line={state}>
          <StateGlyph state={state === "joined" || state === "online" ? "done" : state === "expired" ? "failed" : "queued"} size="sm" />
          <Text size="sm" tone={state === "expired" ? "danger" : "default"}>
            {lineWords(state, made?.join.machineId ?? machineId)}
          </Text>
        </div>
      )}
      <div className={s.actions}>
        {state === "joined" ? (
          <Button variant="primary" onClick={() => (window.location.hash = toHash({ id: "admin", section: "machines", machine: machineId }))}>
            {`Open ${machineId}`}
          </Button>
        ) : null}
        {props.rejoin && state === "expired" ? (
          <Button variant="secondary" disabled={busy} onClick={make}>
            Make a new line
          </Button>
        ) : null}
        <Button variant={state === "joined" ? "secondary" : "ghost"} onClick={props.onDone}>
          {state === "joined" ? "Done" : "Back"}
        </Button>
      </div>
    </>
  );
}

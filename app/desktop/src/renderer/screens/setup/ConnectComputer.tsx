// Where agents run (hosted-plan §1, D558): where an owner or admin signed in to fleetd cloud lands while their team has
// nothing to run agents on. Either way is enough: a computer of theirs (Connect this computer has main ask the hub for
// a join line and run it in a terminal; under it, a line of its own to copy for any other computer, which carries no
// machine name: a computer joins under its own), or a hosted sandbox provider on their own key, connected right here as
// in Settings. The screen moves on when a machine, or the hub's runner for hosted sandboxes, shows up in its list; the
// runner's agents need a Claude account of the team's, which it asks for until one reaches them. Hosted sandboxes that
// don't get ready within a bounded wait (./hostedWait.ts) say why, with the fix and Try again.
import { useCallback, useEffect, useRef, useState } from "react";
import type { MachineJoinOutput } from "../../../shared/contracts";
import type { ConnectComputerOutcome } from "../../../shared/cloud";
import { useData, useHub, useToolQuery } from "../../src/data/react";
import { Button, copyText, Segmented, StateGlyph, Text } from "../../ui";
import { useProviderRows } from "../settings/Providers";
import { navigate } from "../shell/navigation";
import { untilLine } from "../addMachine/model";
import { errorText, useHubCall, useRefetch } from "../settings/hub";
import { hostedProblem, runnerNeedsClaude, useWaitedOut, type RunnerState } from "./hostedWait";
import s from "./connectComputer.module.css";
import { onWeb } from "../../src/web";

/** Now, and again every 15 s, for the line's expiry. */
const useNow = (): number => {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 15_000);
    return () => window.clearInterval(id);
  }, []);
  return now;
};

/** Each hub's machines when its Where agents run opened, kept across a remount: what joins (a computer, the hub's
 * runner) comes with a resync, whose fresh snapshot mounts the home again. Dropped once the person moves on. */
const opened = new Map<string, ReadonlySet<string>>();

/** Whether Where agents run is open on hub `hub` (FirstRun keeps showing it). */
export const whereOpen = (hub: string): boolean => opened.has(hub);

export function ConnectComputer({ onAddProject }: { onAddProject: () => void }) {
  const hub = useHub();
  const machines = useData((d) => d.machines);
  // The machines there were when this view opened (or Connect another computer was pressed): one more is the one
  // that joined.
  const [before, setBefore] = useState<ReadonlySet<string>>(() => opened.get(hub.id) ?? new Set(Object.keys(machines)));
  useEffect(() => void opened.set(hub.id, before), [hub.id, before]);
  const joined = Object.values(machines).find((m) => !before.has(m.machineId));
  const another = () => setBefore(new Set(Object.keys(machines)));
  const moveOn = () => {
    opened.delete(hub.id);
    onAddProject();
  };
  // The hub's runner: its sandboxes run agents only once a Claude account of the team's reaches them.
  if (joined?.runner === true && joined.status !== "online") return <HostedNotReady runner={joined} />;
  if (joined !== undefined) return <Joined name={joined.name} many={joined.runner === true} onAddProject={moveOn} onAnother={another} />;
  return <Connect />;
}

const noInput = {};

/** Hosted sandboxes connected, their agents not able to run yet: Connect Claude, or a moment while they come up; past
 * the wait, why they aren't ready, its fix and Try again. */
function HostedNotReady({ runner }: { runner: RunnerState }) {
  const claude = runnerNeedsClaude(runner);
  const call = useHubCall();
  const refetch = useRefetch();
  const sandboxes = useToolQuery("sandbox_get", noInput);
  const provider = sandboxes.data?.providers.find((p) => p.connected);
  const wait = useWaitedOut(!claude);
  const [trying, setTrying] = useState(false);
  const [tried, setTried] = useState<string | null>(null);
  const cloud = useHub().cloud === true;
  const problem = wait.over && provider !== undefined ? hostedProblem(provider, runner, cloud) : undefined;
  const again = () => {
    if (provider === undefined) return;
    setTrying(true);
    setTried(null);
    call("sandbox_test", { provider: provider.provider }).then(
      () => {
        setTrying(false);
        refetch(["sandbox_get"]);
        wait.again();
      },
      (e: unknown) => {
        setTrying(false);
        setTried(errorText(e));
      },
    );
  };
  if (problem !== undefined)
    return (
      <div className={s.screen} data-screen="setup.machine.hosted.not-ready">
        <div className={s.column}>
          <div className={s.head}>
            <Text as="h1" size="xl" strong>
              Hosted sandboxes aren't ready
            </Text>
            <span role="alert">
              <Text as="p" tone="warning">
                {problem.reason}
              </Text>
            </span>
            <Text as="p" tone="quiet">
              {tried ?? problem.fix}
            </Text>
          </div>
          <div className={s.next}>
            <Button variant="primary" className={s.connect} disabled={trying} onClick={again}>
              {trying ? "Trying again…" : "Try again"}
            </Button>
          </div>
        </div>
      </div>
    );
  return (
    <div className={s.screen} data-screen="setup.machine.hosted">
      <div className={s.column}>
        <div className={s.head}>
          <Text as="h1" size="xl" strong>
            Hosted sandboxes are connected
          </Text>
          <Text as="p" tone="quiet">
            {claude ? "Connect Claude, so their agents can work." : "Getting the sandboxes ready…"}
          </Text>
        </div>
        {claude ? (
          <div className={s.next}>
            <Button variant="primary" className={s.connect} onClick={() => navigate({ id: "settings", tab: "accounts" })}>
              Connect Claude
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function Connect() {
  const hub = useHub();
  // The second way agents run: the team's own hosted sandbox providers, connected right here.
  const hosted = useProviderRows(["agents"]);
  const [way, setWay] = useState<"computer" | "hosted">("computer");
  const call = useHubCall();
  const now = useNow();
  const [join, setJoin] = useState<MachineJoinOutput | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [here, setHere] = useState<ConnectComputerOutcome | "opening" | null>(null);
  const [copied, setCopied] = useState(false);
  // Set again on every mount: StrictMode's dev double mount runs the cleanup once in between.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const request = useCallback(() => {
    call("machine_join", {}).then(
      (out) => mounted.current && setJoin(out),
      (e: unknown) => mounted.current && setError(errorText(e)),
    );
  }, [call]);
  useEffect(request, [request]);
  const make = () => {
    setError(null);
    setCopied(false);
    request();
  };
  const expired = join !== null && Date.parse(join.expiresAt) <= now;
  const connectHere = () => {
    setHere("opening");
    void window.fleetd.cloud.connectComputer(hub.id).then((out) => mounted.current && setHere(out));
  };
  const opened = here !== null && here !== "opening" && here.ok;
  const noTerminal = here !== null && here !== "opening" && !here.ok ? here.message : null;
  return (
    <div className={s.screen} data-screen="setup.machine">
      <div className={s.column}>
        <div className={s.head}>
          <Text as="h1" size="xl" strong>
            Where agents run
          </Text>
        </div>
        {hosted ? (
          <Segmented
            label="Where agents run"
            options={[
              { value: "computer", label: "A computer" },
              { value: "hosted", label: "Hosted sandboxes" },
            ]}
            value={way}
            onChange={setWay}
          />
        ) : null}
        {way === "hosted" && hosted ? (
          <div className={s.hosted}>{hosted}</div>
        ) : (
          <>
          {/* A browser opens no terminal: the line below is the way, on this computer too. */}
          {onWeb() ? null : opened ? (
            <div className={s.status} role="status">
              <StateGlyph state="thinking" />
              <div className={s.words}>
                <Text>Connecting this computer…</Text>
                <Text size="sm" tone="quiet">
                  {`${here.terminal === "Terminal" ? "Terminal" : "The terminal"} is installing fleetd and joining. This screen moves on by itself when it has.`}
                </Text>
              </div>
            </div>
          ) : (
            <div className={s.here}>
              <Button variant="primary" className={s.connect} disabled={here === "opening"} onClick={connectHere}>
                {here === "opening" ? "Opening a terminal…" : "Connect this computer"}
              </Button>
              {noTerminal === null ? (
                <Text size="sm" tone="quiet">
                  A terminal opens, installs fleetd and joins. Agents run while this computer is on and awake.
                </Text>
              ) : (
                <span role="alert">
                  <Text size="sm" tone="warning">
                    {noTerminal}
                  </Text>
                </span>
              )}
            </div>
          )}
          <section className={s.other} aria-label="On another computer">
            <Text as="h2" size="sm" strong tone="quiet">
              {onWeb() ? "On your computer" : noTerminal === null ? "On another computer" : "On this or another computer"}
            </Text>
            {error !== null ? (
              <span role="alert">
                <Text size="sm" tone="danger">
                  {error}
                </Text>
              </span>
            ) : join === null ? (
              <Text size="sm" tone="quiet">
                Making a line…
              </Text>
            ) : (
              <>
                <div className={s.line} data-expired={expired || undefined}>
                  <code className={s.lineText}>{join.line}</code>
                  {expired ? (
                    <Button onClick={make}>New line</Button>
                  ) : (
                    <Button onClick={() => void copyText(join.line).then(setCopied)} onBlur={() => setCopied(false)}>
                      {copied ? "Copied" : "Copy"}
                    </Button>
                  )}
                </div>
                <Text size="sm" tone="quiet">
                  {expired
                    ? "This line's code ran out. A code works once, for 15 minutes, so make a new line."
                    : `Paste it in a terminal there, on macOS or Linux. The computer shows up here by itself. ${untilLine(join.expiresAt)}`}
                </Text>
              </>
            )}
          </section>
          </>
        )}
      </div>
    </div>
  );
}

/** `many`: hosted sandboxes, whose name is a plural. */
function Joined({ name, many, onAddProject, onAnother }: { name: string; many: boolean; onAddProject: () => void; onAnother: () => void }) {
  return (
    <div className={s.screen} data-screen="setup.machine.joined">
      <div className={s.column}>
        <div className={s.head}>
          <Text as="h1" size="xl" strong>
            {`${name} ${many ? "are" : "is"} connected`}
          </Text>
          <Text as="p" tone="quiet">
            Agents run there from now on. Start a bot to give them work.
          </Text>
        </div>
        <div className={s.machine}>
          <StateGlyph state="done" still settled />
          <div className={s.words}>
            <Text>{name}</Text>
            <Text size="sm" tone="quiet">
              Joined just now
            </Text>
          </div>
        </div>
        <div className={s.next}>
          <Button variant="primary" className={s.connect} onClick={onAddProject}>
            New bot
          </Button>
          <Button variant="quiet" size="md" onClick={onAnother}>
            Connect another computer
          </Button>
        </div>
      </div>
    </div>
  );
}

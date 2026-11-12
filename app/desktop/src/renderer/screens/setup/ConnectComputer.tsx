// Connect a computer (hosted-plan §1): where an owner or admin signed in to fleetd cloud lands while their team has
// no machine. fleetd hosts only the hub, so a computer of theirs is the one step between signing in and a running
// agent. Connect this computer has main ask the hub for a join line and run it in a terminal; under it, a line of
// its own to copy for any other computer. Both lines carry no machine name: a computer joins under its own. The
// screen moves on when a machine shows up in the hub's list.
import { useCallback, useEffect, useRef, useState } from "react";
import type { MachineJoinOutput } from "../../../shared/contracts";
import type { ConnectComputerOutcome } from "../../../shared/cloud";
import { useData, useHub } from "../../src/data/react";
import { Button, copyText, StateGlyph, Text } from "../../ui";
import { untilLine } from "../addMachine/model";
import { errorText, useHubCall } from "../settings/hub";
import s from "./connectComputer.module.css";

/** Now, and again every 15 s, for the line's expiry. */
const useNow = (): number => {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 15_000);
    return () => window.clearInterval(id);
  }, []);
  return now;
};

export function ConnectComputer({ onAddProject }: { onAddProject: () => void }) {
  const machines = useData((d) => d.machines);
  // The machines there were when this view opened (or Connect another computer was pressed): one more is the one
  // that joined.
  const [before, setBefore] = useState<ReadonlySet<string>>(() => new Set(Object.keys(machines)));
  const joined = Object.values(machines).find((m) => !before.has(m.machineId));
  if (joined !== undefined) {
    return <Joined name={joined.name} onAddProject={onAddProject} onAnother={() => setBefore(new Set(Object.keys(machines)))} />;
  }
  return <Connect />;
}

function Connect() {
  const hub = useHub();
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
            Connect a computer
          </Text>
          <Text as="p" tone="quiet">
            Your agents run on it, with its Claude login and your code. fleetd hosts only the hub.
          </Text>
        </div>
        {opened ? (
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
            {noTerminal === null ? "On another computer" : "On this or another computer"}
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
      </div>
    </div>
  );
}

function Joined({ name, onAddProject, onAnother }: { name: string; onAddProject: () => void; onAnother: () => void }) {
  return (
    <div className={s.screen} data-screen="setup.machine.joined">
      <div className={s.column}>
        <div className={s.head}>
          <Text as="h1" size="xl" strong>
            {`${name} is connected`}
          </Text>
          <Text as="p" tone="quiet">
            Agents run on it from now on. Start a project to give them work.
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
            New project
          </Button>
          <Button variant="quiet" size="md" onClick={onAnother}>
            Connect another computer
          </Button>
        </div>
      </div>
    </div>
  );
}

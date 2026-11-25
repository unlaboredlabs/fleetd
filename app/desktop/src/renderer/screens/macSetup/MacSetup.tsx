// Set up this Mac for agents (D309): its own small window (`#/mac-setup`), never the full interface. One step at a
// time (model.ts): the 6-digit code, a replace to confirm when there is one, the join as main runs it, then the node's
// own checks read every second: the two privacy grants, each asked of macOS by the node and its pane opened, and the Test, every
// check green. The page holds no hub key and no token: main trades the code and runs the CLI (src/main/macSetup.ts).
// A version difference is one line and one fix: an app too old for the hub gets its Update button; a hub older than
// the build this Mac got gets Update right there for an admin signed in here, and where to press it for anyone else.
import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import type { MacSetupFailure } from "../../../shared/macSetup";
import { Check } from "lucide-react";
import { Button, Field, Input, StateGlyph, Text } from "../../ui";
import { Mark } from "../onboarding/Mark";
import { UpdateAppButton } from "../updates/UpdateAppButton";
import { digitsOf, initial, READ_EVERY_MS, reduce, setupRows, spaced, stepOf, STEPS, type RowAction, type RowState, type State } from "./model";
import { HubBehindLine, MacStatus } from "./MacStatus";
import s from "./macSetup.module.css";

const useNow = (every: number): number => {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), every);
    return () => window.clearInterval(timer);
  }, [every]);
  return now;
};

export function MacSetup() {
  const [state, dispatch] = useReducer(reduce, initial);
  const now = useNow(1000);

  // Opened again: on where the setup stands, as main knows it (a join running, a node joined, a code spent).
  useEffect(() => {
    void window.fleetd.macSetup.status().then((status) => dispatch({ type: "resume", status, at: Date.now() }));
  }, []);

  // The code is traded once it is submitted; main finds the hub unless the person typed one.
  const submitting = state.step === "code" && state.busy;
  useEffect(() => {
    if (state.step !== "code" || !state.busy) return;
    const hub = state.askHub && state.hub.trim() !== "" ? state.hub.trim() : undefined;
    void window.fleetd.macSetup.redeem({ code: state.code, ...(hub === undefined ? {} : { hub }) }).then((outcome) => dispatch({ type: "redeemed", outcome }));
    // Once per submit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [submitting]);

  // Each change of the join comes from main, heard for as long as its step is open: the first report sets the
  // step's join, and every later one must still arrive.
  const onJoinStep = state.step === "join";
  useEffect(() => {
    if (!onJoinStep) return;
    return window.fleetd.macSetup.onJoin((join) => dispatch({ type: "join", join, at: Date.now() }));
  }, [onJoinStep]);
  // The join starts as its step opens, and again on a retry.
  const joining = onJoinStep && state.join === undefined;
  useEffect(() => {
    if (!joining) return;
    void window.fleetd.macSetup.join().then((join) => dispatch({ type: "join", join, at: Date.now() }));
  }, [joining]);

  // The node's checks, read every second while the check step is open. A read still out (a hub slow to answer
  // its /healthz) skips the tick, so reads never overlap or land out of order.
  const hubUrl = state.step === "check" ? state.found.hubUrl : undefined;
  useEffect(() => {
    if (hubUrl === undefined) return;
    let live = true;
    let reading = false;
    const read = () => {
      if (reading) return;
      reading = true;
      void window.fleetd.macSetup
        .health(hubUrl)
        .then((r) => {
          if (live) dispatch({ type: "health", read: r });
        })
        .finally(() => {
          reading = false;
        });
    };
    read();
    const timer = window.setInterval(read, READ_EVERY_MS);
    return () => {
      live = false;
      window.clearInterval(timer);
    };
  }, [hubUrl]);

  const restarting = state.step === "check" && state.restarting;
  useEffect(() => {
    if (!restarting) return;
    void window.fleetd.macSetup.restart().then((outcome) => dispatch({ type: "restarted", outcome, at: Date.now() }));
  }, [restarting]);

  const current = stepOf(state, now);
  return (
    <div className={s.window} data-screen="mac-setup" data-step={state.step}>
      <div className={s.titlebar} />
      <main className={s.column}>
        {state.step === "status" ? null : (
        <ol className={s.progress} aria-label="Steps">
          {STEPS.map((name, i) => {
            const at = STEPS.indexOf(current);
            return (
              <li key={name} className={s.progressStep} data-state={i < at ? "done" : i === at ? "current" : "next"} aria-current={i === at ? "step" : undefined}>
                <span className={s.progressDot} />
                {name}
              </li>
            );
          })}
        </ol>
        )}
        <Body state={state} now={now} dispatch={dispatch} />
      </main>
    </div>
  );
}

function Head({ title, line, face }: { title: string; line?: string | undefined; face?: "mark" | "ready" | undefined }) {
  return (
    <header className={s.head}>
      {face === "mark" ? <Mark className={s.face} /> : null}
      {face === "ready" ? (
        <span className={s.ready} aria-hidden>
          <Check size={28} strokeWidth={2.5} />
        </span>
      ) : null}
      <Text as="h1" size="xl" strong>
        {title}
      </Text>
      {line === undefined ? null : (
        <Text as="p" tone="quiet">
          {line}
        </Text>
      )}
    </header>
  );
}

function Failure({ failure }: { failure: MacSetupFailure }) {
  return (
    <div className={s.failure} role="alert">
      <Text tone="danger">{failure.message}</Text>
      {failure.fix === undefined ? null : <Text tone="quiet">{failure.fix}</Text>}
      {failure.updateApp === true ? (
        <div className={s.actions}>
          <UpdateAppButton />
        </div>
      ) : null}
    </div>
  );
}

type Dispatch = (event: Parameters<typeof reduce>[1]) => void;

function Body({ state, now, dispatch }: { state: State; now: number; dispatch: Dispatch }) {
  switch (state.step) {
    case "code":
      return <CodeStep state={state} dispatch={dispatch} />;
    case "confirm": {
      const { found, replaces } = state;
      const replacing =
        replaces === undefined
          ? ""
          : found.here.kind === "node"
            ? ` This Mac's fleetd is ${found.here.machineId}${found.here.hub === "" ? "" : ` of ${found.here.hub}`} now: joining replaces that node.`
            : ` ${found.machineId} is ${found.hubName}'s agents' Mac already: joining replaces it in place, keeping its name and history.`;
      const line = state.resumed === true
        ? `${found.hubName} took your code, but this Mac hasn't joined yet. Join now as ${found.machineId}, or cancel: the code is spent either way.${replacing}`
        : found.here.kind === "node"
          ? `This Mac's fleetd is ${found.here.machineId}${found.here.hub === "" ? "" : ` of ${found.here.hub}`} now. Setting it up as the agents' Mac replaces that node: it joins ${found.hubName} as ${found.machineId}.`
          : `${found.machineId} is ${found.hubName}'s agents' Mac already. Setting it up again replaces it in place, keeping its name and history.`;
      // The hub took the code: cancelling spends it, and the window says so (main's status).
      const cancel = () =>
        void window.fleetd.macSetup
          .cancel()
          .then(() => window.fleetd.macSetup.status())
          .then((status) => {
            dispatch({ type: "startOver" });
            dispatch({ type: "resume", status, at: Date.now() });
          });
      return (
        <>
          <Head title={state.resumed === true ? `Finish joining ${found.hubName}?` : `Replace ${replaces ?? found.machineId}?`} line={line} />
          <div className={s.actions}>
            <Button variant="primary" size="md" autoFocus onClick={() => dispatch({ type: "confirm" })}>
              {state.resumed === true ? "Join now" : "Replace and continue"}
            </Button>
            <Button variant="ghost" size="md" onClick={cancel}>
              Cancel
            </Button>
          </div>
        </>
      );
    }
    case "join":
      return <JoinStep state={state} dispatch={dispatch} />;
    case "check":
      return <CheckStep state={state} now={now} dispatch={dispatch} />;
    case "status":
      return <StatusStep found={state.found} dispatch={dispatch} />;
  }
}

/** The Mac at work; once it stops being the agents' Mac outside this window, the window says so with a new code. */
function StatusStep({ found, dispatch }: { found: Extract<State, { step: "status" }>["found"]; dispatch: Dispatch }) {
  const gone = useCallback(
    () =>
      void window.fleetd.macSetup.status().then((status) => {
        dispatch({ type: "startOver" });
        dispatch({ type: "resume", status, at: Date.now() });
      }),
    [dispatch],
  );
  return <MacStatus found={found} gone={gone} />;
}

function CodeStep({ state, dispatch }: { state: Extract<State, { step: "code" }>; dispatch: Dispatch }) {
  const field = useRef<HTMLInputElement>(null);
  const hubField = useRef<HTMLInputElement>(null);
  // A failure about the code puts the caret back in it; one about the hub, in the address.
  useEffect(() => {
    if (state.busy) return;
    (state.failure?.field === "hub" ? hubField : field).current?.focus();
  }, [state.busy, state.failure]);
  // The sixth digit submits, unless the person is still to give the address.
  useEffect(() => {
    if (state.code.length === 6 && !state.busy && state.failure === undefined && !(state.askHub && state.hub.trim() === "")) dispatch({ type: "submit" });
    // On the code alone: a hub typed after it waits for Continue.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.code]);
  return (
    <form
      className={s.form}
      aria-label="Setup code"
      onSubmit={(e) => {
        e.preventDefault();
        dispatch({ type: "submit" });
      }}
    >
      <Head face="mark" title="Set up this Mac for agents" />
      {state.notice === undefined ? null : (
        <div className={s.notice} role="status">
          <Text size="sm" strong>
            {state.notice.message}
          </Text>
          {state.notice.fix === undefined ? null : (
            <Text size="sm" tone="quiet">
              {state.notice.fix}
            </Text>
          )}
        </div>
      )}
      <div className={s.codeBlock}>
        <label className={s.codeLabel} htmlFor="mac-code">
          <Text size="sm" tone="quiet">
            The code from Add machine › A Mac for agents
          </Text>
        </label>
        <input
          id="mac-code"
          ref={field}
          className={s.code}
          value={spaced(state.code)}
          placeholder="000 000"
          inputMode="numeric"
          autoComplete="one-time-code"
          spellCheck={false}
          aria-invalid={state.failure?.field === "code" ? true : undefined}
          disabled={state.busy}
          onChange={(e) => dispatch({ type: "code", value: digitsOf(e.target.value) })}
        />
      </div>
      {state.askHub ? (
        <Field label="Workspace address" description="Shown under the code on your main machine.">
          <Input ref={hubField} value={state.hub} placeholder="http://devbox:4790" mono autoComplete="off" disabled={state.busy} onChange={(e) => dispatch({ type: "hub", value: e.target.value })} />
        </Field>
      ) : null}
      {state.failure === undefined ? null : <Failure failure={state.failure} />}
      {state.choices === undefined ? null : (
        <ul className={s.choices} aria-label="Workspaces this Mac found">
          {state.choices.map((hub) => (
            <li key={hub}>
              <Button variant="secondary" size="md" disabled={state.busy} onClick={() => dispatch({ type: "pick", hub })}>
                {hub.replace(/^https?:\/\//u, "")}
              </Button>
            </li>
          ))}
        </ul>
      )}
      {/* An app too old for the hub has one thing to do: its Update. A new code typed brings Continue back. */}
      {state.failure?.updateApp === true ? null : (
        <div className={s.actions}>
          <Button type="submit" variant="primary" size="md" disabled={state.busy || state.code.length !== 6}>
            {state.busy ? (state.askHub && state.hub.trim() !== "" ? "Asking the workspace…" : "Finding your workspace…") : "Continue"}
          </Button>
          {state.askHub ? null : (
            <Button type="button" variant="ghost" size="md" disabled={state.busy} onClick={() => dispatch({ type: "askHub" })}>
              Type the workspace's address
            </Button>
          )}
        </div>
      )}
      <div className={s.back}>
        <Button type="button" variant="link" size="sm" disabled={state.busy} onClick={() => void window.fleetd.macSetup.exit()}>
          Back
        </Button>
      </div>
    </form>
  );
}

const glyphOf = (state: string): "done" | "failed" | "working" | "queued" =>
  state === "done" ? "done" : state === "failed" ? "failed" : state === "running" ? "working" : "queued";

function JoinStep({ state, dispatch }: { state: Extract<State, { step: "join" }>; dispatch: Dispatch }) {
  const { found, join } = state;
  const failed = join?.state === "failed";
  return (
    <>
      <Head title={failed ? "Joining stopped" : `Joining ${found.hubName}`} />
      <ol className={s.steps}>
        {(join?.steps ?? []).map((step) => (
          <li key={step.title} className={s.stepRow} data-state={step.state}>
            <StateGlyph state={glyphOf(step.state)} size="sm" />
            <span className={s.stepText}>
              <Text size="sm" tone={step.state === "planned" ? "quiet" : "default"}>
                {step.title.charAt(0).toUpperCase() + step.title.slice(1)}
              </Text>
              {step.state === "failed" && step.output ? <pre className={s.output}>{step.output}</pre> : null}
            </span>
          </li>
        ))}
      </ol>
      {join?.failure === undefined ? null : <Failure failure={join.failure} />}
      {failed ? (
        <div className={s.actions}>
          {join.retry === true ? (
            <Button variant="primary" size="md" onClick={() => dispatch({ type: "retry" })}>
              Try again
            </Button>
          ) : null}
          <Button variant={join.retry === true ? "ghost" : "primary"} size="md" onClick={() => dispatch({ type: "startOver" })}>
            Start over with a new code
          </Button>
        </div>
      ) : null}
    </>
  );
}

const ROW_GLYPH: Readonly<Record<RowState, "done" | "failed" | "working" | "queued" | "waiting">> = {
  waiting: "queued",
  running: "working",
  done: "done",
  needs_you: "waiting",
  failed: "failed",
};

const OPEN_LABEL = { app_store: "Open the App Store", energy: "Open Energy settings", lock_screen: "Open Lock Screen settings" } as const;

const ROW_WORD: Readonly<Record<RowState, string>> = { waiting: "Waiting", running: "Running", done: "Done", needs_you: "Needs you", failed: "Failed" };

/** A row's one way forward. */
function RowButton({ action, state, dispatch }: { action: RowAction; state: Extract<State, { step: "check" }>; dispatch: Dispatch }) {
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<MacSetupFailure>();
  const run = (go: () => Promise<{ ok: boolean; failure?: MacSetupFailure }>) => {
    setBusy(true);
    setFailure(undefined);
    void go().then((out) => {
      setBusy(false);
      if (!out.ok) setFailure(out.failure);
    });
  };
  const button =
    action.kind === "grant" ? (
      <Button size="sm" variant="primary" disabled={busy} onClick={() => run(() => window.fleetd.macSetup.openPane(action.pane))}>
        {busy ? "Asking macOS…" : "Allow"}
      </Button>
    ) : action.kind === "open" ? (
      <Button size="sm" variant="secondary" disabled={busy} onClick={() => run(() => window.fleetd.macSetup.openPane(action.pane))}>
        {OPEN_LABEL[action.pane]}
      </Button>
    ) : action.kind === "newCode" ? (
      <Button size="sm" variant="primary" onClick={() => dispatch({ type: "startOver" })}>
        New code
      </Button>
    ) : (
      <Button size="sm" variant="secondary" disabled={state.restarting} onClick={() => dispatch({ type: "restart" })}>
        {state.restarting ? "Restarting…" : "Restart the node"}
      </Button>
    );
  return (
    <>
      {button}
      {failure === undefined ? null : (
        <span role="alert" className={s.rowFailure}>
          <Text size="xs" tone="danger">
            {failure.message}
          </Text>
        </span>
      )}
    </>
  );
}

function CheckStep({ state, now, dispatch }: { state: Extract<State, { step: "check" }>; now: number; dispatch: Dispatch }) {
  const rows = setupRows(state, now);
  const green = rows.at(-1)?.state === "done";
  const needs = rows.filter((r) => r.state === "needs_you" || r.state === "failed").length;
  return (
    <>
      <Head
        face={green ? "ready" : undefined}
        title={green ? "This Mac is ready" : `Setting up ${state.found.machineId}`}
        line={green ? undefined : needs > 0 ? `${String(needs)} ${needs === 1 ? "step needs" : "steps need"} you` : undefined}
      />
      <ol className={s.rows} aria-label="Checks">
        {rows.map((row) => (
          <li key={row.id} className={s.row} data-state={row.state} data-check={row.id}>
            <span className={s.rowIcon}>
              {row.state === "done" ? (
                <span className={s.rowDone} role="img" aria-label={ROW_WORD.done}>
                  <Check size={14} strokeWidth={2.5} aria-hidden />
                </span>
              ) : (
                <StateGlyph state={ROW_GLYPH[row.state]} size="sm" label={ROW_WORD[row.state]} />
              )}
            </span>
            <span className={s.rowText}>
              <Text size="sm" strong={row.state === "needs_you" || row.state === "failed"}>
                {row.title}
              </Text>
              <Text size="xs" tone={row.state === "failed" ? "danger" : "quiet"} className={s.clamp}>
                {row.line}
              </Text>
            </span>
            <span className={s.rowAction}>{row.action === undefined ? null : <RowButton action={row.action} state={state} dispatch={dispatch} />}</span>
          </li>
        ))}
      </ol>
      {state.restartFailure === undefined ? null : <Failure failure={state.restartFailure} />}
      {state.read === undefined || state.read.hubBehind === null ? null : <HubBehindLine behind={state.read.hubBehind} hubUrl={state.found.hubUrl} />}
      {green ? (
        <div className={s.actions}>
          <Button variant="primary" size="md" autoFocus onClick={() => dispatch({ type: "finish" })}>
            Done
          </Button>
        </div>
      ) : null}
    </>
  );
}

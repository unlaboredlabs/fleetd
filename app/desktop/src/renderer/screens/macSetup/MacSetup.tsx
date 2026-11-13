// Set up this Mac for agents (D309): its own small window (`#/mac-setup`), never the full interface. One step at a
// time (model.ts): the 6-digit code, a replace to confirm when there is one, the join as main runs it, then the node's
// own checks read every second: the two privacy grants, each asked of macOS by the node and its pane opened, and the Test, every
// check green. The page holds no hub key and no token: main trades the code and runs the CLI (src/main/macSetup.ts).
// A version difference is one line and one fix: an app too old for the hub gets its Update button; a hub older than
// the build this Mac got gets Update right there for an admin signed in here, and where to press it for anyone else.
import { useEffect, useReducer, useRef, useState } from "react";
import { HUB_UPDATE_WHERE, type HubBehind, type MacPane, type MacSetupFailure } from "../../../shared/macSetup";
import { Check, CircleDashed } from "lucide-react";
import { Button, copyText, Field, Input, StateGlyph, Text } from "../../ui";
import { Mark } from "../onboarding/Mark";
import { UpdateAppButton } from "../updates/UpdateAppButton";
import { checkTitle, checkView, digitsOf, passes, waits, initial, READ_EVERY_MS, reduce, spaced, stepOf, STEPS, type CheckRow, type State } from "./model";
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

/** The hub runs an older fleetd than this Mac: both work, and the hub's Update brings it level. */
function HubBehindLine({ behind, hubUrl }: { behind: HubBehind; hubUrl: string }) {
  const [asked, setAsked] = useState<"no" | "asking" | "started">("no");
  const [failure, setFailure] = useState<MacSetupFailure>();
  const update = () => {
    setAsked("asking");
    setFailure(undefined);
    void window.fleetd.macSetup.updateHub(hubUrl).then((outcome) => {
      setAsked(outcome.ok ? "started" : "no");
      if (!outcome.ok) setFailure(outcome.failure);
    });
  };
  const line =
    asked === "started"
      ? "Your hub is updating. It restarts in a moment, then runs the same build as this Mac."
      : behind.who === "admin"
        ? "Your hub runs an older fleetd than this Mac. Agents can use the Mac already; Update brings the hub level."
        : behind.who === "member"
          ? "Your hub runs an older fleetd than this Mac. Agents can use the Mac already; ask an admin of the hub to press Update in Settings › Hub › Machines › Updates."
          : `Your hub runs an older fleetd than this Mac. Agents can use the Mac already. ${HUB_UPDATE_WHERE}`;
  return (
    <div className={s.notice} role="status" data-hub-behind={behind.who}>
      <Text size="sm">{line}</Text>
      {failure === undefined ? null : (
        <Text size="sm" tone="danger">
          {failure.fix === undefined ? failure.message : `${failure.message} ${failure.fix}`}
        </Text>
      )}
      {behind.who === "admin" && asked !== "started" ? (
        <div className={s.actions}>
          <Button variant="secondary" size="md" disabled={asked === "asking"} onClick={update}>
            {asked === "asking" ? "Starting the update…" : "Update the hub"}
          </Button>
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
  }
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
      <Head face="mark" title="Set up this Mac for agents" line="Every project's agents use it for builds and iOS simulators. It's a tool: it runs no claude and holds none of your keys." />
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
            On your main machine, open Add machine › A Mac for agents and type the code it shows.
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
        <Field label="Hub address" description="Shown under the code on your main machine.">
          <Input ref={hubField} value={state.hub} placeholder="http://devbox:4790" mono autoComplete="off" disabled={state.busy} onChange={(e) => dispatch({ type: "hub", value: e.target.value })} />
        </Field>
      ) : null}
      {state.failure === undefined ? null : <Failure failure={state.failure} />}
      {state.choices === undefined ? null : (
        <ul className={s.choices} aria-label="Hubs this Mac found">
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
            {state.busy ? (state.askHub && state.hub.trim() !== "" ? "Asking the hub…" : "Finding your hub…") : "Continue"}
          </Button>
          {state.askHub ? null : (
            <Button type="button" variant="ghost" size="md" disabled={state.busy} onClick={() => dispatch({ type: "askHub" })}>
              Type the hub's address
            </Button>
          )}
        </div>
      )}
      <Text size="xs" tone="quiet" className={s.footnote}>
        Rather use Terminal? Add machine › A Mac for agents on your main machine also has a line to paste here.
      </Text>
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
      <Head title={failed ? "Joining stopped" : `Joining ${found.hubName}`} line={failed ? undefined : `This Mac becomes ${found.machineId}: fleetd installs the hub's own version and starts its node in this login.`} />
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

function CheckLine({ row }: { row: CheckRow }) {
  const [copied, setCopied] = useState<boolean>();
  const bad = !passes(row);
  const says = bad || waits(row);
  return (
    <li className={s.check} data-state={row.state}>
      <StateGlyph state={row.state === "ok" ? "done" : row.state === "fail" ? "failed" : row.state === "warn" ? "waiting" : "working"} size="sm" />
      <span className={s.stepText}>
        <Text size="sm" strong={bad}>
          {checkTitle(row.id)}
        </Text>
        <Text size="xs" tone="quiet">
          {row.message}
        </Text>
        {says && row.fix !== undefined ? <Text size="xs">{row.fix}</Text> : null}
        {says && row.opens !== undefined ? (
          <span className={s.opens}>
            <Button size="sm" variant="secondary" onClick={() => void window.fleetd.macSetup.openPane(row.opens ?? "app_store")}>
              Open the App Store
            </Button>
          </span>
        ) : says && row.command !== undefined ? (
          <span className={s.command}>
            <code>{row.command}</code>
            <Button size="sm" variant="ghost" onClick={() => void copyText(row.command ?? "").then(setCopied)}>
              {copied === true ? "Copied" : "Copy"}
            </Button>
          </span>
        ) : null}
      </span>
    </li>
  );
}

function CheckStep({ state, now, dispatch }: { state: Extract<State, { step: "check" }>; now: number; dispatch: Dispatch }) {
  const view = checkView(state, now);
  // The grant the node is asking macOS for: within 2 s, then macOS's prompt and the pane, with fleetd in its list.
  const [asking, setAsking] = useState<MacPane | undefined>(undefined);
  // The node didn't take the ask: it isn't running, so the page says so with its Restart.
  const [askFailure, setAskFailure] = useState<MacSetupFailure | undefined>(undefined);
  const allow = (pane: MacPane) => {
    setAsking(pane);
    setAskFailure(undefined);
    void window.fleetd.macSetup
      .openPane(pane)
      .then((outcome) => setAskFailure(outcome.ok ? undefined : outcome.failure))
      .finally(() => setAsking(undefined));
  };
  const restart = (
    <Button variant="secondary" size="md" disabled={state.restarting} onClick={() => dispatch({ type: "restart" })}>
      {state.restarting ? "Restarting…" : "Restart the node"}
    </Button>
  );
  if (view.kind === "starting") {
    return (
      <>
        <Head
          title={state.resumed === true ? "Checking this Mac" : "Starting the node"}
          line={
            view.late
              ? "The node hasn't reported its checks yet. Restart it; if that doesn't help, log out of this Mac and back in, or start over with a new code."
              : state.resumed === true
                ? `This Mac is ${state.found.machineId}, ${state.found.hubName}'s agents' Mac, already. Its node is running its checks.`
                : "It checks this Mac as it starts: a few seconds."
          }
        />
        <div className={s.waiting}>
          <StateGlyph state="working" size="sm" />
          <Text size="sm" tone="quiet">
            Waiting for its first checks…
          </Text>
        </div>
        {state.restartFailure === undefined ? null : <Failure failure={state.restartFailure} />}
        {view.late ? (
          <div className={s.actions}>
            {restart}
            {/* A node that never reports (refused by its hub, say): a new code joins this Mac again, replacing it. */}
            <Button variant="ghost" size="md" disabled={state.restarting} onClick={() => dispatch({ type: "startOver" })}>
              Start over with a new code
            </Button>
          </div>
        ) : null}
      </>
    );
  }
  if (view.kind === "grants") {
    return (
      <>
        <Head title="Let agents use this Mac's screen" line="Allow each: macOS asks, then turn on fleetd in the list it opens. This screen sees each switch as you flip it." />
        <ul className={s.grants}>
          {view.grants.map((grant) => (
            <li key={grant.id} className={s.grant} data-granted={grant.granted}>
              <span className={s.stepText}>
                <Text size="md" strong>
                  {grant.title}
                </Text>
                <Text size="xs" tone="quiet">
                  {grant.lost === undefined ? `${grant.why.charAt(0).toUpperCase()}${grant.why.slice(1)}.` : `${grant.lost} Allow, then turn fleetd off and on again in the list.`}
                </Text>
              </span>
              {grant.granted ? (
                <span className={s.allowed}>
                  <Check size={14} strokeWidth={2.5} aria-hidden />
                  Allowed
                </span>
              ) : (
                <Button size="md" variant={view.grants.find((g) => !g.granted)?.id === grant.id ? "primary" : "secondary"} disabled={asking !== undefined} onClick={() => allow(grant.id)}>
                  {asking === grant.id ? "Asking macOS…" : "Allow"}
                </Button>
              )}
            </li>
          ))}
        </ul>
        {askFailure === undefined ? null : (
          <>
            <Failure failure={askFailure} />
            <div className={s.actions}>{restart}</div>
          </>
        )}
        {state.restartFailure === undefined ? null : <Failure failure={state.restartFailure} />}
      </>
    );
  }
  const hub: CheckRow = {
    id: "reaches_hub",
    state: view.hubAnswers ? "ok" : "fail",
    message: view.hubAnswers ? `${state.found.hubUrl} answers.` : `${state.found.hubUrl} doesn't answer from this Mac.`,
    ...(view.hubAnswers ? {} : { fix: "Check this Mac is on the hub's tailnet or network, and that the hub is running." }),
  };
  const rows = [hub, ...view.checks];
  const open = rows.filter((c) => !passes(c));
  // Not holding setup up, but each says what to do: listed with the failing ones, after them.
  const waiting = rows.filter(waits);
  const passed = rows.filter((c) => passes(c) && !waits(c));
  return (
    <>
      <Head
        face={view.green ? "ready" : undefined}
        title={view.green ? "This Mac is ready" : "Testing"}
        line={
          view.green
            ? `${state.found.machineId} is ${state.found.hubName}'s agents' Mac. Agents reach it with mac and agent-device, and you can watch its screen from the app.`
            : open.length > 0
              ? `${String(open.length)} ${open.length === 1 ? "check needs" : "checks need"} you. Each one says what to do, and turns green here as you do it.`
              : "The node runs every check once more with both permissions on: a few seconds."
        }
      />
      {open.length + waiting.length === 0 ? null : (
        <ul className={s.checks}>
          {[...open, ...waiting].map((row) => (
            <CheckLine key={row.id} row={row} />
          ))}
        </ul>
      )}
      <ul className={s.passed} aria-label="Checks that pass">
        {passed.map((row) => (
          <li key={row.id} className={s.passedRow} data-state={row.state} title={row.message}>
            {row.state === "ok" ? <Check size={13} strokeWidth={2.5} aria-hidden /> : <CircleDashed size={13} strokeWidth={2.5} aria-hidden />}
            <span className={s.passedText}>
              <Text size="sm">{checkTitle(row.id)}</Text>
              {row.state === "ok" ? null : (
                <Text size="xs" tone="quiet">
                  {row.message}
                </Text>
              )}
            </span>
          </li>
        ))}
      </ul>
      {state.restartFailure === undefined ? null : <Failure failure={state.restartFailure} />}
      {state.read === undefined || state.read.hubBehind === null ? null : <HubBehindLine behind={state.read.hubBehind} hubUrl={state.found.hubUrl} />}
      <div className={s.actions}>
        {view.green ? (
          <Button variant="primary" size="md" onClick={() => window.close()}>
            Done
          </Button>
        ) : open.length > 0 ? (
          restart
        ) : (
          <StateGlyph state="working" size="sm" label="Testing" />
        )}
      </div>
    </>
  );
}

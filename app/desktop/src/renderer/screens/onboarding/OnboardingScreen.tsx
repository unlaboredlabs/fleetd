import { useCallback, useEffect, useReducer, useRef, useSyncExternalStore, type ReactNode, type SyntheticEvent } from "react";
import type { HubState } from "../../../shared/hub";
import { keyStoreLine, protocolFit, type PairFailure, type PairOutcome } from "../../../shared/pairing";
import { Button, Field, Input, Text } from "../../ui";
import { initialForm, KEY_CREATE, mismatchFailure, reduce, type Reaching } from "./form";
import { useHubState, useKeyStore, useReaching, useSecondsUntil } from "./hooks";
import { CommandLine, Failure, Prose } from "./Prose";
import s from "./onboarding.module.css";

export interface OnboardingProps {
  /** Overrides `#/onboarding?hub=&code=` (a fleetd://pair link), which fills the form and never submits it. */
  readonly hub?: string | undefined;
  readonly code?: string | undefined;
  /** Open on the key path (`#/onboarding?key`). */
  readonly useKey?: boolean | undefined;
}

const subscribeHash = (onChange: () => void) => {
  window.addEventListener("hashchange", onChange);
  return () => window.removeEventListener("hashchange", onChange);
};

const useHashQuery = (): URLSearchParams => {
  const hash = useSyncExternalStore(subscribeHash, () => window.location.hash);
  return new URLSearchParams(hash.split("?")[1] ?? "");
};

/**
 * #/onboarding: connect to a hub, or see why the app can't use the one it has. What it shows follows the
 * connection: no key or a refused key → the connect form; on the way to the hub → connecting; a hub on another
 * protocol → which side to update; connected → on to the board.
 */
export function OnboardingScreen(props: OnboardingProps) {
  const state = useHubState();
  const reach = useReaching(state);
  const query = useHashQuery();
  const hub = props.hub ?? query.get("hub") ?? undefined;
  const code = props.code ?? query.get("code") ?? undefined;
  const useKey = props.useKey ?? query.has("key");
  if (state === null) return <div className={s.screen} data-screen="onboarding" />;
  // A link to pair with a hub shows the form whatever the connection is doing.
  if (code === undefined) {
    if (state.phase === "live") {
      const fit = protocolFit(state.protocol);
      return fit === "ok" ? <Connected hub={state.hub} /> : <Mismatch failure={mismatchFailure(fit, state.hub)} />;
    }
    if (reach !== null) return <Connecting reach={reach} />;
  }
  // Remounts on a new phase or link, so a refused key or a fresh link starts a fresh form.
  return <ConnectForm key={`${state.phase}:${hub ?? ""}:${code ?? ""}:${String(useKey)}`} state={state} link={{ hub, code, useKey }} />;
}

function Page({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <div className={s.screen} data-screen={id}>
      <div className={s.column}>
        <Text as="h1" size="xl" strong>
          {title}
        </Text>
        {children}
      </div>
    </div>
  );
}

function ConnectForm({ state, link }: { state: HubState; link: OnboardingProps }) {
  const [form, dispatch] = useReducer(reduce, undefined, () => initialForm(state, link));
  const codeField = useRef<HTMLInputElement>(null);
  const keyField = useRef<HTMLInputElement>(null);

  const done = () => {
    // Drop a link's code from the route, so the screen follows the connection from here.
    window.location.hash = "#/onboarding";
  };

  const pair = useCallback(async (hub: string, request: () => Promise<PairOutcome>) => {
    dispatch({ type: "submitting", hub });
    const outcome = await request();
    if (outcome.ok) {
      dispatch({ type: "paired", hubName: outcome.hubName });
      done();
    } else {
      dispatch({ type: "failed", failure: outcome.failure });
      codeField.current?.focus();
    }
    return outcome.ok;
  }, []);

  useEffect(() => {
    let current = true;
    void window.fleetd.pair.start().then((start) => {
      if (current) dispatch({ type: "started", start });
    });
    return () => {
      current = false;
    };
  }, []);

  // app-pair.json: main reads the code and pairs; this page only asked.
  useEffect(() => {
    if (form.autoPending) void pair(form.hub, () => window.fleetd.pair.auto());
  }, [form.autoPending, form.hub, pair]);

  const fail = (failure: PairFailure, field: HTMLInputElement | null) => {
    dispatch({ type: "failed", failure });
    field?.focus();
  };

  const submit = async (event: SyntheticEvent) => {
    event.preventDefault();
    if (form.busy) return;
    if (!form.useKey) {
      const request = { hub: form.hub, code: form.code };
      const fromLink = form.linkCode !== null && form.linkCode === form.code;
      const before = fromLink ? await window.fleetd.app.linkHandler(null) : null;
      const ok = await pair(form.hub, () => window.fleetd.pair.redeem(request));
      // The link may have been meant for another install that holds fleetd://; main claims it back when it should.
      if (!ok && before !== null) dispatch({ type: "linkChecked", before, after: await window.fleetd.app.linkHandler("pair-failed") });
      return;
    }
    const key = form.key.trim();
    if (key === "") {
      return fail(
        { code: "", message: "Paste a key for this device.", fix: `On the hub, run \`${KEY_CREATE}\` and paste the key it prints.` },
        keyField.current,
      );
    }
    dispatch({ type: "submitting", hub: form.hub });
    const outcome = await window.fleetd.hub.connect(form.hub.trim(), key);
    if (outcome.ok) {
      dispatch({ type: "paired", hubName: form.hub.trim() });
      done();
    } else {
      fail({ code: "", message: outcome.message, fix: `Check the address, or create a key on the hub with \`${KEY_CREATE}\`.` }, keyField.current);
    }
  };

  return (
    <Page id={form.useKey ? "onboarding.key" : "onboarding"} title="Connect to your fleetd hub">
      {form.notice === null ? null : <Prose text={form.notice} />}
      {form.status === null ? null : <Prose text={form.status} tone="quiet" />}
      <form className={s.fields} onSubmit={(e) => void submit(e)} noValidate>
        <Field label="Hub address">
          <Input
            mono
            value={form.hub}
            onChange={(e) => dispatch({ type: "edit", field: "hub", value: e.target.value })}
            placeholder="http://127.0.0.1:4790"
            autoComplete="off"
          />
        </Field>
        {form.useKey ? (
          <Field label="Key">
            <Input
              ref={keyField}
              mono
              type="password"
              value={form.key}
              onChange={(e) => dispatch({ type: "edit", field: "key", value: e.target.value })}
              placeholder="fld_…"
              autoComplete="off"
              autoFocus
            />
          </Field>
        ) : (
          <Field label="Pairing code">
            <Input
              ref={codeField}
              mono
              value={form.code}
              onChange={(e) => dispatch({ type: "edit", field: "code", value: e.target.value })}
              placeholder="ABCD-2345"
              autoComplete="off"
              autoFocus
            />
          </Field>
        )}
        <div className={s.actions}>
          <Button type="submit" variant="primary" size="md" disabled={form.busy}>
            {form.busy ? "Connecting…" : form.useKey ? "Connect with key" : "Connect"}
          </Button>
        </div>
      </form>
      {form.error === null ? null : <Failure failure={form.error} />}
      {form.linkNote === null ? null : <Prose text={form.linkNote} />}
      <div className={s.hint}>
        <Text tone="quiet">
          {form.useKey
            ? "On the hub, create a key for this device, so your answers are recorded as yours:"
            : "No code yet? On the hub, run this and type the code it prints:"}
        </Text>
        <CommandLine command={form.useKey ? KEY_CREATE : "fleetd pair"} />
      </div>
      <div className={s.toggle}>
        <Button variant="quiet" aria-expanded={form.useKey} onClick={() => dispatch({ type: "toggleKey" })}>
          {form.useKey ? "Use a pairing code instead" : "Use a key instead"}
        </Button>
      </div>
      <KeyStoreLine />
    </Page>
  );
}

/** One layout for every attempt: only the countdown line changes, so a fast-failing hub doesn't flash. */
/** Where the key is kept, as it really is: encrypted by the OS, or a private file and how to change that. */
function KeyStoreLine() {
  const store = useKeyStore();
  return store === null ? null : <Prose text={keyStoreLine(store)} tone="quiet" size="xs" />;
}

function Connecting({ reach }: { reach: Reaching }) {
  const seconds = useSecondsUntil(reach.retryAt);
  return (
    <Page id="onboarding.connecting" title={reach.reason === null ? "Connecting to your hub" : "Can't reach your hub"}>
      <Text tone="quiet" mono size="sm">
        {reach.hub}
      </Text>
      {reach.reason === null ? null : (
        <Failure
          failure={{
            code: "",
            message: reach.reason,
            fix: reach.fix ?? "Check the hub is running (`fleetd doctor` on the hub) and that this computer can reach it.",
          }}
        />
      )}
      <Text tone="quiet" tabular>
        {reach.reason === null ? "Connecting…" : seconds === null || seconds === 0 ? "Trying again now…" : `Trying again in ${seconds} s.`}
      </Text>
      <ForgetHub />
    </Page>
  );
}

function Mismatch({ failure }: { failure: PairFailure }) {
  return (
    <Page id="onboarding.mismatch" title={failure.code === "hub_too_old" ? "Your hub needs an update" : "This app needs an update"}>
      <Failure failure={failure} />
      <ForgetHub />
    </Page>
  );
}

function Connected({ hub }: { hub: string }) {
  useEffect(() => {
    window.location.hash = "#/board";
  }, []);
  return (
    <Page id="onboarding.connected" title="Connected to your hub">
      <Text tone="quiet" mono size="sm">
        {hub}
      </Text>
    </Page>
  );
}

/** Drops the saved key; the connect form follows from the state change. */
function ForgetHub() {
  return (
    <div>
      <Button variant="secondary" onClick={() => void window.fleetd.hub.forget()}>
        Connect to another hub
      </Button>
    </div>
  );
}

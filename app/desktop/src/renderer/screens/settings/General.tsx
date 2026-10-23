import { useEffect, useState } from "react";
import { Button, Dialog, Dot, Radio, RadioGroup, Separator, Text, THEME_MODES, Truncate, useTheme } from "../../ui";
import type { LinkHandlerStatus } from "../../../shared/app";
import type { HubState } from "../../../shared/hub";
import { useData } from "../../src/data/react";
import { errorText } from "./hub";
import { PageHead, Setting } from "./parts";
import s from "./settings.module.css";
import { keyStoreLine } from "../../../shared/pairing";
import { useKeyStore } from "../onboarding";
import { sentence } from "../onboarding/form";
import { Prose } from "../onboarding/Prose";

export function General() {
  const { mode, setMode } = useTheme();
  return (
    <div className={s.scroll} data-screen="settings.general">
      <div className={s.column}>
        <PageHead title="General" />
        <Setting reveal="general.appearance" label="Appearance" help="Match system follows the OS as it changes.">
          <RadioGroup className={s.radios} value={mode} onValueChange={(v) => {
              const m = THEME_MODES.find((x) => x.value === v);
              if (m) setMode(m.value);
            }} aria-label="Appearance">
            {THEME_MODES.map((m) => (
              <Radio key={m.value} value={m.value} label={m.label} />
            ))}
          </RadioGroup>
        </Setting>
        <Separator />
        <HubSetting />
        <LinkHandlerSetting />
      </div>
    </div>
  );
}

function phaseLine(state: HubState): { tone: string; text: string } {
  switch (state.phase) {
    case "live":
      return { tone: "var(--success)", text: "Connected." };
    case "connecting":
      return { tone: "var(--faint)", text: state.attempt > 1 ? `Connecting, attempt ${state.attempt}…` : "Connecting…" };
    case "retrying": {
      const at = new Date(state.retryAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
      return { tone: "var(--warning)", text: `Can't reach it: ${sentence(state.reason)} ${state.fix === undefined ? "" : `${state.fix} `}Trying again at ${at}.` };
    }
    case "refused":
      return { tone: "var(--danger)", text: `It refused this app's key: ${sentence(state.message)} Pair again to get a new key.` };
    case "unpaired":
      return { tone: "var(--faint)", text: state.note ?? "This app isn't paired with a hub." };
  }
}

function HubSetting() {
  const state = useData((s) => s.hub);
  const store = useKeyStore();
  const [confirm, setConfirm] = useState(false);
  const hub = state.phase === "unpaired" ? null : state.hub;
  const line = phaseLine(state);
  return (
    <Setting reveal="general.hub" label="Hub" help="This app acts as you on this hub.">
      {hub ? (
        <Truncate mono size="sm">
          {hub}
        </Truncate>
      ) : null}
      <div className={s.hubLine}>
        <Dot color={line.tone} />
        {/* The hub's fix may name a command in backticks: shown as code. */}
        <Prose tone="quiet" text={line.text} />
      </div>
      {store === null ? null : <Prose size="xs" tone="quiet" text={keyStoreLine(store)} />}
      <div className={s.inline}>
        <Button
          variant={hub ? "secondary" : "primary"}
          onClick={() => {
            window.location.hash = "#/onboarding";
          }}
        >
          {hub ? "Pair with another hub" : "Pair with a hub"}
        </Button>
        {hub ? (
          <Button variant="ghost" onClick={() => setConfirm(true)}>
            Disconnect and forget key
          </Button>
        ) : null}
      </div>
      <Dialog
        open={confirm}
        onOpenChange={setConfirm}
        title="Disconnect and forget the key?"
        description="This app stops showing the hub's work until you pair it again with a code from fleetd pair, and drops messages still waiting to send. Agents keep running."
        footer={
          <>
            <Button onClick={() => setConfirm(false)}>Cancel</Button>
            <Button
              variant="danger"
              onClick={() => {
                setConfirm(false);
                void window.fleetd.hub.forget();
              }}
            >
              Disconnect
            </Button>
          </>
        }
      />
    </Setting>
  );
}

/** Whether fleetd:// links (the pairing links `fleetd pair` prints) open this app, and the one action to make them. */
function LinkHandlerSetting() {
  const [status, setStatus] = useState<LinkHandlerStatus | null>(null);
  const [claiming, setClaiming] = useState(false);
  const [refused, setRefused] = useState(false);
  /** A failed check or claim, in words, with the action Try again repeats. */
  const [failed, setFailed] = useState<{ text: string; retry: "check" | "claim" } | null>(null);
  const [checks, setChecks] = useState(0);
  useEffect(() => {
    let live = true;
    window.fleetd.app.linkHandler(null).then(
      (st) => live && setStatus(st),
      (e: unknown) => live && setFailed({ text: `Couldn't find out which app opens fleetd:// links: ${sentence(errorText(e))}`, retry: "check" }),
    );
    return () => {
      live = false;
    };
  }, [checks]);
  const check = () => {
    setFailed(null);
    setChecks((n) => n + 1);
  };
  const claim = () => {
    setFailed(null);
    setClaiming(true);
    window.fleetd.app.linkHandler("user").then(
      (st) => {
        setClaiming(false);
        setStatus(st);
        setRefused(!st.handler);
      },
      (e: unknown) => {
        setClaiming(false);
        setFailed({ text: `Couldn't ask the system to make fleetd the handler: ${sentence(errorText(e))}`, retry: "claim" });
      },
    );
  };
  return (
    <Setting reveal="general.links" label="Pairing links" help="Open pairing links in this app.">
      {failed ? (
        <div className={s.stack}>
          <Text tone="danger">{failed.text}</Text>
          <div>
            <Button onClick={failed.retry === "check" ? check : claim}>Try again</Button>
          </div>
        </div>
      ) : status === null ? (
        <Text tone="quiet">Checking…</Text>
      ) : status.handler ? (
        <div className={s.hubLine}>
          <Dot color="var(--success)" />
          <Text tone="quiet">fleetd opens them.</Text>
        </div>
      ) : (
        <>
          <div className={s.inline}>
            <Button disabled={!status.packaged || claiming} onClick={claim}>
              {claiming ? "Asking the system…" : "Make fleetd the handler"}
            </Button>
          </div>
          <Text size="xs" tone="quiet">
            {refused
              ? "The system left fleetd:// links with another app. Try again, or pair by typing the code from fleetd pair (Pair with another hub, above)."
              : status.packaged
                ? "fleetd doesn't open fleetd:// links now: another app does, or none."
                : "Dev builds don't register for fleetd:// links; an installed fleetd does."}
          </Text>
        </>
      )}
    </Setting>
  );
}

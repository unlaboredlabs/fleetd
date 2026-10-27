// Settings › Hubs: the hubs this app is paired with (docs/design/hubs.md), each under a name the person picks and an
// optional colour. Each can be renamed, recoloured, paired again or removed; Add a hub pairs one more beside them.
// A hub's name shows in the sidebar, notifications, Status and Commands once there are two. Under each, the hub links
// made as you on it (hubLinks/LinksToThisHub.tsx).
import { useState } from "react";
import type { HubState } from "../../../shared/hub";
import { LABEL_MAX, type HubColor } from "../../../shared/hubs";
import { keyStoreLine } from "../../../shared/pairing";
import { Button, Dialog, Dot, Field, Input, Truncate } from "../../ui";
import { HubScope, useData, useHub, useHubs } from "../../src/data/react";
import { LinksToThisHub } from "../hubLinks/LinksToThisHub";
import { useKeyStore } from "../onboarding";
import { sentence } from "../onboarding/form";
import { Prose } from "../onboarding/Prose";
import { ColorPick } from "../shell/ColorPick";
import { PageHead, Setting } from "./parts";
import s from "./settings.module.css";

export function HubsSettings() {
  const hubs = useHubs();
  return (
    <div className={s.scroll} data-screen="settings.hubs">
      <div className={s.column}>
        <PageHead
          title="Hubs"
          aside={
            <Button
              onClick={() => {
                window.location.hash = "#/onboarding?add";
              }}
            >
              Add a hub
            </Button>
          }
        >
          Keep work apart on hubs of its own, each with its own machines, people and keys. Name each as you like.
        </PageHead>
        {/* Main's word about the list itself (one that couldn't be read, its hubs found again), said once. */}
        {hubs[0]?.note === undefined ? null : (
          <div className={s.hubLine} role="status">
            <Dot color="var(--warning)" />
            <Prose text={hubs[0].note} />
          </div>
        )}
        {hubs.map((hub) => (
          <HubScope key={hub.id} hub={hub}>
            <HubSetting only={hubs.length === 1} />
            <LinksToThisHub />
          </HubScope>
        ))}
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

/**
 * Disconnect and forget the key of the hub in scope, once confirmed: from here and from the sidebar's hub chip. With
 * several hubs it also leaves the list; the others stay as they are.
 */
export function ForgetHubDialog({ open, onOpenChange, only = true }: { open: boolean; onOpenChange: (open: boolean) => void; only?: boolean }) {
  const hub = useHub();
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={only ? "Disconnect and forget the key?" : `Remove ${hub.label}?`}
      description={
        only
          ? "This app stops showing the hub's work until you pair it again with a code from fleetd pair, and drops messages still waiting to send. Agents keep running."
          : `This app forgets ${hub.label}'s key and stops showing its work, and drops messages to it still waiting to send. Your other hubs stay as they are, and agents on ${hub.label} keep running.`
      }
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button
            variant="danger"
            onClick={() => {
              onOpenChange(false);
              void window.fleetd.hub.forget(hub.id);
            }}
          >
            {only ? "Disconnect" : "Remove"}
          </Button>
        </>
      }
    />
  );
}

function HubSetting({ only }: { only: boolean }) {
  const self = useHub();
  const state = useData((st) => st.hub);
  const store = useKeyStore();
  const [confirm, setConfirm] = useState(false);
  const hub = state.phase === "unpaired" ? null : state.hub;
  const line = phaseLine(state);
  const again = state.phase === "unpaired" || state.phase === "refused";
  return (
    <Setting reveal={only ? "hubs.hub" : `hubs.${self.id}`} label={only ? "Hub" : self.label} help="This app acts as you on this hub.">
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
      {hub === null ? null : <NameAndColor key={`${self.label}:${self.color ?? ""}`} />}
      <div className={s.inline}>
        {again ? (
          <Button
            variant="primary"
            onClick={() => {
              window.location.hash = `#/onboarding?another&at=${self.id}`;
            }}
          >
            {hub === null ? "Pair with a hub" : "Pair again"}
          </Button>
        ) : null}
        {hub ? (
          <Button variant="ghost" onClick={() => setConfirm(true)}>
            {only ? "Disconnect and forget key" : "Remove…"}
          </Button>
        ) : null}
      </div>
      <ForgetHubDialog open={confirm} onOpenChange={setConfirm} only={only} />
    </Setting>
  );
}

/** The hub's name and colour, saved as they change: the name on Enter or leaving the field, the colour on a click. */
function NameAndColor() {
  const hub = useHub();
  const [name, setName] = useState(hub.label);
  const [error, setError] = useState<string | null>(null);
  const save = (label: string, color: HubColor | null) => {
    void window.fleetd.hubs.update(hub.id, { label, color }).then((out) => setError(out.ok ? null : out.message));
  };
  const saveName = () => {
    if (name.trim() !== hub.label) save(name, hub.color ?? null);
  };
  return (
    <>
      <Field label="Name" description="Any name you like: Personal, Acme, Side project. With two hubs or more, it shows above its projects and beside its work." error={error ?? undefined}>
        <Input
          value={name}
          maxLength={LABEL_MAX}
          onChange={(e) => setName(e.target.value)}
          onBlur={saveName}
          onKeyDown={(e) => {
            if (e.key === "Enter") saveName();
          }}
        />
      </Field>
      <ColorPick value={hub.color ?? null} onChange={(color) => save(hub.label, color)} />
    </>
  );
}

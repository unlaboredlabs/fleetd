// Settings › You › Hubs & devices: the hubs this app is paired with, each under a name the person picks and an
// optional colour. Each can be renamed, recoloured, paired again or removed; Add a hub pairs one more beside them.
// A hub's name shows in the sidebar, notifications, Status and Commands once there are two. An admin of a hub also
// restarts it from its row (hubRestart.ts); a member's row has no such button. Then Hub links: the keys
// made as you on each hub (hubLinks/LinksToThisHub.tsx); the hubs a project reaches are in its settings (LinkedHubs).
import { useState } from "react";
import type { HubState } from "../../../shared/hub";
import { LABEL_MAX, type HubColor } from "../../../shared/hubs";
import { keyStoreLine } from "../../../shared/pairing";
import { Button, Dialog, Field, Input, Text, Truncate, type TextTone } from "../../ui";
import { HubScope, useData, useHub, useHubs } from "../../src/data/react";
import { LinksToThisHub } from "../hubLinks/LinksToThisHub";
import { useKeyStore } from "../onboarding";
import { sentence } from "../onboarding/form";
import { Prose } from "../onboarding/Prose";
import { HubText } from "../projects/HubText";
import { useServes, useSettledAdministers } from "../admin/role";
import { ColorPick } from "../shell/ColorPick";
import { restartLine, useHubRestart } from "./hubRestart";
import { AddButton, DangerButton, GroupNote, SettingsRow, SettingsSection } from "./parts";

/** Settings › You › Hubs & devices: each hub this app is paired with, and Add a hub. */
export function HubsSettings() {
  const hubs = useHubs();
  return (
    <SettingsSection
      title="Paired hubs"
      reveal="hubs.add"
      hint="The hubs this app is paired with. It acts as you on each. With two hubs or more, a hub's name shows above its projects and beside its work."
      aside={
        <AddButton
          label="Add a hub"
          onClick={() => {
            window.location.hash = "#/onboarding?add";
          }}
        />
      }
    >
      {/* Main's word about the list itself (one that couldn't be read, its hubs found again), said once. */}
      {hubs[0]?.note === undefined ? null : (
        <GroupNote tone="warning">
          <span role="status">
            <HubText>{hubs[0].note}</HubText>
          </span>
        </GroupNote>
      )}
      {hubs.map((hub) => (
        <HubScope key={hub.id} hub={hub}>
          <HubSetting only={hubs.length === 1} />
        </HubScope>
      ))}
    </SettingsSection>
  );
}

/**
 * Hub links: the link keys made as you on each paired hub, which let your project elsewhere act here. The other hubs a
 * project reaches through keys made there are in its settings (Settings › Projects › Linked hubs).
 */
export function HubLinksSettings() {
  const hubs = useHubs();
  return (
    <SettingsSection title="Hub links" part="hubs.hub-links">
      {hubs.map((hub) => (
        <HubScope key={hub.id} hub={hub}>
          <LinksToThisHub label={hubs.length === 1 ? "Links to this hub" : `Links to ${hub.label}`} />
        </HubScope>
      ))}
    </SettingsSection>
  );
}

function phaseLine(state: HubState): { tone: TextTone; text: string } {
  switch (state.phase) {
    case "live":
      return { tone: "success", text: "Connected." };
    case "connecting":
      return { tone: "quiet", text: state.attempt > 1 ? `Connecting, attempt ${state.attempt}…` : "Connecting…" };
    case "retrying": {
      const at = new Date(state.retryAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
      return { tone: "warning", text: `Can't reach it: ${sentence(state.reason)} ${state.fix === undefined ? "" : `${state.fix} `}Trying again at ${at}.` };
    }
    case "refused":
      return { tone: "danger", text: `It refused this app's key: ${sentence(state.message)} Pair again to get a new key.` };
    case "unpaired":
      return { tone: "quiet", text: state.note ?? "This app isn't paired with a hub." };
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

/** Restart the hub in scope, once confirmed: what an admin's Restart hub asks first. */
function RestartHubDialog({ open, onOpenChange, onRestart, only }: { open: boolean; onOpenChange: (open: boolean) => void; onRestart: () => void; only: boolean }) {
  const hub = useHub();
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={only ? "Restart the hub?" : `Restart ${hub.label}?`}
      description="It is back in about a second, and running agents carry on. A lead whose profile changed since it started comes back on the current one, with its chat, memory and open orders."
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button
            variant="primary"
            onClick={() => {
              onOpenChange(false);
              onRestart();
            }}
          >
            Restart
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
  const administers = useSettledAdministers();
  // fleetd cloud restarts nothing for a team: no button there.
  const restarts = useServes("hub_restart");
  const { step, restart } = useHubRestart();
  const [confirm, setConfirm] = useState(false);
  const [confirmRestart, setConfirmRestart] = useState(false);
  const hub = state.phase === "unpaired" ? null : state.hub;
  // A restart this row asked for says how it goes; a failed one keeps the connection's line beside its own.
  const line = (step.at === "failed" ? null : restartLine(step)) ?? phaseLine(state);
  const failed = step.at === "failed" ? restartLine(step) : null;
  const busy = step.at === "asking" || step.at === "restarting";
  const again = state.phase === "unpaired" || state.phase === "refused";
  return (
    <SettingsRow
      reveal={only ? "hubs.hub" : `hubs.${self.id}`}
      title={only ? "Hub" : self.label}
      hint={self.cloud === true ? "Hosted by fleetd. It came with your fleetd account, and signing out takes it off this app." : undefined}
      // The hub's fix may name a command in backticks: shown as code.
      line={<HubText>{line.text}</HubText>}
      lineTone={line.tone}
      control={
        <>
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
          {/* Admins of this hub only, and only while it is there to ask. */}
          {administers && restarts && (state.phase === "live" || busy) ? (
            <Button disabled={busy} onClick={() => setConfirmRestart(true)}>
              Restart hub…
            </Button>
          ) : null}
          {hub ? <DangerButton onClick={() => setConfirm(true)}>{only ? "Disconnect and forget key" : "Remove…"}</DangerButton> : null}
        </>
      }
    >
      {failed ? (
        <div role="alert">
          <Text size="sm" tone="danger">
            <HubText>{failed.text}</HubText>
          </Text>
        </div>
      ) : null}
      {hub ? (
        <Truncate mono size="sm" tone="quiet">
          {hub}
        </Truncate>
      ) : null}
      {/* Said only where there's something to fix: a key kept in the OS store needs no line. */}
      {store === null || store.kind === "os" ? null : <Prose size="xs" tone="quiet" text={keyStoreLine(store)} />}
      {hub === null ? null : <NameAndColor key={`${self.label}:${self.color ?? ""}`} />}
      <ForgetHubDialog open={confirm} onOpenChange={setConfirm} only={only} />
      <RestartHubDialog open={confirmRestart} onOpenChange={setConfirmRestart} onRestart={restart} only={only} />
    </SettingsRow>
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
      <Field label="Name" error={error ?? undefined}>
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

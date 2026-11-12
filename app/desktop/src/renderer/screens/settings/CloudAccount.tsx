// Settings › Hubs & devices › fleetd account: who is signed in to fleetd cloud, and Sign out; or Sign in, which adds
// the account's teams beside the hubs this app has. Only on a build with the cloud's values (onboarding/cloud.ts):
// any other build shows nothing here. A sign-in from here names the account, then asks about each invitation, in a
// dialog each, before anything connects (onboarding/SignIn.tsx).
import { useState } from "react";
import { Button, Dialog, Text } from "../../ui";
import { useHubs } from "../../src/data/react";
import { refreshCloud, useCloud } from "../onboarding/cloud";
import { invitedLine, invitedTitle, missedTeams, useSignIn } from "../onboarding/SignIn";
import { SettingsRow, SettingsSection } from "./parts";

export function CloudAccountSettings() {
  const { state } = useCloud();
  const teams = useHubs().filter((h) => h.cloud === true);
  const signIn = useSignIn();
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [kept, setKept] = useState<readonly string[]>([]);
  if (!state.available) return null;
  const step = signIn.step;
  const waiting = step.at === "waiting" || step.at === "finishing";
  const invitation = step.at === "invited" ? step.arrival.invitations[step.index] : undefined;
  const note = step.at === "start" ? step.note : null;
  const missed = state.email === null ? [] : missedTeams();
  const signOut = () => {
    setConfirm(false);
    setBusy(true);
    void window.fleetd.cloud.signOut().then((out) => {
      setKept(out.kept);
      setBusy(false);
      void refreshCloud();
    });
  };
  const names = teams.map((t) => t.label).join(", ");
  return (
    <SettingsSection title="fleetd account" part="hubs.account">
      <SettingsRow
        title={state.email ?? "fleetd cloud"}
        hint={state.email === null ? "fleetd hosts your hub; your agents run on your own computers. Signing in adds your teams beside these hubs." : undefined}
        line={step.at === "finishing" ? "Connecting your teams…" : waiting ? "Finish signing in in your browser." : state.email === null ? "Not signed in." : teams.length === 0 ? "Signed in." : `Signed in. fleetd hosts ${names} for this account.`}
        control={
          step.at === "waiting" ? (
            <Button variant="quiet" onClick={signIn.cancel}>
              Cancel
            </Button>
          ) : state.email === null ? (
            <Button variant="primary" onClick={signIn.start}>
              Sign in
            </Button>
          ) : (
            <Button disabled={busy} onClick={() => setConfirm(true)}>
              {busy ? "Signing out…" : "Sign out…"}
            </Button>
          )
        }
      >
        {note === null ? null : (
          <span role={note.quiet ? "status" : "alert"}>
            <Text size="sm" tone={note.quiet ? "quiet" : "danger"}>
              {note.failure.fix === undefined ? note.failure.message : `${note.failure.message} ${note.failure.fix}`}
            </Text>
          </span>
        )}
        {missed.map((t) => (
          <span key={t.name} role="status">
            <Text size="sm" tone="warning">
              {`${t.failure.message} ${t.failure.fix ?? ""}`.trim()}
            </Text>
          </span>
        ))}
        {kept.length === 0 ? null : (
          <span role="status">
            <Text size="sm" tone="warning">
              {`${kept.join(", ")} couldn't be reached, so this device stays in its Devices until someone signs it out there.`}
            </Text>
          </span>
        )}
      </SettingsRow>
      <Dialog
        open={step.at === "arrived"}
        onOpenChange={(open) => {
          if (!open) signIn.notMe();
        }}
        title={step.at === "arrived" ? `Signed in as ${step.arrival.email}` : ""}
        description="Not you? Sign out."
        footer={
          <>
            <Button onClick={signIn.notMe}>Sign out</Button>
            <Button variant="primary" onClick={signIn.confirm}>
              Continue
            </Button>
          </>
        }
      />
      <Dialog
        open={invitation !== undefined}
        onOpenChange={(open) => {
          if (!open) signIn.answer(false);
        }}
        title={invitation === undefined ? "" : invitedTitle(invitation)}
        description={invitation === undefined ? "" : invitedLine(invitation)}
        footer={
          <>
            <Button onClick={() => signIn.answer(false)}>Not now</Button>
            <Button variant="primary" onClick={() => signIn.answer(true)}>
              Join
            </Button>
          </>
        }
      />
      <Dialog
        open={confirm}
        onOpenChange={setConfirm}
        title="Sign out of fleetd?"
        description={`This app drops its key on ${teams.length === 0 ? "your fleetd teams" : names} and stops showing their work. Agents keep running, and your own hubs stay as they are.`}
        footer={
          <>
            <Button onClick={() => setConfirm(false)}>Cancel</Button>
            <Button variant="danger" onClick={signOut}>
              Sign out
            </Button>
          </>
        }
      />
    </SettingsSection>
  );
}

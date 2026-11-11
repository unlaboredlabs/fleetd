// Settings › Hubs & devices › fleetd account: who is signed in to fleetd cloud, and Sign out; or Sign in, which adds
// the account's teams beside the hubs this app has. Only on a build with the cloud's values (onboarding/cloud.ts):
// any other build shows nothing here.
import { useState } from "react";
import { Button, Dialog, Text } from "../../ui";
import { useHubs } from "../../src/data/react";
import { refreshCloud, useCloud } from "../onboarding/cloud";
import { missedTeams, useSignIn } from "../onboarding/SignIn";
import { SettingsRow, SettingsSection } from "./parts";

export function CloudAccountSettings() {
  const { state } = useCloud();
  const teams = useHubs().filter((h) => h.cloud === true);
  const signIn = useSignIn();
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [kept, setKept] = useState<readonly string[]>([]);
  if (!state.available) return null;
  const waiting = signIn.step.at === "waiting";
  const note = signIn.step.at === "start" ? signIn.step.note : null;
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
        line={waiting ? "Finish signing in in your browser." : state.email === null ? "Not signed in." : teams.length === 0 ? "Signed in." : `Signed in. fleetd hosts ${names} for this account.`}
        control={
          waiting ? (
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

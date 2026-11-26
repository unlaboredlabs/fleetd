// Settings › Hubs & devices › fleetd account: who is signed in to fleetd cloud, and Sign out; or Sign in, which adds
// the account's teams beside the hubs this app has. Only on a build with the cloud's values (onboarding/cloud.ts):
// any other build shows nothing here. A sign-in from here names the account, then asks about each invitation, in a
// dialog each, before anything connects (onboarding/SignIn.tsx). Signed in, Delete account (App Store 5.1.1(v)) reads
// what the delete would take and says it (the workspaces that go and any plan that stops, those left, and the ones that
// hold it back), asks for the account's email typed back and has the cloud delete it, which revokes every key and
// session of it: the app then forgets the account's workspaces, as signing out would. The cloud's refusals show as written.
import { useState } from "react";
import { Button, Dialog, Text, toast } from "../../ui";
import { useHubs } from "../../src/data/react";
import { refreshCloud, useCloud } from "../onboarding/cloud";
import { invitedLine, invitedTitle, missedTeams, useSignIn } from "../onboarding/SignIn";
import { DeleteAccountDialog } from "./DeleteAccountDialog";
import { DangerButton, SettingsRow, SettingsSection } from "./parts";
import { onWeb } from "../../src/web";

export function CloudAccountSettings() {
  const { state } = useCloud();
  const teams = useHubs().filter((h) => h.cloud === true);
  const signIn = useSignIn();
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [kept, setKept] = useState<readonly string[]>([]);
  // Why the last sign-out didn't happen (the web app's, when fleetd cloud can't be reached): still signed in.
  const [notOut, setNotOut] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  if (!state.available) return null;
  const step = signIn.step;
  const waiting = step.at === "waiting" || step.at === "finishing";
  const invitation = step.at === "invited" ? step.arrival.invitations[step.index] : undefined;
  const note = step.at === "start" ? step.note : null;
  const missed = state.email === null ? [] : missedTeams();
  const signOut = () => {
    setConfirm(false);
    setBusy(true);
    setNotOut(null);
    void window.fleetd.cloud.signOut().then((out) => {
      setKept(out.kept);
      setNotOut(out.failure === undefined ? null : out.failure.fix === undefined ? out.failure.message : `${out.failure.message} ${out.failure.fix}`);
      setBusy(false);
      void refreshCloud();
    });
  };
  const names = teams.map((t) => t.label).join(", ");
  return (
    <SettingsSection title="fleetd account" part="hubs.account">
      <SettingsRow
        title={state.email ?? "fleetd cloud"}
        hint={state.email === null ? "fleetd hosts your workspace, and its agents run on fleetd's computers or your own. Signing in adds your workspaces beside these workspaces." : undefined}
        line={step.at === "finishing" ? "Connecting your workspaces…" : waiting ? "Finish signing in in your browser." : state.email === null ? "Not signed in." : teams.length === 0 ? "Signed in." : `Signed in. fleetd hosts ${names} for this account.`}
        control={
          step.at === "waiting" ? (
            <Button variant="quiet" onClick={signIn.cancel}>
              Cancel
            </Button>
          ) : state.email === null ? (
            // Not while a sign-in's teams connect: a second one would start under it.
            <Button variant="primary" disabled={step.at !== "start"} onClick={signIn.start}>
              Sign in
            </Button>
          ) : (
            <Button disabled={busy || step.at !== "start"} onClick={() => setConfirm(true)}>
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
        {notOut === null ? null : (
          <span role="alert">
            <Text size="sm" tone="danger">
              {notOut}
            </Text>
          </span>
        )}
        {kept.length === 0 ? null : (
          <span role="status">
            <Text size="sm" tone="warning">
              {`${kept.join(", ")} couldn't be reached, so this device stays in its Devices until someone signs it out there.`}
            </Text>
          </span>
        )}
      </SettingsRow>
      {/* The cloud is asked on one of the account's workspaces: with none in this app, there is nowhere to ask. */}
      {state.email === null || teams.length === 0 ? null : (
        <SettingsRow
          reveal="hubs.account.delete"
          title="Delete account"
          hint="Deletes your fleetd account and everything of yours in it, for good."
          control={
            <DangerButton disabled={busy || step.at !== "start"} onClick={() => setDeleting(true)}>
              Delete account…
            </DangerButton>
          }
        />
      )}
      {state.email === null ? null : (
        <DeleteAccountDialog
          email={state.email}
          open={deleting}
          onClose={() => setDeleting(false)}
          preview={() => window.fleetd.cloud.accountPreview()}
          remove={(typed) => window.fleetd.cloud.deleteAccount(typed)}
          onDeleted={() => {
            toast({ title: "Your fleetd account is deleted" });
            void refreshCloud();
          }}
        />
      )}
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
        description={
          onWeb()
            ? "This browser stops showing your workspaces' work until you sign in again. Agents keep running."
            : `This app drops its key on ${teams.length === 0 ? "your fleetd workspaces" : names} and stops showing their work. Agents keep running, and your own workspaces stay as they are.`
        }
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

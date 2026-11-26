// Settings › Hubs & devices › fleetd account: who is signed in to fleetd cloud, and Sign out; or Sign in, which adds
// the account's teams beside the hubs this app has. Only on a build with the cloud's values (onboarding/cloud.ts):
// any other build shows nothing here. A sign-in from here names the account, then asks about each invitation, in a
// dialog each, before anything connects (onboarding/SignIn.tsx). Signed in, Delete account (App Store 5.1.1(v)) reads
// what the delete would take and says it (the workspaces that go and any plan that stops, those left, and the ones that
// hold it back), asks for the account's email typed back and has the cloud delete it, which revokes every key and
// session of it: the app then forgets the account's workspaces, as signing out would. The cloud's refusals show as written.
import { useEffect, useState } from "react";
import type { AccountPreviewOutcome } from "../../../shared/cloud";
import { blockedLine, deleteAccountLines, emailMatches } from "../../../shared/legal";
import { Button, Dialog, Field, Input, Text, toast } from "../../ui";
import { useHubs } from "../../src/data/react";
import { refreshCloud, useCloud } from "../onboarding/cloud";
import { invitedLine, invitedTitle, missedTeams, useSignIn } from "../onboarding/SignIn";
import { DangerButton, Notice, SettingsRow, SettingsSection } from "./parts";
import { onWeb } from "../../src/web";
import s from "./settings.module.css";

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
        hint={state.email === null ? "fleetd hosts your team, and its agents run on fleetd's computers or your own. Signing in adds your teams beside these hubs." : undefined}
        line={step.at === "finishing" ? "Connecting your teams…" : waiting ? "Finish signing in in your browser." : state.email === null ? "Not signed in." : teams.length === 0 ? "Signed in." : `Signed in. fleetd hosts ${names} for this account.`}
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
      {state.email === null ? null : <DeleteAccountDialog email={state.email} open={deleting} onClose={() => setDeleting(false)} />}
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
            ? "This browser stops showing your teams' work until you sign in again. Agents keep running."
            : `This app drops its key on ${teams.length === 0 ? "your fleetd teams" : names} and stops showing their work. Agents keep running, and your own hubs stay as they are.`
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

/** Delete account's one confirm: what goes, read from the cloud first, then the account's email typed back, which the cloud checks too. */
function DeleteAccountDialog({ email, open, onClose }: { email: string; open: boolean; onClose: () => void }) {
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; fix?: string | undefined } | null>(null);
  const [preview, setPreview] = useState<AccountPreviewOutcome | null>(null);
  useEffect(() => {
    if (!open) return;
    let live = true;
    void window.fleetd.cloud.accountPreview().then((out) => {
      if (live) setPreview(out);
    });
    return () => {
      live = false;
    };
  }, [open]);
  // Read again at each opening: what goes may have changed since.
  const close = () => {
    setTyped("");
    setError(null);
    setBusy(false);
    setPreview(null);
    onClose();
  };
  const read = preview?.ok === true ? preview.preview : null;
  const blocked = read === null ? null : blockedLine(read);
  const remove = async () => {
    setBusy(true);
    setError(null);
    const out = await window.fleetd.cloud.deleteAccount(typed);
    setBusy(false);
    if (!out.ok) {
      setError({ message: out.failure.message, fix: out.failure.fix });
      return;
    }
    close();
    toast({ title: "Your fleetd account is deleted" });
    void refreshCloud();
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !busy) close();
      }}
      title="Delete your fleetd account?"
      description="This can't be undone."
      footer={
        <>
          <Button onClick={close} disabled={busy}>
            Cancel
          </Button>
          <Button variant="danger" disabled={busy || read === null || blocked !== null || !emailMatches(typed, email)} onClick={() => void remove()}>
            {busy ? "Deleting…" : "Delete account"}
          </Button>
        </>
      }
    >
      {preview === null ? (
        <span role="status">
          <Text tone="quiet">Loading…</Text>
        </span>
      ) : !preview.ok ? (
        <Notice tone="danger">{preview.failure.fix === undefined ? preview.failure.message : `${preview.failure.message} ${preview.failure.fix}`}</Notice>
      ) : blocked !== null ? (
        <Notice tone="warning">{blocked}</Notice>
      ) : (
        <ul className={s.lines}>
          {deleteAccountLines(preview.preview).map((line) => (
            <li key={line}>
              <Text>{line}</Text>
            </li>
          ))}
        </ul>
      )}
      {read === null || blocked !== null ? null : (
        <Field label={`Type ${email} to confirm`}>
          <Input value={typed} type="email" autoComplete="off" spellCheck={false} onChange={(e) => setTyped(e.target.value)} disabled={busy} />
        </Field>
      )}
      {error ? (
        <div role="alert">
          <Text tone="danger">{error.message}</Text>
          {error.fix ? (
            <Text as="p" tone="quiet">
              {error.fix}
            </Text>
          ) : null}
        </div>
      ) : null}
    </Dialog>
  );
}

// What the web app shows before the app itself: Sign in when no one is (WorkOS's page by a navigation: Google, GitHub
// or an email code), each invitation to answer, or why there's no team to open. In the onboarding's own look
// (onboarding/SignIn.tsx's Stage and Invited), so the web's first screen is the desktop's.
import { useState } from "react";
import { invitationLine, invitationTitle } from "../shared/accounts";
import { Bot, Button, Text } from "../renderer/ui";
import { Stage } from "../renderer/screens/onboarding/SignIn";
import s from "../renderer/screens/onboarding/signin.module.css";
import type { WebFailure, WebInvitation } from "./session";

export type GateView =
  | { readonly at: "signed-out" }
  | { readonly at: "failed"; readonly failure: WebFailure }
  | { readonly at: "invited"; readonly email: string; readonly invitations: readonly WebInvitation[] }
  | { readonly at: "no-team"; readonly email: string };

export interface GateActions {
  readonly signIn: () => void;
  readonly retry: () => void;
  /** Joins one invitation; its refusal, or null once joined. */
  readonly join: (invitation: WebInvitation) => Promise<WebFailure | null>;
  /** On to the app, with the invitations left for another time. */
  readonly later: () => void;
  readonly signOut: () => void;
}

export function Gate({ view, actions }: { view: GateView; actions: GateActions }) {
  if (view.at === "signed-out") {
    return (
      <Stage id="web.sign-in">
        <Bot state="idle" size={64} />
        <Text as="h1" size="xl" strong className={s.title}>
          Welcome to fleetd
        </Text>
        <div className={s.main}>
          <Button variant="primary" className={s.signIn} onClick={actions.signIn}>
            Sign in
          </Button>
          <Text as="p" size="sm" tone="quiet">
            With Google, GitHub or a code by email. Your agents run on your own computers.
          </Text>
        </div>
      </Stage>
    );
  }
  if (view.at === "failed") {
    return (
      <Stage id="web.failed">
        <Bot state="error" size={64} />
        <Text as="h1" size="xl" strong className={s.title}>
          {view.failure.message}
        </Text>
        {view.failure.fix === undefined ? null : (
          <Text as="p" tone="quiet" className={s.lede}>
            {view.failure.fix}
          </Text>
        )}
        <div className={s.waitActions}>
          <Button variant="primary" size="md" onClick={actions.retry}>
            Try again
          </Button>
        </div>
      </Stage>
    );
  }
  if (view.at === "no-team") {
    return (
      <Stage id="web.no-team">
        <Bot state="idle" size={64} />
        <Text as="h1" size="xl" strong className={s.title}>
          No team yet
        </Text>
        <Text as="p" tone="quiet" className={s.lede}>
          {`${view.email} isn't in a fleetd team. Ask a teammate to invite this email, then sign in again.`}
        </Text>
        <div className={s.waitActions}>
          <Button size="md" onClick={actions.signOut}>
            Sign out
          </Button>
        </div>
      </Stage>
    );
  }
  return <Invitations view={view} actions={actions} />;
}

/** Each invitation in turn, Join or Not now; then the app, or no team when none was joined and there was none. */
function Invitations({ view, actions }: { view: GateView & { at: "invited" }; actions: GateActions }) {
  const [index, setIndex] = useState(0);
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState<WebFailure | null>(null);
  const invitation = view.invitations[index];
  if (invitation === undefined) return null;
  const next = () => {
    setRefused(null);
    if (index + 1 < view.invitations.length) setIndex(index + 1);
    else actions.later();
  };
  const join = () => {
    setBusy(true);
    void actions.join(invitation).then((failure) => {
      setBusy(false);
      if (failure === null) next();
      else setRefused(failure);
    });
  };
  return (
    <Stage id="web.invited">
      <Bot state="idle" size={64} />
      <Text as="h1" size="xl" strong className={s.title}>
        {invitationTitle(invitation)}
      </Text>
      <Text as="p" tone="quiet" className={s.lede}>
        {invitationLine(invitation)}
      </Text>
      {refused === null ? null : (
        <span role="alert">
          <Text size="sm" tone="danger">
            {refused.fix === undefined ? refused.message : `${refused.message} ${refused.fix}`}
          </Text>
        </span>
      )}
      <div className={s.waitActions}>
        <Button variant="primary" size="md" disabled={busy} onClick={join}>
          {busy ? "Joining…" : "Join"}
        </Button>
        <Button size="md" variant="quiet" disabled={busy} onClick={next}>
          Not now
        </Button>
      </div>
    </Stage>
  );
}

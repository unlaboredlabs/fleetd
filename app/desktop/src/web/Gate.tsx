// What the web app shows before the app itself: Sign in when no one is (WorkOS's page by a navigation: Google, GitHub
// or an email code), each invitation to answer, or why there's no team to open. In Get started's own look
// (screens/start): the bot and the title where that page has them, and under them one soft box holding the screen's
// one thing to do, as that page's open step does, so signing in, joining and setting up read as one page.
import { useState, type ReactNode } from "react";
import { invitationLine } from "../shared/accounts";
import { LEGAL_PAGES } from "../shared/legal";
import type { BotState } from "../shared/bot";
import type { AccountPreviewOutcome, DeleteAccountOutcome } from "../shared/cloud";
import { Bot, Button, Text } from "../renderer/ui";
import { DeleteAccountDialog } from "../renderer/screens/settings/DeleteAccountDialog";
import st from "../renderer/screens/start/start.module.css";
import s from "./gate.module.css";
import type { WebFailure, WebInvitation } from "./session";

export type GateView =
  /** `deleted`: the person just deleted their account here (shell.ts deleteAccount), which the page says first. */
  | { readonly at: "signed-out"; readonly deleted?: true }
  | { readonly at: "failed"; readonly failure: WebFailure }
  | { readonly at: "invited"; readonly email: string; readonly invitations: readonly WebInvitation[]; readonly removed?: string }
  | { readonly at: "no-team"; readonly email: string; readonly removed?: string };

export interface GateActions {
  readonly signIn: () => void;
  /** WorkOS's page on its sign-up form: the site's Sign up lands here, so making an account is a button, not a link under Sign in. */
  readonly signUp: () => void;
  readonly retry: () => void;
  /** Joins one invitation; its refusal, or null once joined. */
  readonly join: (invitation: WebInvitation) => Promise<WebFailure | null>;
  /** On to the app, with the invitations left for another time. */
  readonly later: () => void;
  /** A team of the person's own (someone who came by an invitation has none); its refusal, or null once made. */
  readonly makeTeam: () => Promise<WebFailure | null>;
  readonly signOut: () => void;
  /** The account whose session ended while the app was open (ended.ts): Sign in says so, and signs back in as it. */
  readonly ended?: string | undefined;
  /** What deleting the account would take, and the delete: for one in no workspace, with nowhere else to do it. */
  readonly accountPreview: () => Promise<AccountPreviewOutcome>;
  readonly deleteAccount: (email: string) => Promise<DeleteAccountOutcome>;
  /** The account is gone: the page starts over, signed out. */
  readonly deleted: () => void;
}

/** The page: the bot and its title where Get started has them (under the app's top bar's height), then the box, and
 * under it `foot`. */
function Stage({ id, bot, title, children, foot }: { id: string; bot: BotState; title: string; children: ReactNode; foot?: ReactNode }) {
  return (
    <div className={s.frame}>
      <div className={st.screen} data-screen={id}>
        <div className={st.column}>
          <div className={st.head}>
            <Bot state={bot} size={64} />
            <Text as="h1" size="xl" strong className={st.title}>
              {title}
            </Text>
          </div>
          <div className={s.box}>{children}</div>
          {foot}
        </div>
      </div>
    </div>
  );
}

export function Gate({ view, actions }: { view: GateView; actions: GateActions }) {
  if (view.at === "signed-out") {
    return (
      <Stage id="web.sign-in" bot="idle" title="Welcome to fleetd" foot={<Legal />}>
        {view.deleted === true ? (
          // After Delete account the page was only the welcome, with no word that the account was gone (S10).
          <div role="status" className={s.deleted} data-deleted="">
            <Text strong>Your fleetd account is deleted, with its workspaces.</Text>
            <Text tone="quiet">A machine you joined stops fleetd by itself. To remove fleetd there, run fleetd uninstall on it.</Text>
          </div>
        ) : null}
        <Text strong>{actions.ended === undefined ? "Sign in, or make an account" : "Your session ended"}</Text>
        <Text tone="quiet">{actions.ended === undefined ? "With Google, GitHub, Apple or a code by email." : `Sign in again as ${actions.ended} to go on where you were.`}</Text>
        <div className={st.actions}>
          <Button variant="primary" size="md" onClick={actions.signIn}>
            Sign in
          </Button>
          <Button size="md" onClick={actions.signUp}>
            Make an account
          </Button>
        </div>
      </Stage>
    );
  }
  if (view.at === "failed") {
    return (
      <Stage id="web.failed" bot="error" title="Can't open fleetd">
        <Text strong>{view.failure.message}</Text>
        {view.failure.fix === undefined ? null : <Text tone="quiet">{view.failure.fix}</Text>}
        <div className={st.actions}>
          <Button variant="primary" size="md" onClick={actions.retry}>
            Try again
          </Button>
        </div>
      </Stage>
    );
  }
  if (view.at === "no-team") return <NoTeam email={view.email} removed={view.removed} actions={actions} />;
  return <Invitations view={view} actions={actions} />;
}

/** fleetd's terms and privacy policy, under Sign in: what making an account agrees to, before WorkOS's page. */
function Legal() {
  const link = (id: "terms" | "privacy", words: string) => (
    <a className={s.link} href={LEGAL_PAGES.find((p) => p.id === id)?.url} target="_blank" rel="noreferrer">
      {words}
    </a>
  );
  return (
    <Text as="p" size="sm" tone="quiet" className={s.foot}>
      By signing in, you accept fleetd's {link("terms", "terms of service")} and {link("privacy", "privacy policy")}.
    </Text>
  );
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
    <Stage id="web.invited" bot="idle" title={`Join ${invitation.name}`}>
      {view.removed === undefined ? null : <Text tone="quiet">{view.removed}</Text>}
      <Text strong>{`Invited by ${invitation.invitedBy}`}</Text>
      <Text tone="quiet">{invitationLine(invitation)}</Text>
      {refused === null ? null : (
        <span role="alert">
          <Text size="sm" tone="danger">
            {refused.fix === undefined ? refused.message : `${refused.message} ${refused.fix}`}
          </Text>
        </span>
      )}
      <div className={st.actions}>
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

/**
 * In no team (one who came by an invitation and said Not now, or was removed from theirs): a team of their own, a
 * teammate's invite, or deleting the account. A removal is the page's headline: it is why there is no workspace.
 */
function NoTeam({ email, removed, actions }: { email: string; removed: string | undefined; actions: GateActions }) {
  const [deleting, setDeleting] = useState(false);
  // Undefined while it is being made, and once made while the app opens on it (a second press would make another);
  // a refusal says why in place of the line.
  const [refused, setRefused] = useState<WebFailure | null | undefined>(null);
  const make = () => {
    setRefused(undefined);
    void actions.makeTeam().then((failure) => setRefused(failure ?? undefined));
  };
  return (
    <Stage id="web.no-team" bot="idle" title={removed === undefined ? "No workspace yet" : removed.replace(/\.$/u, "")}>
      <Text strong>{removed === undefined ? `${email} isn't in a fleetd workspace` : `Signed in as ${email}`}</Text>
      <Text tone="quiet">
        {refused
          ? `${refused.message} ${refused.fix ?? ""}`.trim()
          : removed === undefined
            ? "Make one of your own, or ask a teammate to invite this email."
            : "Make a workspace of your own, or ask a teammate to invite this email."}
      </Text>
      <div className={st.actions}>
        <Button variant="primary" size="md" disabled={refused === undefined} onClick={make}>
          Make a workspace
        </Button>
        <Button size="md" onClick={actions.signOut}>
          Sign out
        </Button>
        <Button size="md" variant="quiet" disabled={refused === undefined} onClick={() => setDeleting(true)}>
          Delete account…
        </Button>
      </div>
      <DeleteAccountDialog
        email={email}
        open={deleting}
        onClose={() => setDeleting(false)}
        preview={actions.accountPreview}
        remove={actions.deleteAccount}
        onDeleted={actions.deleted}
      />
    </Stage>
  );
}

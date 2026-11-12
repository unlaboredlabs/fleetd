// The first screen's two ways in (decision hosted.first-screen, artifact hosted-signin-design): Sign in, fleetd
// cloud, through the system browser; and Use your own hub, the connect form as it always was. Shown only when this
// build has the cloud's values (cloud.ts); without them the first screen is the connect form alone. Once the browser
// is back, the first thing shown names the account ("Signed in as <email>", with Not you? Sign out), then each
// invitation is asked about (Join or Not now) before anything connects: main holds the answer until then.
import { ArrowLeft, ChevronRight } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { invitationLine, invitationTitle } from "../../../shared/accounts";
import type { Arrival, FinishOutcome, Invitation, TeamOutcome } from "../../../shared/cloud";
import type { PairFailure } from "../../../shared/pairing";
import { Bot, Button, copyText, Text } from "../../ui";
import { refreshCloud } from "./cloud";
import s from "./signin.module.css";

/** The two ways in, and what each means in a line. */
export const WAYS = {
  signIn: { name: "Sign in", line: "fleetd hosts your hub. Your agents run on your own computers." },
  own: { name: "Use your own hub", line: "A hub you run yourself. No fleetd account." },
} as const;

/** Why the last sign-in ended without connecting, said above Sign in. A page left to run out is no error. */
export interface SignInNote {
  readonly quiet: boolean;
  readonly failure: PairFailure;
}

export type SignInStep =
  | { readonly at: "start"; readonly note: SignInNote | null }
  | { readonly at: "waiting" }
  /** Back from the browser: who signed in, to confirm before anything connects. */
  | { readonly at: "arrived"; readonly arrival: Arrival }
  /** The invitation at `index` asked about; `join`, the ones joined so far. */
  | { readonly at: "invited"; readonly arrival: Arrival; readonly index: number; readonly join: readonly number[] }
  | { readonly at: "finishing" };

/** An invitation as the question says it (shared/accounts.ts, the phone's words too). */
export { invitationLine as invitedLine, invitationTitle as invitedTitle } from "../../../shared/accounts";

/** Teams the last sign-in couldn't connect, for the account's row in Settings. */
let missed: ReadonlyArray<TeamOutcome & { ok: false }> = [];
export const missedTeams = () => missed;

/**
 * One sign-in: Sign in starts it in main and waits for the browser; once back, the account is named and each
 * invitation asked about; it ends connected (the hub screens take over), cancelled, or with a note. A screen that goes
 * away mid-wait stops it, and one that goes away before the person said it's them drops the answer.
 */
export function useSignIn(onSignedIn?: (out: FinishOutcome & { ok: true }) => void) {
  const [step, setStep] = useState<SignInStep>({ at: "start", note: null });
  const mounted = useRef(true);
  const waiting = useRef(false);
  const held = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (waiting.current) void window.fleetd.cloud.cancel();
      if (held.current) void window.fleetd.cloud.notMe();
    };
  }, []);
  const start = useCallback(() => {
    setStep({ at: "waiting" });
    waiting.current = true;
    void window.fleetd.cloud.signIn().then((out) => {
      waiting.current = false;
      held.current = out.ok;
      if (!mounted.current) {
        if (out.ok) void window.fleetd.cloud.notMe();
        return;
      }
      if (out.ok) setStep({ at: "arrived", arrival: out.arrival });
      else setStep({ at: "start", note: out.cancelled === true ? null : { quiet: out.failure.code === "timeout", failure: out.failure } });
    });
  }, []);
  const finish = useCallback(
    (join: readonly number[]) => {
      held.current = false;
      setStep({ at: "finishing" });
      void window.fleetd.cloud.finish([...join]).then((out) => {
        void refreshCloud();
        if (out.ok) {
          missed = out.teams.filter((t): t is TeamOutcome & { ok: false } => !t.ok);
          onSignedIn?.(out);
        }
        if (!mounted.current) return;
        setStep({ at: "start", note: out.ok ? null : { quiet: out.failure.code === "none_joined", failure: out.failure } });
      });
    },
    [onSignedIn],
  );
  const cancel = useCallback(() => void window.fleetd.cloud.cancel(), []);
  /** It's them: on to the invitations, else connect. */
  const confirm = useCallback(() => {
    if (step.at !== "arrived") return;
    if (step.arrival.invitations.length === 0) finish([]);
    else setStep({ at: "invited", arrival: step.arrival, index: 0, join: [] });
  }, [step, finish]);
  /** Not them: nothing was connected; the answer is dropped and its session ended. */
  const notMe = useCallback(() => {
    held.current = false;
    setStep({ at: "start", note: null });
    void window.fleetd.cloud.notMe().then(() => refreshCloud());
  }, []);
  /** The invitation on screen: joined or left for the next sign-in, then the next one, or connect. */
  const answer = useCallback(
    (joined: boolean) => {
      if (step.at !== "invited") return;
      const join = joined ? [...step.join, step.index] : step.join;
      const next = step.index + 1;
      if (next < step.arrival.invitations.length) setStep({ ...step, index: next, join });
      else finish(join);
    },
    [step, finish],
  );
  return { step, start, cancel, confirm, notMe, answer };
}

function Note({ note }: { note: SignInNote }) {
  return (
    <div className={s.note} role={note.quiet ? "status" : "alert"}>
      <Text tone={note.quiet ? "quiet" : "danger"}>{note.failure.message}</Text>
      {note.failure.fix === undefined ? null : <Text tone="quiet">{note.failure.fix}</Text>}
    </div>
  );
}

/** The centred column the welcome and the wait share, so the character and the title hold their place. */
function Stage({ id, children }: { id: string; children: ReactNode }) {
  return (
    <div className={s.stageScreen} data-screen={id}>
      <div className={s.stage}>{children}</div>
    </div>
  );
}

/** The first screen: the character, Sign in, and Use your own hub as a quiet row under it. */
export function Ways({ note, onSignIn, onOwn }: { note: SignInNote | null; onSignIn: () => void; onOwn: () => void }) {
  return (
    <Stage id="onboarding.ways">
      <Bot state={note !== null && !note.quiet ? "error" : "idle"} size={64} />
      <Text as="h1" size="xl" strong className={s.title}>
        Welcome to fleetd
      </Text>
      <div className={s.main}>
        {note === null ? null : <Note note={note} />}
        <Button variant="primary" className={s.signIn} onClick={onSignIn}>
          {note === null ? WAYS.signIn.name : "Sign in again"}
        </Button>
        <Text as="p" size="sm" tone="quiet">
          {WAYS.signIn.line}
        </Text>
      </div>
      <button type="button" className={s.second} onClick={onOwn}>
        <span className={s.secondName}>
          {WAYS.own.name}
          <ChevronRight size={14} aria-hidden />
        </span>
        <Text size="sm" tone="quiet">
          {WAYS.own.line}
        </Text>
      </button>
    </Stage>
  );
}

/** The browser has the sign-in page: say so, and offer the page again, its link, or the way back. */
export function Waiting({ onCancel }: { onCancel: () => void }) {
  const [copied, setCopied] = useState(false);
  return (
    <Stage id="onboarding.signin">
      <Bot state="thinking" size={64} />
      <Text as="h1" size="xl" strong className={s.title}>
        Finish signing in in your browser
      </Text>
      <Text as="p" tone="quiet" className={s.lede}>
        This window carries on by itself once you have.
      </Text>
      <div className={s.waitActions}>
        <Button size="md" onClick={() => void window.fleetd.cloud.reopen()}>
          Open the page again
        </Button>
        <Button size="md" variant="quiet" onClick={onCancel}>
          Cancel
        </Button>
      </div>
      <Text as="p" size="sm" tone="quiet" className={s.hubLine}>
        No page opened?{" "}
        <Button
          variant="link"
          onClick={() => {
            void window.fleetd.cloud.link().then((url) => (url === null ? false : copyText(url))).then(setCopied);
          }}
          onBlur={() => setCopied(false)}
        >
          {copied ? "Copied" : "Copy the sign-in link"}
        </Button>
      </Text>
    </Stage>
  );
}

/** Back from the browser: the account named first, so a sign-in that isn't theirs goes before anything connects. */
export function SignedInAs({ email, onContinue, onNotMe }: { email: string; onContinue: () => void; onNotMe: () => void }) {
  return (
    <Stage id="onboarding.signed-in">
      <Bot state="idle" size={64} />
      <Text as="h1" size="xl" strong className={s.title}>
        Signed in as {email}
      </Text>
      <div className={s.waitActions}>
        <Button variant="primary" size="md" onClick={onContinue} autoFocus>
          Continue
        </Button>
      </div>
      <Text as="p" size="sm" tone="quiet" className={s.hubLine}>
        Not you?{" "}
        <Button variant="link" onClick={onNotMe}>
          Sign out
        </Button>
      </Text>
    </Stage>
  );
}

/** One invitation, asked about before this app connects to its team. */
export function Invited({ invitation, onJoin, onLater }: { invitation: Invitation; onJoin: () => void; onLater: () => void }) {
  return (
    <Stage id="onboarding.invited">
      <Bot state="idle" size={64} />
      <Text as="h1" size="xl" strong className={s.title}>
        {invitationTitle(invitation)}
      </Text>
      <Text as="p" tone="quiet" className={s.lede}>
        {invitationLine(invitation)}
      </Text>
      <div className={s.waitActions}>
        <Button variant="primary" size="md" onClick={onJoin}>
          Join
        </Button>
        <Button size="md" variant="quiet" onClick={onLater}>
          Not now
        </Button>
      </div>
    </Stage>
  );
}

/** The teams connecting, after the questions. */
export function Finishing() {
  return (
    <Stage id="onboarding.finishing">
      <Bot state="thinking" size={64} />
      <Text as="h1" size="xl" strong className={s.title}>
        Connecting your teams
      </Text>
    </Stage>
  );
}

/** The steps after the browser, on the first screen: null when the sign-in isn't at one. */
export function AfterBrowser({ signIn }: { signIn: ReturnType<typeof useSignIn> }) {
  const { step } = signIn;
  if (step.at === "arrived") return <SignedInAs email={step.arrival.email} onContinue={signIn.confirm} onNotMe={signIn.notMe} />;
  if (step.at === "invited") {
    const invitation = step.arrival.invitations[step.index];
    return invitation === undefined ? null : <Invited key={step.index} invitation={invitation} onJoin={() => signIn.answer(true)} onLater={() => signIn.answer(false)} />;
  }
  if (step.at === "finishing") return <Finishing />;
  return null;
}

/** The way back from the own-hub form to the two ways in. */
export function BackToWays({ onBack }: { onBack: () => void }) {
  return (
    <div className={s.back}>
      <Button variant="quiet" icon={<ArrowLeft aria-hidden />} onClick={onBack}>
        Back
      </Button>
    </div>
  );
}

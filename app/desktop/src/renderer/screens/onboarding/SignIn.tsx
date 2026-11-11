// The first screen's two ways in (decision hosted.first-screen, artifact hosted-signin-design): Sign in, fleetd
// cloud, through the system browser; and Use your own hub, the connect form as it always was. Shown only when this
// build has the cloud's values (cloud.ts); without them the first screen is the connect form alone.
import { ArrowLeft, ChevronRight } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { SignInOutcome, TeamOutcome } from "../../../shared/cloud";
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

export type SignInStep = { readonly at: "start"; readonly note: SignInNote | null } | { readonly at: "waiting" };

/** Teams the last sign-in couldn't connect, for the account's row in Settings. */
let missed: ReadonlyArray<TeamOutcome & { ok: false }> = [];
export const missedTeams = () => missed;

/**
 * One sign-in: Sign in starts it in main and waits for the browser; it ends connected (the hub screens take over),
 * cancelled, or with a note. A screen that goes away mid-wait stops it.
 */
export function useSignIn(onSignedIn?: (out: SignInOutcome & { ok: true }) => void) {
  const [step, setStep] = useState<SignInStep>({ at: "start", note: null });
  const mounted = useRef(true);
  const waiting = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (waiting.current) void window.fleetd.cloud.cancel();
    };
  }, []);
  const start = useCallback(() => {
    setStep({ at: "waiting" });
    waiting.current = true;
    void window.fleetd.cloud.signIn().then((out) => {
      waiting.current = false;
      void refreshCloud();
      if (out.ok) {
        missed = out.teams.filter((t): t is TeamOutcome & { ok: false } => !t.ok);
        onSignedIn?.(out);
      }
      if (!mounted.current) return;
      if (out.ok) setStep({ at: "start", note: null });
      else setStep({ at: "start", note: out.cancelled === true ? null : { quiet: out.failure.code === "timeout", failure: out.failure } });
    });
  }, [onSignedIn]);
  const cancel = useCallback(() => void window.fleetd.cloud.cancel(), []);
  return { step, start, cancel };
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

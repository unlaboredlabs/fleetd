// Try it outside its own view (design preview, W58): an agent's one-line suggestion to try a PR, never a run of its
// own; the PR's sign-off line once the person said "I want to try this"; and that PR under Waiting on you in the merge
// line and the chat's waiting line until they say it works for them. Off unless the person asked, PR by PR.
import { Play } from "lucide-react";
import type { Waiting } from "../chat/attentionModel";
import { Button, Text, Truncate } from "../../ui";
import type { StateLine } from "../prs/words";
import { panelRoute, toHash, type ProjectKey } from "../shell/routes";
import { isPreviewProject, PREVIEW_PR, signOff, STOREFRONT, useTryIt, WRITER } from "./preview";
import s from "./tryit.module.css";

export const PR_HASH = toHash(panelRoute(STOREFRONT, { tab: "prs", pr: { repo: PREVIEW_PR.repo, number: PREVIEW_PR.number } }));

/** The writer's suggestion, as one plain line with its button: shown until a run exists. Nothing starts from it. */
export function Suggestion({ onTry }: { onTry: () => void }) {
  const st = useTryIt();
  if (Object.keys(st.runs).length > 0) return null;
  return (
    <div className={s.suggest} role="note">
      <Text size="sm" className={s.suggestWords}>
        <Text size="sm" strong>
          {`${WRITER} suggests trying it:`}
        </Text>{" "}
        the checkout’s buttons read differently in German and Dutch, on the web and in the Android app.
      </Text>
      <Button variant="secondary" size="sm" icon={<Play aria-hidden />} onClick={onTry}>
        Try it
      </Button>
    </div>
  );
}

/** The PR's state while the person's sign-off holds it, or once they gave it; undefined when they asked for none. */
export const useSignOffState = (preview: boolean): StateLine | undefined => {
  const st = useTryIt();
  if (!preview || !st.wantTry) return undefined;
  return st.signedOff
    ? { word: "ready", sentence: "Ready. You said it works for you; it merges when its turn comes.", tone: "quiet" }
    : { word: "waiting on you", sentence: "Reviewed and green. It waits for you to try it and say it works.", tone: "needs-you" };
};

/** Under the PR's summary while it waits on the person's sign-off: the two things to do. */
export function SignOffLine({ onTry }: { onTry: () => void }) {
  const st = useTryIt();
  if (!st.wantTry || st.signedOff) return null;
  return (
    <div className={s.suggest} role="group" aria-label="Sign-off">
      <Text size="sm" tone="quiet" className={s.suggestWords}>
        You asked to try it before it merges.
      </Text>
      <Button variant="quiet" size="sm" onClick={onTry}>
        Try it
      </Button>
      <Button variant="secondary" size="sm" onClick={signOff}>
        Works for me
      </Button>
    </div>
  );
}

/** Whether the merge line has a PR waiting on the person's sign-off. */
export const useSignOffWaiting = (project: ProjectKey): boolean => {
  const st = useTryIt();
  return isPreviewProject(project) && st.wantTry;
};

/** The chat's waiting line while a PR waits on the person's sign-off. */
export const useSignOffAttention = (project: ProjectKey): Waiting | undefined => {
  const st = useTryIt();
  return isPreviewProject(project) && st.wantTry && !st.signedOff ? { what: `your sign-off on #${String(PREVIEW_PR.number)}, which you asked to try before it merges`, targets: [] } : undefined;
};

/** The merge line's row under Waiting on you: the PR, the word, why, and the two things to do. */
export function SignOffRow({ onTry }: { onTry: () => void }) {
  const st = useTryIt();
  const tried = st.runs.web !== undefined || st.runs.android !== undefined;
  return (
    <div className={s.waitRow} data-pr={PREVIEW_PR.number}>
      <a className={s.waitTop} href={PR_HASH}>
        <span className={s.waitTitle}>
          <Truncate lines={2} expand="none">
            Checkout buttons in German and Dutch
          </Truncate>
        </span>
        <Text size="xs" tone="faint" tabular>
          #{PREVIEW_PR.number}
        </Text>
      </a>
      <span className={s.waitWord} data-tone={st.signedOff ? "done" : "needs-you"}>
        {st.signedOff ? "signed off, next in line" : "waiting on your sign-off"}
      </span>
      <Text size="xs" tone="quiet">
        {st.signedOff ? "You said it works for you." : `Reviewed and green. You asked to try it before it merges${tried ? "; you tried it on the web earlier." : "."}`}
      </Text>
      {st.signedOff ? null : (
        <span className={s.waitActions}>
          <Button variant="quiet" size="sm" icon={<Play aria-hidden />} onClick={onTry}>
            Try it
          </Button>
          <Button variant="secondary" size="sm" onClick={signOff}>
            Works for me
          </Button>
        </span>
      )}
    </div>
  );
}


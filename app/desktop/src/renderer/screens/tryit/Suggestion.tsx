// Try it outside its own view: the button on a PR and on the merge line, which reopens a preview that is starting or
// ready and starts one only when none is; and an agent's suggestion to try a PR, one plain line with that button, in
// the PR's overview and in the chat. Nothing starts from a suggestion: only the person's press does (D161).
import { Play } from "lucide-react";
import type { PreviewSuggestion } from "../../../shared/contracts";
import { useDataLayer } from "../../src/data/react";
import { Button, Text, type ButtonVariant } from "../../ui";
import type { ProjectKey } from "../shell/routes";
import { tryIt, useTryIt } from "./hub";
import { ofPr } from "./model";
import s from "./tryit.module.css";

/** Try it for PR `repo#number`; nothing for a hub without previews, or a key that may only open running ones. */
export function TryItButton({ project, repo, number, variant = "secondary", label }: { project: ProjectKey; repo: string; number: number; variant?: ButtonVariant; label?: string }) {
  const layer = useDataLayer();
  const of = ofPr(repo, number);
  const t = useTryIt(project, of);
  if (!t.on || t.action === "none") return null;
  const word = t.preview?.state === "ready" ? "ready" : t.preview?.state === "starting" || t.asking ? "starting" : undefined;
  return (
    <Button
      variant={variant}
      size="sm"
      icon={<Play aria-hidden />}
      disabled={t.asking}
      aria-label={label ?? (word === undefined ? `Try #${String(number)}` : `Open #${String(number)}’s preview, ${word}`)}
      onClick={(e) => {
        // A row's link around it doesn't open too.
        e.preventDefault();
        e.stopPropagation();
        void tryIt(layer, project, of, t.action);
      }}
    >
      {word === undefined ? "Try it" : `Try it · ${word}`}
    </Button>
  );
}

const suggestWords = (x: Pick<PreviewSuggestion, "by" | "why">) => (
  <>
    <Text size="sm" strong>
      {`${x.by} suggests trying it:`}
    </Text>{" "}
    {x.why}
  </>
);

/** In a PR's overview: its agent's suggestion, until the PR has a preview. */
export function SuggestionLine({ project, repo, number }: { project: ProjectKey; repo: string; number: number }) {
  const t = useTryIt(project, ofPr(repo, number));
  if (t.suggestion === undefined || !t.on) return null;
  return (
    <div className={s.suggest} role="note">
      <Text size="sm" className={s.suggestWords}>
        {suggestWords(t.suggestion)}
      </Text>
      <TryItButton project={project} repo={repo} number={number} />
    </div>
  );
}

/** In the chat, in place of the hub's message text: who suggests it and why, Try it while it can be tried, and when. */
export function ChatSuggestion({ project, suggestion, at }: { project: ProjectKey; suggestion: PreviewSuggestion; at: string }) {
  const of = suggestion.of;
  return (
    <div className={s.chatSuggest} role="note">
      <Text size="xs" tone="quiet" className={s.suggestWords}>
        <Text size="xs" strong>
          {`${suggestion.by} suggests trying it:`}
        </Text>{" "}
        {suggestion.why}
      </Text>
      {of.kind === "pr" ? <TryItButton project={project} repo={of.repo} number={of.number} /> : null}
      <Text size="xs" tone="quiet" tabular>
        {at}
      </Text>
    </div>
  );
}

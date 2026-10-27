// A chat with no messages yet: what to ask the lead (or, in a Navi's chat, the Navi), just above the box, and a few
// starters that fill the box (never send) so the first message is yours to edit.
import { Button, Text } from "../../ui";
import { projectKey } from "../../src/data/store";
import { SetupChecklist } from "../onboarding";
import { runCommand } from "../palette";
import { useDraft } from "./drafts";
import type { ProjectRef } from "./slots";
import s from "./view.module.css";

export const STARTERS = [
  "Look around and tell me what needs work first.",
  "Find what’s failing in CI and fix it.",
  "Explain how this project is put together.",
] as const;

/** A Navi's: an assistant's first asks, not a codebase's. */
export const NAVI_STARTERS = [
  "Tell me what you can do, and what you’ll ask me before doing.",
  "What’s on my calendar this week?",
  "Ask each project’s lead how its work is going, and sum it up for me.",
] as const;

export function EmptyChat({ project, title, navi = false }: { project: ProjectRef; title: string; navi?: boolean }) {
  const [, setDraft] = useDraft(projectKey(project));
  const starters = navi ? NAVI_STARTERS : STARTERS;
  return (
    <div className={s.empty} data-entry="empty">
      <div className={s.emptyBody}>
        {navi ? null : <SetupChecklist />}
        <Text as="h2" size="lg" strong>
          {navi ? (title === "" ? "What can I do for you?" : `What can ${title} do for you?`) : title === "" ? "What should the lead do?" : `What should the lead do in ${title}?`}
        </Text>
        <div className={s.starters}>
          {starters.map((text) => (
            <Button
              key={text}
              variant="secondary"
              title={text}
              onClick={() => {
                setDraft((d) => ({ ...d, text }));
                runCommand("composer.focus");
              }}
            >
              {text}
            </Button>
          ))}
        </div>
      </div>
    </div>
  );
}

// A chat with no messages yet: what to ask the lead, just above the box, and a few starters that fill the box
// (never send) so the first message is yours to edit. Agents already at work show under them.
import type { ReactNode } from "react";
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

export function EmptyChat({ project, title, children }: { project: ProjectRef; title: string; children?: ReactNode }) {
  const [, setDraft] = useDraft(projectKey(project));
  return (
    <div className={s.empty} data-entry="empty">
      <div className={s.emptyBody}>
        <SetupChecklist />
        <Text as="h2" size="lg" strong>
          {title === "" ? "What should the lead do?" : `What should the lead do in ${title}?`}
        </Text>
        <div className={s.starters}>
          {STARTERS.map((text) => (
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
        {children}
      </div>
    </div>
  );
}

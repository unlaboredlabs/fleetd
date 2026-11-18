// A chat with no messages yet: what to ask the lead, just above the box, and a few starters that fill the box (never
// send) so the first message is yours to edit.
import { Text } from "../../ui";
import { ProjectAvatar } from "../projects/ProjectAvatar";
import { projectKey } from "../../src/data/store";
import { runCommand } from "../palette";
import { useDraft } from "./drafts";
import type { ProjectRef } from "./slots";
import s from "./view.module.css";

export const STARTERS = [
  "Look around and tell me what needs work first.",
  "Find what’s failing in CI and fix it.",
  "Explain how this bot's code is put together.",
] as const;

export function EmptyChat({ project, title, pictured }: { project: ProjectRef; title: string; pictured?: Parameters<typeof ProjectAvatar>[0]["project"] | undefined }) {
  const [, setDraft] = useDraft(projectKey(project));
  return (
    <div className={s.empty} data-entry="empty">
      <div className={s.emptyBody}>
        {pictured === undefined ? null : <ProjectAvatar project={pictured} size={64} className={s.emptyBot} />}
        <Text as="h2" className={s.emptyTitle}>
          {title === "" ? "What should the lead do?" : `What should the lead do in ${title}?`}
        </Text>
        <div className={s.starters}>
          {STARTERS.map((text) => (
            <button
              key={text}
              type="button"
              className={s.starter}
              onClick={() => {
                setDraft((d) => ({ ...d, text }));
                runCommand("composer.focus");
              }}
            >
              {text}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

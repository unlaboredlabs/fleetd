// A chat with no messages yet: what to ask the lead, just above the box, and a few starters that fill the box (never
// send) so the first message is yours to edit.
import type { ProjectSummary } from "../../../shared/contracts";
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

/** A bot with no repo has no code or CI to ask about. */
export const NO_REPO_STARTERS = [
  "Tell me what you can do for me here.",
  "Research something and write it up for me.",
  "Plan a project with me, step by step.",
] as const;

export function EmptyChat({ project, title, pictured }: { project: ProjectRef; title: string; pictured?: ProjectSummary | undefined }) {
  const [, setDraft] = useDraft(projectKey(project));
  const starters = (pictured?.repos?.length ?? 0) > 0 ? STARTERS : NO_REPO_STARTERS;
  return (
    <div className={s.empty} data-entry="empty">
      <div className={s.emptyBody}>
        {pictured === undefined ? null : <ProjectAvatar project={pictured} size={64} className={s.emptyBot} />}
        <Text as="h2" className={s.emptyTitle}>
          {title === "" ? "What should the lead do?" : `What should the lead do in ${title}?`}
        </Text>
        <div className={s.starters}>
          {starters.map((text) => (
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

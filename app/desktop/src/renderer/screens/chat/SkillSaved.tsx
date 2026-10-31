// A Navi's chat line when it saves or changes one of its skills (skill_save, W238): one quiet line, the skill's name a
// link to it in the panel's Skills, where the person reads, edits or reverts it. Nothing to approve.
import type { SkillSaved } from "../../../shared/contracts";
import { Text } from "../../ui";
import { panelRoute, toHash } from "../shell/routes";
import type { ProjectRef } from "./slots";
import s from "./view.module.css";

export function SkillSavedLine({ project, saved }: { project: ProjectRef; saved: SkillSaved }) {
  const href = toHash(panelRoute({ machineId: project.machineId, projectId: project.projectId }, { tab: "skills", skill: saved.name }));
  return (
    <Text size="xs" tone="quiet" data-skill-saved={saved.name}>
      {saved.created ? "Saved a new skill, " : "Updated the skill "}
      <a className={s.link} href={href}>
        {saved.name}
      </a>
      {`: ${saved.why}`}
    </Text>
  );
}

// A project's avatar where its chat shows (the sidebar, the chat's title, its settings): its picture once a
// person gave it one, read once per picture (project_avatar_get, refetched on its project.settings event), else its
// bot (ui's Bot), in the color picked for it and the state its project is in (botState.ts).
import { useEffect } from "react";
import type { ProjectSummary } from "../../../shared/contracts";
import { useToolQuery } from "../../src/data/react";
import { Avatar } from "../../ui";
import type { BotIn } from "../../../shared/bot";
import { useBotState } from "./botState";

type Pictured = Pick<ProjectSummary, "machineId" | "projectId" | "title" | "avatar" | "avatarColor">;

/** Its picture's data: URL, undefined while it has none or it loads. */
export const usePicture = (project: Pick<ProjectSummary, "machineId" | "projectId" | "avatar"> | undefined): string | undefined => {
  const avatar = project?.avatar;
  const got = useToolQuery("project_avatar_get", { machineId: project?.machineId ?? "", projectId: project?.projectId ?? "" }, { enabled: avatar !== undefined, keepPrevious: true });
  // A picture changed while this app wasn't listening (its disk cache holds the one before): read the new one.
  const stale = avatar !== undefined && got.data !== undefined && got.data.avatar !== avatar && !got.isFetching;
  const { refetch } = got;
  useEffect(() => {
    if (stale) void refetch();
  }, [stale, refetch]);
  return avatar === undefined || got.data === undefined ? undefined : `data:${got.data.mime};base64,${got.data.dataB64}`;
};

export function ProjectAvatar({ project, size, own, className }: { project: Pictured; size?: number | undefined; own?: Partial<BotIn> | undefined; className?: string | undefined }) {
  const picture = usePicture(project);
  const bot = useBotState(`${project.machineId}/${project.projectId}`, own);
  // While a new picture loads, the bot stays rather than flashing the letters.
  return <Avatar name={project.title} size={size} src={picture} bot={bot} color={project.avatarColor} className={className} />;
}

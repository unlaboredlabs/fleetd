// A project's or Navi's avatar where its chat shows (the sidebar, the chat's title, its settings): its picture once a
// person gave it one, read once per picture (project_avatar_get, refetched on its project.settings event), else its
// letters.
import { useEffect } from "react";
import type { ProjectSummary } from "../../../shared/contracts";
import { useToolQuery } from "../../src/data/react";
import { Avatar } from "../../ui";
import { isNavi } from "../navi/model";

type Pictured = Pick<ProjectSummary, "machineId" | "projectId" | "title" | "kind" | "avatar">;

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

export function ProjectAvatar({ project, size, className }: { project: Pictured; size?: number | undefined; className?: string | undefined }) {
  return <Avatar name={project.title} navi={isNavi(project)} size={size} src={usePicture(project)} className={className} />;
}

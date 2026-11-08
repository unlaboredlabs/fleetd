// Settings › Projects (#/settings/projects): the hub's projects you can see, each a row that opens its pages
// (#/settings/projects?for=<machine>/<project>). The archived ones are here too, after the others: an archived project
// is out of the app's sidebar, and its page is where it comes back.
import { Button, Text } from "../../ui";
import { ProjectAvatar } from "../projects/ProjectAvatar";
import { isArchived, isOnlyMe } from "../projects/model";
import { navigate } from "../shell/navigation";
import type { ProjectSummary } from "./contracts";
import { OpenList, OpenRow } from "./Frames";
import { useLive } from "./hub";
import { PageHead, useProjects } from "./parts";
import { formatRoute } from "./route";
import s from "./settings.module.css";

/** Where a project is: its repos, then its machine. */
const whereLine = (p: ProjectSummary): string => [...(p.repos ?? []).map((r) => r.name), p.machineId].join(" · ");

export function ProjectList() {
  const live = useLive();
  const projects = useProjects();
  if (!live) {
    // The project list waits on a live hub: without one it would say Loading… for good.
    return (
      <div className={s.scroll} data-screen="settings.projects.list">
        <div className={s.column}>
          <PageHead title="Projects" />
          <Text tone="quiet">Not connected. Connect to a hub to change its projects&apos; settings.</Text>
        </div>
      </div>
    );
  }
  const shown = projects === undefined ? [] : [...projects.filter((p) => !isArchived(p)), ...projects.filter(isArchived)];
  return (
    <div className={s.scroll} data-screen="settings.projects.list">
      <div className={s.column}>
        <PageHead title="Projects">Each project&apos;s own settings: its repos, agents, instructions, automations and prompts.</PageHead>
        {projects === undefined ? (
          <Text tone="quiet">Loading…</Text>
        ) : shown.length === 0 ? (
          <div className={s.inline}>
            <Text tone="quiet">No projects yet.</Text>
            <Button size="sm" onClick={() => navigate({ id: "projects.add" })}>
              New project
            </Button>
          </div>
        ) : (
          <OpenList label="Projects">
            {shown.map((p) => {
              const key = `${p.machineId}/${p.projectId}`;
              const marks = [isOnlyMe(p) ? "Only me" : null, isArchived(p) ? "Archived" : null].filter((m) => m !== null);
              return (
                <OpenRow
                  key={key}
                  title={p.title}
                  detail={whereLine(p)}
                  lead={<ProjectAvatar project={p} size={28} />}
                  trailing={
                    marks.length === 0 ? undefined : (
                      <Text size="xs" tone="quiet">
                        {marks.join(" · ")}
                      </Text>
                    )
                  }
                  onOpen={() => (window.location.hash = formatRoute({ tab: "projects", for: key }))}
                />
              );
            })}
          </OpenList>
        )}
      </div>
    </div>
  );
}

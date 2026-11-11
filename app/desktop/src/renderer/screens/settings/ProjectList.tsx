// Settings › Projects (#/settings/projects): the hub's projects you can see, each a row that opens its pages
// (#/settings/projects?for=<machine>/<project>). The archived ones are here too, after the others: an archived project
// is out of the app's sidebar, and its page is where it comes back.
import { Button, Text } from "../../ui";
import { ProjectAvatar } from "../projects/ProjectAvatar";
import { isArchived, isOnlyMe } from "../projects/model";
import { navigate } from "../shell/navigation";
import type { ProjectSummary } from "./contracts";
import { useLive } from "./hub";
import { GroupNote, PageHead, SettingsList, SettingsListRow, SettingsRow, SettingsSection, useProjects } from "./parts";
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
          <SettingsSection>
            <GroupNote>Not connected. Connect to a hub to change its projects&apos; settings.</GroupNote>
          </SettingsSection>
        </div>
      </div>
    );
  }
  const shown = projects === undefined ? [] : [...projects.filter((p) => !isArchived(p)), ...projects.filter(isArchived)];
  return (
    <div className={s.scroll} data-screen="settings.projects.list">
      <div className={s.column}>
        <PageHead title="Projects">Each project&apos;s own settings: its repos, agents, instructions and automations.</PageHead>
        <SettingsSection>
          {projects === undefined ? (
            <GroupNote>Loading…</GroupNote>
          ) : shown.length === 0 ? (
            <SettingsRow
              title="No projects yet."
              control={
                <Button size="sm" onClick={() => navigate({ id: "projects.add" })}>
                  New project
                </Button>
              }
            />
          ) : (
            <SettingsList label="Projects">
              {shown.map((p) => {
                const key = `${p.machineId}/${p.projectId}`;
                const marks = [isOnlyMe(p) ? "Only me" : null, isArchived(p) ? "Archived" : null].filter((m) => m !== null);
                return (
                  <SettingsListRow
                    key={key}
                    name={p.title}
                    label={p.title}
                    icon={<ProjectAvatar project={p} size={20} />}
                    meta={marks.length === 0 ? undefined : marks.join(" · ")}
                    open={{ onClick: () => (window.location.hash = formatRoute({ tab: "projects", for: key })) }}
                  >
                    <Text size="sm" tone="quiet">
                      {whereLine(p)}
                    </Text>
                  </SettingsListRow>
                );
              })}
            </SettingsList>
          )}
        </SettingsSection>
      </div>
    </div>
  );
}

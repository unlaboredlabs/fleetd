// Settings › Bots (#/settings/projects): the hub's bots you can see, each a row that opens its pages
// (#/settings/projects?for=<machine>/<project>). The archived ones are in their own group under
// them, each with Bring back: an archived bot is out of the app's sidebar, and this is where it is found again.
import { useState } from "react";
import { Button, Text } from "../../ui";
import { useDataLayer } from "../../src/data/react";
import { archiveProject } from "../projects/actions";
import { ProjectAvatar } from "../projects/ProjectAvatar";
import { isArchived } from "../projects/model";
import { navigate } from "../shell/navigation";
import type { ProjectSummary } from "./contracts";
import { useLive } from "./hub";
import { GroupNote, PageHead, SettingsList, SettingsListRow, SettingsRow, SettingsSection, useProjects } from "./parts";
import { formatRoute } from "./route";
import s from "./settings.module.css";

/** Where a bot is: its repos, then its machine. */
const whereLine = (p: ProjectSummary): string => [...(p.repos ?? []).map((r) => r.name), p.machineId].join(" · ");

const keyOf = (p: ProjectSummary) => `${p.machineId}/${p.projectId}`;

export function ProjectList() {
  const live = useLive();
  const projects = useProjects();
  if (!live) {
    // The list waits on a live hub: without one it would say Loading… for good.
    return (
      <div className={s.scroll} data-screen="settings.projects.list">
        <div className={s.column}>
          <PageHead title="Bots" />
          <SettingsSection>
            <GroupNote>Not connected. Connect to a hub to change its bots&apos; settings.</GroupNote>
          </SettingsSection>
        </div>
      </div>
    );
  }
  const active = (projects ?? []).filter((p) => !isArchived(p));
  const archived = (projects ?? []).filter(isArchived);
  return (
    <div className={s.scroll} data-screen="settings.projects.list">
      <div className={s.column}>
        <PageHead title="Bots" />
        <SettingsSection>
          {projects === undefined ? (
            <GroupNote>Loading…</GroupNote>
          ) : active.length === 0 ? (
            <SettingsRow
              title={archived.length === 0 ? "No bots yet." : "Every bot is archived."}
              control={
                <Button size="sm" onClick={() => navigate({ id: "projects.add" })}>
                  New bot
                </Button>
              }
            />
          ) : (
            <SettingsList label="Bots">
              {active.map((p) => (
                <BotRow key={keyOf(p)} p={p} />
              ))}
            </SettingsList>
          )}
        </SettingsSection>
        {archived.length === 0 ? null : (
          <SettingsSection title="Archived">
            <SettingsList label="Archived">
              {archived.map((p) => (
                <BotRow key={keyOf(p)} p={p} archived />
              ))}
            </SettingsList>
          </SettingsSection>
        )}
      </div>
    </div>
  );
}

function BotRow({ p, archived = false }: { p: ProjectSummary; archived?: boolean }) {
  const key = keyOf(p);
  return (
    <SettingsListRow
      name={p.title}
      label={p.title}
      icon={<ProjectAvatar project={p} size={20} />}
      controls={archived ? <BringBack p={p} /> : undefined}
      open={{ onClick: () => (window.location.hash = formatRoute({ tab: "projects", for: key })) }}
    >
      <Text size="sm" tone="quiet">
        {whereLine(p)}
      </Text>
    </SettingsListRow>
  );
}

/** Back in the sidebar as it was, its lead free to start again. */
function BringBack({ p }: { p: ProjectSummary }) {
  const layer = useDataLayer();
  const [busy, setBusy] = useState(false);
  return (
    <Button
      size="sm"
      disabled={busy}
      onClick={(e) => {
        // The row opens the bot's settings; this button only brings it back.
        e.stopPropagation();
        setBusy(true);
        void archiveProject(layer, { machineId: p.machineId, projectId: p.projectId, title: p.title }, false).then(() => setBusy(false));
      }}
    >
      {busy ? "Bringing it back…" : "Bring back"}
    </Button>
  );
}

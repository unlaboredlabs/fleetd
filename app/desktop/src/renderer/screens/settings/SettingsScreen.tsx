// Settings (⌘, or the app menu), everyone's, with nothing hub-wide (that is Administration's, D209): General
// (appearance, time in the app, notifications, version and updates), Connections (this app's hubs, your Claude account
// and your GitHub), Projects (a project picked in the sidebar, with its Project, Agents, Instructions & memory and
// Automations pages) and Prompts. The route picks the page (#/settings/<tab>); see route.ts for the links into one
// prompt. The shell shows SettingsSidebar in the sidebar's place while Settings is open.
import { Automations } from "../automations";
import { AgentsSettings } from "./Agents";
import { ClaudeSettings } from "./Claude";
import { General } from "./General";
import { GithubSettings } from "./Github";
import { HubsSettings } from "./Hubs";
import { Instructions } from "./Instructions";
import { PageHead, useProjects } from "./parts";
import { ProjectSettings } from "./Projects";
import { Prompts } from "./Prompts";
import { isProjectTab, projectFor, useSettingsRoute } from "./route";
import s from "./settings.module.css";

export { SettingsSidebar } from "./SettingsSidebar";

export function SettingsScreen() {
  const route = useSettingsRoute();
  const projects = useProjects();
  // A project's pages are of the project picked in the sidebar; each starts afresh on another.
  const project = isProjectTab(route.tab) ? projectFor(route, projects) : route.for;
  const r = { ...route, for: project };
  return (
    <div className={s.frame}>
      {route.tab === "general" ? (
        <General />
      ) : route.tab === "connections" ? (
        <Connections />
      ) : route.tab === "projects" ? (
        <ProjectSettings key={project} route={r} />
      ) : route.tab === "agents" ? (
        <AgentsSettings key={project} route={r} />
      ) : route.tab === "instructions" ? (
        <Instructions key={project} route={r} />
      ) : route.tab === "automations" ? (
        <Automations key={project} route={r} />
      ) : (
        <Prompts route={route} />
      )}
    </div>
  );
}

/** What you connect, each once: this app's hubs, your own Claude account and your own GitHub. */
function Connections() {
  return (
    <div className={s.scroll} data-screen="settings.connections">
      <div className={s.column}>
        <PageHead title="Connections">Your own: the hubs this app is paired with, and the Claude and GitHub accounts your work runs on.</PageHead>
        <HubsSettings />
        <ClaudeSettings />
        <GithubSettings />
      </div>
    </div>
  );
}

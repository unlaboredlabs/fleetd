// Settings (⌘, or the app menu), one window in three groups (D211). You: General (appearance, time in the app,
// notifications, version), Your accounts (the Claude, GitHub and 1Password your work runs on), Your memory, Your devices (and Pair
// a phone) and Hubs (this app's hubs and their links). Projects: a project picked in the sidebar, with its Project,
// Agents, Instructions & memory, Automations and Prompts pages. Hub, for the hub's owners and admins only (admin/HubPages.tsx): what reaches every teammate's work.
// The route picks the page (#/settings/<tab>, #/settings/hub/<page>); see route.ts for the links into one prompt. The
// shell shows SettingsSidebar in the sidebar's place while Settings is open.
import { Automations } from "../automations";
import { HubPage } from "../admin/HubPages";
import { AgentsSettings } from "./Agents";
import { ClaudeSettings } from "./Claude";
import { DevicesSettings } from "./Devices";
import { General } from "./General";
import { GithubSettings } from "./Github";
import { HubLinksSettings, HubsSettings } from "./Hubs";
import { Instructions } from "./Instructions";
import { YourMemory } from "./Memory";
import { OnePasswordSettings } from "./OnePassword";
import { PageHead, useProjects } from "./parts";
import { ProjectSettings } from "./Projects";
import { Prompts } from "./Prompts";
import { isHubTab, isProjectTab, projectFor, useSettingsRoute } from "./route";
import s from "./settings.module.css";

export { SettingsSidebar } from "./SettingsSidebar";

export function SettingsScreen() {
  const route = useSettingsRoute();
  const projects = useProjects();
  // A project's pages are of the project picked in the sidebar; each starts afresh on another, except Prompts, which
  // stays mounted so it can ask before a switch drops a draft.
  const project = isProjectTab(route.tab) ? projectFor(route, projects) : route.for;
  const r = { ...route, for: project };
  const tab = route.tab;
  return (
    <div className={s.frame}>
      {isHubTab(tab) ? (
        <HubPage tab={tab} route={route} />
      ) : tab === "general" ? (
        <General />
      ) : tab === "accounts" ? (
        <YourAccounts />
      ) : tab === "your-memory" ? (
        <YourMemoryPage />
      ) : tab === "devices" ? (
        <YourDevicesPage />
      ) : tab === "hubs" ? (
        <Hubs />
      ) : tab === "projects" ? (
        <ProjectSettings key={project} route={r} />
      ) : tab === "agents" ? (
        <AgentsSettings key={project} route={r} />
      ) : tab === "instructions" ? (
        <Instructions key={project} route={r} />
      ) : tab === "automations" ? (
        <Automations key={project} route={r} />
      ) : (
        <Prompts route={r} />
      )}
    </div>
  );
}

/** The accounts your own work runs on: your Claude account, your GitHub and your 1Password. Nobody else's work uses them. */
function YourAccounts() {
  return (
    <div className={s.scroll} data-screen="settings.accounts">
      <div className={s.column}>
        <PageHead title="Your accounts">The accounts the work you start runs on. Nobody else&apos;s work ever uses them.</PageHead>
        <ClaudeSettings />
        <GithubSettings />
        <OnePasswordSettings />
      </div>
    </div>
  );
}

/** What the leads remember about you: yours alone (D212). */
function YourMemoryPage() {
  return (
    <div className={s.scroll} data-screen="settings.your-memory">
      <div className={s.column}>
        <PageHead title="Your memory">How you work, as the leads remember it when you correct them or set a rule. Edit or delete anything that is wrong.</PageHead>
        <YourMemory />
      </div>
    </div>
  );
}

/** The devices signed in as you, and Pair a phone. */
function YourDevicesPage() {
  return (
    <div className={s.scroll} data-screen="settings.devices">
      <div className={s.column}>
        <PageHead title="Your devices">The apps signed in as you: this one, your phone. Pair a phone by scanning a QR with the fleetd app.</PageHead>
        <DevicesSettings />
      </div>
    </div>
  );
}

/** The hubs this app is paired with, each with the hub links made as you on it. */
function Hubs() {
  return (
    <div className={s.scroll} data-screen="settings.hubs">
      <div className={s.column}>
        <PageHead title="Hubs">The hubs this app is paired with, and the links that let a Navi on another hub act as you.</PageHead>
        <HubsSettings />
        <HubLinksSettings />
      </div>
    </div>
  );
}

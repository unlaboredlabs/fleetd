// Settings (⌘, or the app menu), one window in three groups (D211), its sidebar one flat list of pages. You: General
// (appearance, time in the app, notifications, version), Your accounts (the Claude, GitHub and 1Password your work runs
// on), Vault (the logins, cards, addresses and variables your agents use), Your memory (and Import memory) and Hubs &
// devices (this app's hubs, the devices signed in as you with Pair a phone, and the hub links). Projects: the list of
// projects, each opening its Project, Agents, Instructions & memory, Automations and Vault pages under tabs
// (Frames.tsx), and its built-in prompts from the foot of its Instructions. Hub, for the hub's owners and admins only
// (admin/HubPages.tsx): what reaches every teammate's work. The route picks the page (#/settings/<tab>,
// #/settings/hub/<page>), and a tab that was a page once opens the page that holds it now, at its part (route.ts,
// which also has the links into one prompt). The shell shows SettingsSidebar in the sidebar's place while Settings is
// open.
import { useEffect } from "react";
import { Automations } from "../automations";
import { HubPage } from "../admin/HubPages";
import { AgentsSettings } from "./Agents";
import { ClaudeSettings } from "./Claude";
import { DevicesSettings } from "./Devices";
import { General } from "./General";
import { GithubSettings } from "./Github";
import { HubLinksSettings, HubsSettings } from "./Hubs";
import { ImportMemory } from "./ImportMemory";
import { Instructions } from "./Instructions";
import { YourMemory } from "./Memory";
import { OnePasswordSettings } from "./OnePassword";
import { Part, ProjectFrame } from "./Frames";
import { PageHead, useProjects } from "./parts";
import { ProjectList } from "./ProjectList";
import { ProjectSettings } from "./Projects";
import { Prompts } from "./Prompts";
import { ProjectVault, YourVault } from "./Vault";
import { revealNext } from "./reveal";
import { isHubTab, isProjectTab, pageOf, projectFor, useSettingsRoute } from "./route";
import s from "./settings.module.css";

export { SettingsSidebar } from "./SettingsSidebar";

export function SettingsScreen() {
  const route = useSettingsRoute();
  const projects = useProjects();
  // Projects without a project is the list; a project's pages are of the project opened from it (else the one shown
  // last, or the first). Each starts afresh on another, except its built-in prompts, a page of their own with the way
  // back to Instructions, which stays mounted so it can ask before a switch drops a draft.
  const tab = pageOf(route.tab);
  // A link to what was a page once (Your devices, Hub › Machines › Updates, Every project › Agents) lands on its part.
  useEffect(() => {
    if (route.tab !== tab) revealNext(route.tab);
  }, [route.tab, tab]);
  const list = tab === "projects" && route.for === null;
  const project = isProjectTab(tab) && !list ? projectFor(route, projects) : route.for;
  const r = { ...route, for: project };
  const page = (
    <>
      {isHubTab(tab) ? (
        <HubPage tab={tab} route={route} />
      ) : tab === "general" ? (
        <General />
      ) : tab === "accounts" ? (
        <YourAccounts />
      ) : tab === "vault" ? (
        <YourVault />
      ) : tab === "your-memory" ? (
        <YourMemoryPage />
      ) : tab === "hubs" ? (
        <HubsAndDevices />
      ) : tab === "projects" ? (
        <ProjectSettings key={project} route={r} />
      ) : tab === "agents" ? (
        <AgentsSettings key={project} route={r} />
      ) : tab === "instructions" ? (
        <Instructions key={project} route={r} />
      ) : tab === "automations" ? (
        <Automations key={project} route={r} />
      ) : tab === "project-vault" ? (
        <ProjectVault project={project} />
      ) : (
        <Prompts route={r} />
      )}
    </>
  );
  return (
    <div className={s.frame}>
      {list ? (
        <ProjectList />
      ) : tab !== "prompts" && isProjectTab(tab) && project !== null ? (
        <ProjectFrame project={project} tab={tab}>
          {page}
        </ProjectFrame>
      ) : (
        page
      )}
    </div>
  );
}

/** The accounts your own work runs on: your Claude account, your GitHub and your 1Password. Nobody else's work uses them. */
function YourAccounts() {
  return (
    <div className={s.scroll} data-screen="settings.accounts">
      <div className={s.column}>
        <PageHead title="Your accounts" />
        <ClaudeSettings />
        <GithubSettings />
        <OnePasswordSettings />
      </div>
    </div>
  );
}

/** What the leads remember about you: yours alone (D212), and Import memory from another assistant. */
function YourMemoryPage() {
  return (
    <div className={s.scroll} data-screen="settings.your-memory">
      <div className={s.column}>
        <PageHead title="Your memory" />
        <YourMemory />
        <ImportMemory />
      </div>
    </div>
  );
}

/**
 * The hubs this app is paired with, the devices signed in as you on them (and Pair a phone), and the hub links made
 * as you. Your devices was a page of its own: a link to it lands on its part.
 */
function HubsAndDevices() {
  return (
    <div className={s.scroll} data-screen="settings.hubs">
      <div className={s.column}>
        <PageHead title="Hubs & devices" />
        <HubsSettings />
        <Part reveal="devices" screen="settings.devices">
          <DevicesSettings />
        </Part>
        <HubLinksSettings />
      </div>
    </div>
  );
}

// Settings (⌘, or the app menu): General, Hubs, Notifications, Agents (Max agents per project), Projects, MCP servers,
// Instructions, Memory, Skills and Prompts: everyone's, with nothing hub-wide (that is Administration's). The route picks the page
// (#/settings/<tab>); see route.ts for the links into one prompt. The shell shows SettingsSidebar in the sidebar's
// place while Settings is open.
import { Automations } from "../automations";
import { AgentsSettings } from "./Agents";
import { General } from "./General";
import { HubsSettings } from "./Hubs";
import { Instructions } from "./Instructions";
import { McpSettings } from "./McpServers";
import { Memory } from "./Memory";
import { Notifications } from "./Notifications";
import { ProjectSettings } from "./Projects";
import { Prompts } from "./Prompts";
import { Skills } from "./Skills";
import { useSettingsRoute } from "./route";
import s from "./settings.module.css";

export { SettingsSidebar } from "./SettingsSidebar";

export function SettingsScreen() {
  const route = useSettingsRoute();
  return (
    <div className={s.frame}>
      {route.tab === "general" ? (
        <General />
      ) : route.tab === "hubs" ? (
        <HubsSettings />
      ) : route.tab === "notifications" ? (
        <Notifications />
      ) : route.tab === "agents" ? (
        <AgentsSettings />
      ) : route.tab === "projects" ? (
        <ProjectSettings route={route} />
      ) : route.tab === "mcp" ? (
        <McpSettings />
      ) : route.tab === "prompts" ? (
        <Prompts route={route} />
      ) : route.tab === "memory" ? (
        <Memory route={route} />
      ) : route.tab === "automations" ? (
        <Automations route={route} />
      ) : route.tab === "skills" ? (
        <Skills route={route} />
      ) : (
        <Instructions route={route} />
      )}
    </div>
  );
}

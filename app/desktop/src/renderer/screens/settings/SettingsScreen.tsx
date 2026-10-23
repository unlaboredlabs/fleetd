// Settings (⌘, or the app menu): General, Notifications, Agents (Max agents), Instructions and Prompts. The route picks the page
// (#/settings/<tab>); see route.ts for the links into one prompt. The shell shows SettingsSidebar in the sidebar's
// place while Settings is open.
import { AgentsSettings } from "./Agents";
import { General } from "./General";
import { Instructions } from "./Instructions";
import { Notifications } from "./Notifications";
import { Prompts } from "./Prompts";
import { useSettingsRoute } from "./route";
import s from "./settings.module.css";

export { SettingsSidebar } from "./SettingsSidebar";

export function SettingsScreen() {
  const route = useSettingsRoute();
  return (
    <div className={s.frame}>
      {route.tab === "general" ? (
        <General />
      ) : route.tab === "notifications" ? (
        <Notifications />
      ) : route.tab === "agents" ? (
        <AgentsSettings />
      ) : route.tab === "prompts" ? (
        <Prompts route={route} />
      ) : (
        <Instructions route={route} />
      )}
    </div>
  );
}

// Settings (⌘, or the app menu): General, Agents (Max agents), Prompts and Instructions. The route picks the tab
// (#/settings/<tab>); see route.ts for the links into one prompt.
import { Text } from "../../ui";
import { AgentsSettings } from "./Agents";
import { General } from "./General";
import { Instructions } from "./Instructions";
import { Prompts } from "./Prompts";
import { parseRoute, tabHref, useHash, type Tab } from "./route";
import s from "./settings.module.css";

const NAV: ReadonlyArray<{ tab: Tab; label: string; help: string }> = [
  { tab: "general", label: "General", help: "Appearance, motion, the hub, data" },
  { tab: "agents", label: "Agents", help: "How many run at once, per project and in all" },
  { tab: "prompts", label: "Prompts", help: "Everything fleetd tells its agents" },
  { tab: "instructions", label: "Instructions", help: "Your own, added to every agent's first message" },
];

export function SettingsScreen() {
  const route = parseRoute(useHash());
  return (
    <div className={s.frame}>
      <nav className={s.nav} aria-label="Settings">
        <h1 className={s.navTitle}>
          <Text strong>Settings</Text>
        </h1>
        {NAV.map((n) => (
          <a key={n.tab} className={s.navItem} href={tabHref(n.tab)} aria-current={route.tab === n.tab ? "page" : undefined}>
            <Text strong={route.tab === n.tab}>{n.label}</Text>
            <Text size="xs" tone="quiet">
              {n.help}
            </Text>
          </a>
        ))}
      </nav>
      {route.tab === "general" ? (
        <General />
      ) : route.tab === "agents" ? (
        <AgentsSettings />
      ) : route.tab === "prompts" ? <Prompts route={route} /> : <Instructions route={route} />}
    </div>
  );
}

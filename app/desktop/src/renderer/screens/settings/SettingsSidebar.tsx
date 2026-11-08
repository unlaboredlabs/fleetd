// Settings in the sidebar's place: Back to where you were, a search field that narrows to an option by name, then
// one flat list of pages in three groups (D211), with nothing to pick or unfold. You: General, Your accounts, Your
// memory, Your devices, Hubs. Projects: the list of projects, each opening its pages under tabs (Frames.tsx). Hub, for
// the hub's owners and admins only: People, Machines, Updates, Every project (its four pages under tabs), Hub accounts,
// and Setup, always, saying how many required steps are left.
import { ArrowLeft, Brain, CircleArrowUp, FolderGit2, KeyRound, Layers, ListChecks, Network, Server, SlidersHorizontal, Smartphone, UserRound, Users } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Input, Sidebar, SidebarItem, SidebarSection, Text } from "../../ui";
import { useHub, useToolQuery } from "../../src/data/react";
import { useSettledAdministers } from "../admin/role";
import { navigate } from "../shell/navigation";
import type { HubTab } from "../shell/routes";
import { formatRoute, isEveryProject, isProjectTab, tabHref, useSettingsRoute, type SettingsRoute, type Tab } from "./route";
import { openOption, optionsFor, PAGE_LABEL, pagePath, searchSettings } from "./search";
import s from "./settings.module.css";

/** You's pages. */
const YOU: ReadonlyArray<{ tab: Tab; icon: ReactNode }> = [
  { tab: "general", icon: <SlidersHorizontal /> },
  { tab: "accounts", icon: <UserRound /> },
  { tab: "your-memory", icon: <Brain /> },
  { tab: "devices", icon: <Smartphone /> },
  { tab: "hubs", icon: <Network /> },
];

/** The Hub group's pages; Every project opens on its first tab. */
const HUB_PAGES: ReadonlyArray<{ tab: HubTab; icon: ReactNode; label?: string }> = [
  { tab: "hub.people", icon: <Users /> },
  { tab: "hub.machines", icon: <Server /> },
  { tab: "hub.updates", icon: <CircleArrowUp /> },
  { tab: "hub.profiles", icon: <Layers />, label: "Every project" },
  { tab: "hub.accounts", icon: <KeyRound /> },
  { tab: "hub.setup", icon: <ListChecks /> },
];

const go = (hash: string) => {
  window.location.hash = hash;
};

const noInput = {};

export function SettingsSidebar({ onBack }: { onBack: () => void }) {
  const route = useSettingsRoute();
  const administers = useSettledAdministers();
  const [query, setQuery] = useState("");
  const results = searchSettings(query, optionsFor(administers));
  const searching = query.trim() !== "";

  return (
    <Sidebar aria-label="Settings">
      <SidebarSection>
        <SidebarItem label="Back" icon={<ArrowLeft />} onClick={onBack} />
      </SidebarSection>
      <div className={s.search}>
        <Input
          type="search"
          aria-label="Search settings"
          placeholder="Search settings"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && results[0]) {
              openOption(results[0]);
              setQuery("");
            } else if (e.key === "ArrowDown") {
              e.preventDefault();
              e.currentTarget.closest("nav")?.querySelector<HTMLElement>("[data-result]")?.focus();
            } else if (e.key === "Escape" && searching) {
              e.stopPropagation();
              setQuery("");
            }
          }}
        />
      </div>
      {searching ? (
        <SidebarSection title="Results">
          {results.length === 0 ? (
            <Text as="p" size="xs" tone="quiet" className={s.sidebarNote}>
              No setting is called that.
            </Text>
          ) : (
            results.map((o) => (
              <SidebarItem
                key={o.key}
                data-result
                label={o.label}
                trailing={o.key === o.tab ? undefined : <Text size="xs" tone="quiet">{pagePath(o.tab)}</Text>}
                onClick={() => {
                  openOption(o);
                  setQuery("");
                }}
              />
            ))
          )}
        </SidebarSection>
      ) : (
        <>
          <SidebarSection title="You">
            {YOU.map((p) => (
              <SidebarItem key={p.tab} label={PAGE_LABEL[p.tab]} icon={p.icon} current={route.tab === p.tab} onClick={() => go(tabHref(p.tab))} />
            ))}
          </SidebarSection>
          <SidebarSection label="Projects">
            <SidebarItem label="Projects" icon={<FolderGit2 />} current={isProjectTab(route.tab)} onClick={() => go(formatRoute({ tab: "projects" }))} />
          </SidebarSection>
          {administers ? <HubGroup route={route} /> : null}
        </>
      )}
    </Sidebar>
  );
}

/**
 * The Hub group, for an owner or admin of the hub on screen: its pages in one flat list, Every project's under tabs on
 * its page, and Setup, always listed, with how many required steps are left while some are. With several hubs, which
 * one they manage is picked on the page (admin/HubPages.tsx).
 */
function HubGroup({ route }: { route: SettingsRoute }) {
  const { id } = useHub();
  const setup = useToolQuery("setup_list", noInput);
  const left = setup.data?.requiredLeft ?? 0;
  const open = (tab: HubTab) => navigate({ id: "settings", tab, at: id });
  return (
    <SidebarSection title="Hub" label="Hub">
      {HUB_PAGES.map((p) => (
        <SidebarItem
          key={p.tab}
          label={p.label ?? PAGE_LABEL[p.tab]}
          icon={p.icon}
          current={p.tab === "hub.profiles" ? isEveryProject(route.tab) : route.tab === p.tab}
          trailing={p.tab === "hub.setup" && left > 0 ? <Text size="xs" tone="warning">{`${String(left)} left`}</Text> : undefined}
          onClick={() => open(p.tab)}
        />
      ))}
    </SidebarSection>
  );
}

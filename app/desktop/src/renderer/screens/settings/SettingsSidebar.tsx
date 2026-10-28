// Settings in the sidebar's place: Back to where you were, a search field that narrows to an option by name, then
// the three groups (D211). You: General, Your accounts, Hubs. Projects: the project picker and that project's pages,
// with its prompts under Prompts. Hub, for the hub's owners and admins only: People, Machines, Every project's four
// pages (the hub-wide prompts under its Prompts), Hub accounts, and Setup while a required step is left, saying how
// many. With several hubs the Hub group switches between the hubs this person administers.
import {
  ArrowLeft,
  BookText,
  Brain,
  Bot,
  FolderGit2,
  KeyRound,
  Layers,
  ListChecks,
  MessageSquareText,
  Network,
  Server,
  SlidersHorizontal,
  UserRound,
  Users,
  Workflow,
} from "lucide-react";
import { useState, type ReactNode } from "react";
import { Input, Sidebar, SidebarItem, SidebarSection, Text } from "../../ui";
import { sections } from "./catalog";
import type { PromptSummary } from "./contracts";
import { HUB, parseScope, projectRefOf, scopeKey, type Scope } from "./editor";
import { HubScope, useHub, useHubs, useToolQuery } from "../../src/data/react";
import { HubChoice } from "../admin/HubPages";
import { useSettledAdministers } from "../admin/role";
import { navigate } from "../shell/navigation";
import type { HubTab } from "../shell/routes";
import { errorText, useLive } from "./hub";
import { ScopeSelect, useProjects } from "./parts";
import { formatRoute, isHubTab, projectFor, promptHref, tabHref, useSettingsRoute, type SettingsRoute, type Tab } from "./route";
import { openOption, optionsFor, PAGE_LABEL, pagePath, searchSettings } from "./search";
import s from "./settings.module.css";

/** You's pages. */
const YOU: ReadonlyArray<{ tab: Tab; icon: ReactNode }> = [
  { tab: "general", icon: <SlidersHorizontal /> },
  { tab: "accounts", icon: <UserRound /> },
  { tab: "your-memory", icon: <Brain /> },
  { tab: "hubs", icon: <Network /> },
];

/** The picked project's pages. */
const PROJECT_PAGES: ReadonlyArray<{ tab: Tab; icon: ReactNode }> = [
  { tab: "projects", icon: <FolderGit2 /> },
  { tab: "agents", icon: <Bot /> },
  { tab: "instructions", icon: <BookText /> },
  { tab: "automations", icon: <Workflow /> },
  { tab: "prompts", icon: <MessageSquareText /> },
];

/** Every project's pages, nested under it as a project's are under Projects. */
const EVERY_PROJECT: ReadonlyArray<HubTab> = ["hub.profiles", "hub.tools", "hub.instructions", "hub.prompts"];
const isEveryProject = (tab: Tab): tab is HubTab => EVERY_PROJECT.some((t) => t === tab);

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
          <ProjectsGroup route={route} />
          {administers ? <HubGroup route={route} /> : null}
        </>
      )}
    </Sidebar>
  );
}

/** The project the project pages are of, picked here, and its pages; its prompts under Prompts while that is open. */
function ProjectsGroup({ route }: { route: SettingsRoute }) {
  const projects = useProjects();
  const project = projectFor(route, projects);
  const scope = project === null ? null : parseScope(project);
  // Picking another project keeps the page you are on; from a page that isn't a project's, it opens Project.
  const here = PROJECT_PAGES.some((p) => p.tab === route.tab) ? route.tab : "projects";
  return (
    <SidebarSection title="Projects">
      <div role="group" aria-label="Project">
        <div className={s.navPick}>
          <ScopeSelect
            id="settings-project"
            className={s.navPicker}
            value={scope?.kind === "project" ? scope : null}
            projects={projects}
            onChange={(next) => go(formatRoute({ tab: here, for: scopeKey(next) }))}
          />
        </div>
        {PROJECT_PAGES.map((p) => (
          <div key={p.tab} className={s.navGroup}>
            <SidebarItem
              label={PAGE_LABEL[p.tab]}
              icon={p.icon}
              current={route.tab === p.tab && route.prompt === null}
              onClick={() => go(formatRoute({ tab: p.tab, for: project }))}
            />
            {p.tab === "prompts" && route.tab === "prompts" && scope !== null ? <PromptNav selected={route.prompt} scope={scope} onOpen={(id) => go(promptHref(id))} /> : null}
          </div>
        ))}
      </div>
    </SidebarSection>
  );
}

/**
 * The Hub group, for an owner or admin of the hub on screen: its pages, Every project's nested under it, and Setup
 * only while a required step is left (or while it is open), with how many.
 */
function HubGroup({ route }: { route: SettingsRoute }) {
  const { id } = useHub();
  const hubs = useHubs();
  const setup = useToolQuery("setup_list", noInput);
  const left = setup.data?.requiredLeft ?? 0;
  const open = (tab: HubTab, prompt?: string) => navigate({ id: "settings", tab, ...(prompt === undefined ? {} : { prompt }), at: id });
  const row = (tab: HubTab, icon: ReactNode, trailing?: ReactNode) => (
    <SidebarItem
      key={tab}
      label={PAGE_LABEL[tab]}
      icon={icon}
      current={route.tab === tab}
      trailing={trailing}
      onClick={() => open(tab)}
    />
  );
  return (
    <SidebarSection title="Hub" label="Hub">
      {hubs.length > 1 ? (
        <div role="group" aria-label="Hub to manage">
          {hubs.map((hub) => (
            <HubScope key={hub.id} hub={hub}>
              <HubChoice hub={hub} current={hub.id === id} onPick={() => navigate({ id: "settings", tab: isHubTab(route.tab) ? route.tab : "hub.people", at: hub.id })} />
            </HubScope>
          ))}
        </div>
      ) : null}
      {row("hub.people", <Users />)}
      {row("hub.machines", <Server />)}
      <div role="group" aria-label="Every project" className={s.navGroup}>
        <SidebarItem label="Every project" icon={<Layers />} current={false} onClick={() => open(isEveryProject(route.tab) ? route.tab : "hub.profiles")} />
        {EVERY_PROJECT.map((tab) => (
          <div key={tab} className={s.navGroup}>
            <SidebarItem indent label={PAGE_LABEL[tab]} current={route.tab === tab && route.prompt === null} onClick={() => open(tab)} />
            {tab === "hub.prompts" && route.tab === "hub.prompts" ? <PromptNav selected={route.prompt} scope={HUB} onOpen={(p) => open("hub.prompts", p)} /> : null}
          </div>
        ))}
      </div>
      {row("hub.accounts", <KeyRound />)}
      {left > 0 || route.tab === "hub.setup"
        ? row("hub.setup", <ListChecks />, left > 0 ? <Text size="xs" tone="warning">{`${String(left)} left`}</Text> : undefined)
        : null}
    </SidebarSection>
  );
}

function badge(summary: PromptSummary, scope: Scope): { label: string; update?: true } | null {
  if (summary.stale) return { label: "update", update: true };
  if (summary.scope === "project") return { label: "edited" };
  if (summary.scope === "global") return { label: scope.kind === "project" ? "hub-wide edit" : "edited" };
  return null;
}

/**
 * The prompts under a project's Prompts (and under Every project's, hub-wide), grouped, each with its edited or
 * update mark for the scope on screen.
 */
export function PromptNav({ selected, scope, onOpen }: { selected: string | null; scope: Scope; onOpen: (id: string) => void }) {
  const live = useLive();
  const projectRef = projectRefOf(scope);
  // The same read as the page's list: one query, shared.
  const list = useToolQuery("prompt_get", projectRef ? { projectRef } : {}, { enabled: live });
  if (!live) return null;
  if (list.data === undefined) {
    return (
      <div className={s.navNested}>
        {!list.isError ? (
          <Text size="xs" tone="quiet">
            Loading prompts…
          </Text>
        ) : (
          <>
            <Text size="xs" tone="danger">
              {errorText(list.error)}
            </Text>
            <SidebarItem label="Try again" indent onClick={() => void list.refetch()} />
          </>
        )}
      </div>
    );
  }
  return (
    <div role="group" aria-label="Prompts">
      {sections(list.data.prompts ?? []).map(({ group, rows }) => (
        <div key={group.key}>
          <div className={s.navNested}>
            <Text size="xs" tone="quiet">
              {group.title}
            </Text>
          </div>
          {rows.map((row) => {
            const b = badge(row.summary, scope);
            return (
              <SidebarItem
                key={row.summary.id}
                indent
                label={row.name}
                current={row.summary.id === selected}
                trailing={b ? <Text size="xs" tone={b.update ? "warning" : "quiet"}>{b.label}</Text> : undefined}
                onClick={() => onOpen(row.summary.id)}
              />
            );
          })}
        </div>
      ))}
    </div>
  );
}

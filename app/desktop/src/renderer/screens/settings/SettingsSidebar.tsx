// Settings in the sidebar's place: Back to where you were, a search field that narrows to an option by name, the
// pages, and (on Prompts) the prompts themselves, so the editor has the rest of the window.
import { ArrowLeft, Bell, Bot, Brain, FolderGit2, GitBranch, MessageSquareText, Network, Repeat, ScrollText, SlidersHorizontal, Sparkles, Users } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Input, Sidebar, SidebarItem, SidebarSection, Text } from "../../ui";
import { sections } from "./catalog";
import type { PromptSummary } from "./contracts";
import { parseScope, projectRefOf, type Scope } from "./editor";
import { useToolQuery } from "../../src/data/react";
import { errorText, useLive } from "./hub";
import { promptHref, tabHref, useSettingsRoute, type Tab } from "./route";
import { openOption, PAGE_LABEL, searchSettings } from "./search";
import s from "./settings.module.css";

const PAGES: ReadonlyArray<{ tab: Tab; icon: ReactNode }> = [
  { tab: "general", icon: <SlidersHorizontal /> },
  { tab: "hubs", icon: <Network /> },
  { tab: "claude", icon: <Bot /> },
  { tab: "github", icon: <GitBranch /> },
  { tab: "notifications", icon: <Bell /> },
  { tab: "agents", icon: <Users /> },
  { tab: "projects", icon: <FolderGit2 /> },
  { tab: "instructions", icon: <ScrollText /> },
  { tab: "memory", icon: <Brain /> },
  { tab: "skills", icon: <Sparkles /> },
  { tab: "prompts", icon: <MessageSquareText /> },
  { tab: "automations", icon: <Repeat /> },
];

const go = (hash: string) => {
  window.location.hash = hash;
};

export function SettingsSidebar({ onBack }: { onBack: () => void }) {
  const route = useSettingsRoute();
  const [query, setQuery] = useState("");
  const results = searchSettings(query);
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
                trailing={o.key === o.tab ? undefined : <Text size="xs" tone="quiet">{PAGE_LABEL[o.tab]}</Text>}
                onClick={() => {
                  openOption(o);
                  setQuery("");
                }}
              />
            ))
          )}
        </SidebarSection>
      ) : (
        <SidebarSection title="Settings">
          {PAGES.map((p) => (
            <div key={p.tab} className={s.navGroup}>
              <SidebarItem label={PAGE_LABEL[p.tab]} icon={p.icon} current={route.tab === p.tab && route.prompt === null} onClick={() => go(tabHref(p.tab))} />
              {p.tab === "prompts" && route.tab === "prompts" ? <PromptNav selected={route.prompt} scope={parseScope(route.for)} onOpen={(id) => go(promptHref(id))} /> : null}
            </div>
          ))}
        </SidebarSection>
      )}
    </Sidebar>
  );
}

function badge(summary: PromptSummary, scope: Scope): { label: string; update?: true } | null {
  if (summary.stale) return { label: "update", update: true };
  if (summary.scope === "project") return { label: "edited" };
  if (summary.scope === "global") return { label: scope.kind === "project" ? "hub-wide edit" : "edited" };
  return null;
}

/**
 * The prompts under Prompts (and under Administration's Hub settings, hub-wide), grouped, each with its edited or
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

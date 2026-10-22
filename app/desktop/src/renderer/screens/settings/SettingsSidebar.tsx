// Settings in the sidebar's place: Back to where you were, a search field that narrows to an option by name, the
// pages, and (on Prompts) the prompts themselves, so the editor has the rest of the window.
import { ArrowLeft, MessageSquareText, ScrollText, SlidersHorizontal, Users } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Input, Sidebar, SidebarItem, SidebarSection, Text } from "../../ui";
import { sections } from "./catalog";
import type { PromptSummary } from "./contracts";
import { parseScope, projectRefOf, type Scope } from "./editor";
import { useLive, useRead } from "./hub";
import { parseRoute, promptHref, tabHref, useHash, type Tab } from "./route";
import { openOption, PAGE_LABEL, searchSettings } from "./search";
import s from "./settings.module.css";

const PAGES: ReadonlyArray<{ tab: Tab; icon: ReactNode }> = [
  { tab: "general", icon: <SlidersHorizontal /> },
  { tab: "agents", icon: <Users /> },
  { tab: "instructions", icon: <ScrollText /> },
  { tab: "prompts", icon: <MessageSquareText /> },
];

const go = (hash: string) => {
  window.location.hash = hash;
};

export function SettingsSidebar({ onBack }: { onBack: () => void }) {
  const route = parseRoute(useHash());
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
              {p.tab === "prompts" && route.tab === "prompts" ? <PromptNav selected={route.prompt} scope={parseScope(route.for)} /> : null}
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

/** The prompts under Prompts, grouped, each with its edited or update mark for the scope on screen. */
function PromptNav({ selected, scope }: { selected: string | null; scope: Scope }) {
  const live = useLive();
  const projectRef = projectRefOf(scope);
  // The same read as the page's list: one query, shared.
  const [list, retry] = useRead("prompts_list", projectRef ? { projectRef } : {}, live);
  if (!live) return null;
  if (list.state !== "ready") {
    return (
      <div className={s.navNested}>
        {list.state === "loading" ? (
          <Text size="xs" tone="quiet">
            Loading prompts…
          </Text>
        ) : (
          <>
            <Text size="xs" tone="danger">
              {list.message}
            </Text>
            <SidebarItem label="Try again" indent onClick={retry} />
          </>
        )}
      </div>
    );
  }
  return (
    <div role="group" aria-label="Prompts">
      {sections(list.value.prompts).map(({ group, rows }) => (
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
                onClick={() => go(promptHref(row.summary.id))}
              />
            );
          })}
        </div>
      ))}
    </div>
  );
}

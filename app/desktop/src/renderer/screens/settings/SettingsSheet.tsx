// Settings (⌘, or the app menu) is one sheet over the app (D211): the chat and its sidebar stay where they were under
// it, and closing it (its ×, Esc) returns to them. In the sheet, a short index of pages in three groups and the page
// beside it. You: General, Accounts, Vault, Memory, Hubs & devices. Bots: the list of bots, each opening its pages under
// tabs (Frames.tsx). Hub, for the hub's owners and admins only: People, Machines, Every bot and Setup, which says how
// many required steps are left. Vault shows only on a hub that serves it. A search at the index's head narrows to an
// option by name. A page that became a part of another (route.ts) has no entry: its links open the page that holds it.
import { Search, X } from "lucide-react";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { Button, cx } from "../../ui";
import { useData, useHub, useToolQuery } from "../../src/data/react";
import { useServes, useSettledAdministers } from "../admin/role";
import { navigate } from "../shell/navigation";
import type { HubTab } from "../shell/routes";
import { parseScope } from "./editor";
import { scopeName, useProjects } from "./parts";
import { formatRoute, isEveryProject, isProjectTab, pageOf, projectFor, tabHref, useSettingsRoute, type Tab } from "./route";
import { openOption, optionsFor, pagePath, searchSettings } from "./search";
import { SettingsScreen } from "./SettingsScreen";
import { vaultServed } from "./vaultModel";
import n from "./sheet.module.css";

/** You's pages, by their short names in the index. */
const YOU: ReadonlyArray<{ tab: Tab; label: string }> = [
  { tab: "general", label: "General" },
  { tab: "accounts", label: "Accounts" },
  { tab: "vault", label: "Vault" },
  { tab: "your-memory", label: "Memory" },
  { tab: "hubs", label: "Hubs & devices" },
];

/** The Hub group's pages; Every bot opens on its first tab. */
const HUB_PAGES: ReadonlyArray<{ tab: HubTab; label: string }> = [
  { tab: "hub.people", label: "People" },
  { tab: "hub.machines", label: "Machines" },
  { tab: "hub.profiles", label: "Every bot" },
  { tab: "hub.setup", label: "Setup" },
];

const noInput = {};

/** The index's layout, while two are compared (W694): an index beside the page, or groups and pages as tabs over it. */
type Layout = "index" | "tabs" | "frame";
const layoutNow = (): Layout => {
  try {
    const l = window.localStorage.getItem("fleetd.settingsLayout");
    return l === "tabs" || l === "frame" ? l : "index";
  } catch {
    return "index";
  }
};

export function SettingsSheet({ onClose }: { onClose: () => void }) {
  const sheet = useRef<HTMLDivElement>(null);
  const [layout] = useState(layoutNow);
  // Esc closes the sheet, unless something in it took the key first (a menu, a dialog, a search with words in it).
  useEffect(() => {
    const on = (e: globalThis.KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      if (document.querySelector('[role="dialog"][data-state="open"], [role="menu"], [role="listbox"]')) return;
      onClose();
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, [onClose]);
  // Focus goes into the sheet, on the sheet itself, so the first Tab reaches the search and nothing shows a ring.
  useEffect(() => {
    sheet.current?.focus({ preventScroll: true });
  }, []);
  return (
    <div className={n.scrim} data-screen="settings.sheet" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={sheet} className={n.sheet} role="dialog" aria-modal="true" aria-label="Settings" data-layout={layout} tabIndex={-1}>
        {layout === "tabs" ? <ScopeTabs /> : <Index />}
        <div className={n.page}>
          <SettingsScreen />
        </div>
        <Button variant="ghost" iconOnly aria-label="Close settings" title="Close (Esc)" className={n.close} onClick={onClose}>
          <X aria-hidden />
        </Button>
      </div>
    </div>
  );
}

/** Where each entry goes, and whether it is the page on show. */
function useEntries() {
  const route = useSettingsRoute();
  const administers = useSettledAdministers();
  const vault = useData((st) => vaultServed(st.features));
  const { id } = useHub();
  const steps = useServes("setup_list");
  const setup = useToolQuery("setup_list", noInput, { enabled: steps && administers });
  const left = steps ? (setup.data?.requiredLeft ?? 0) : 0;
  const on = pageOf(route.tab);
  const you = YOU.filter((p) => vault || p.tab !== "vault").map((p) => ({
    key: p.tab,
    label: p.label,
    current: on === p.tab,
    go: () => (window.location.hash = tabHref(p.tab)),
  }));
  // A bot's pages show it under Bots, by name, as the page on show; Bots is then its way back to the list.
  const projects = useProjects();
  const botKey = isProjectTab(route.tab) && !(route.tab === "projects" && route.for === null) ? projectFor(route, projects) : null;
  const bots = { key: "projects", label: "Bots", current: isProjectTab(route.tab) && botKey === null, go: () => (window.location.hash = formatRoute({ tab: "projects" })) };
  const bot = botKey === null ? null : { key: botKey, label: scopeName(parseScope(botKey), projects), current: true, go: () => undefined };
  const hub = administers
    ? HUB_PAGES.map((p) => ({
        key: p.tab,
        label: p.label,
        current: p.tab === "hub.profiles" ? isEveryProject(on) : on === p.tab,
        badge: p.tab === "hub.setup" && left > 0 ? `${String(left)} left` : undefined,
        go: () => navigate({ id: "settings", tab: p.tab, at: id }),
      }))
    : null;
  return { you, bots, bot, hub, administers, vault };
}

type Entry = { key: string; label: string; current: boolean; badge?: string | undefined; go: () => void };

function Item({ entry }: { entry: Entry }) {
  return (
    <button type="button" className={n.item} aria-current={entry.current ? "page" : undefined} onClick={entry.go}>
      <span className={n.itemLabel}>{entry.label}</span>
      {entry.badge === undefined ? null : <span className={n.badge}>{entry.badge}</span>}
    </button>
  );
}

/** Layout "index": the sheet's own short list of pages, beside the page, a search at its head. */
function Index() {
  const { you, bots, bot, hub, administers, vault } = useEntries();
  const [query, setQuery] = useState("");
  const searching = query.trim() !== "";
  const results = searchSettings(query, optionsFor(administers, vault));
  return (
    <nav className={n.index} aria-label="Settings">
      <div className={n.indexHead}>
        <span className={n.indexTitle}>Settings</span>
      </div>
      <SearchField query={query} setQuery={setQuery} first={results[0]} />
      {searching ? (
        <div className={n.group} role="list" aria-label="Results">
          {results.length === 0 ? (
            <p className={n.none}>No setting is called that.</p>
          ) : (
            results.map((o) => (
              <button
                key={o.key}
                type="button"
                data-result
                className={cx(n.item, n.result)}
                onClick={() => {
                  openOption(o);
                  setQuery("");
                }}
              >
                <span className={n.itemLabel}>{o.label}</span>
                {o.key === o.tab ? null : <span className={n.where}>{pagePath(o.tab)}</span>}
              </button>
            ))
          )}
        </div>
      ) : (
        <>
          <div className={n.group}>
            {you.map((e) => (
              <Item key={e.key} entry={e} />
            ))}
          </div>
          <div className={n.group}>
            <Item entry={bots} />
            {bot === null ? null : (
              <div className={n.sub}>
                <Item entry={bot} />
              </div>
            )}
          </div>
          {hub === null ? null : (
            <div className={n.group} role="group" aria-labelledby="settings-hub-group">
              <span id="settings-hub-group" className={n.groupLabel}>
                Hub
              </span>
              {hub.map((e) => (
                <Item key={e.key} entry={e} />
              ))}
            </div>
          )}
        </>
      )}
    </nav>
  );
}

function SearchField({ query, setQuery, first }: { query: string; setQuery: (q: string) => void; first: ReturnType<typeof searchSettings>[number] | undefined }) {
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" && first) {
      openOption(first);
      setQuery("");
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      e.currentTarget.closest("nav")?.querySelector<HTMLElement>("[data-result]")?.focus();
    } else if (e.key === "Escape" && query !== "") {
      e.preventDefault();
      setQuery("");
    }
  };
  return (
    <label className={n.search}>
      <Search aria-hidden className={n.searchGlyph} />
      <input type="search" aria-label="Search settings" placeholder="Search" value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={onKey} />
    </label>
  );
}

/** Layout "tabs": the three groups as a switch at the sheet's head, the group's pages as tabs under it. */
function ScopeTabs() {
  const { you, bots, hub, administers, vault } = useEntries();
  const scope = hub?.some((e) => e.current) ? "hub" : bots.current ? "bots" : "you";
  const pages = scope === "hub" ? (hub ?? []) : scope === "you" ? you : [];
  const [query, setQuery] = useState("");
  const results = searchSettings(query, optionsFor(administers, vault));
  return (
    <nav className={n.scopes} aria-label="Settings">
      <div className={n.scopeRow}>
        <div className={n.scopeSwitch} role="group" aria-label="Group">
          <button type="button" aria-pressed={scope === "you"} onClick={() => you[0]?.go()}>
            You
          </button>
          <button type="button" aria-pressed={scope === "bots"} onClick={bots.go}>
            Bots
          </button>
          {hub === null ? null : (
            <button type="button" aria-pressed={scope === "hub"} onClick={() => hub[0]?.go()}>
              Hub
            </button>
          )}
        </div>
        <div className={n.scopeSearch}>
          <SearchField query={query} setQuery={setQuery} first={results[0]} />
          {query.trim() === "" ? null : (
            <div className={n.popResults} role="list" aria-label="Results">
              {results.length === 0 ? (
                <p className={n.none}>No setting is called that.</p>
              ) : (
                results.slice(0, 8).map((o) => (
                  <button
                    key={o.key}
                    type="button"
                    data-result
                    className={cx(n.item, n.result)}
                    onClick={() => {
                      openOption(o);
                      setQuery("");
                    }}
                  >
                    <span className={n.itemLabel}>{o.label}</span>
                    {o.key === o.tab ? null : <span className={n.where}>{pagePath(o.tab)}</span>}
                  </button>
                ))
              )}
            </div>
          )}
        </div>
      </div>
      {pages.length === 0 ? null : (
        <div className={n.pageRow}>
          {pages.map((e) => (
            <Item key={e.key} entry={e} />
          ))}
        </div>
      )}
    </nav>
  );
}

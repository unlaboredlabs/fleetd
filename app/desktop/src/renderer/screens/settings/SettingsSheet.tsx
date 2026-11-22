// Settings (⌘, or the app menu) is one sheet over the app (D211): the chat and its sidebar stay where they were under
// it, and closing it (its ×, Esc) returns to them. In the sheet, an index of pages on a quiet surface of its own, and
// the page beside it: its head in the sheet's header zone, on the index title's line, the page scrolling under it.
// The index is three groups, each under its label. You: General, Accounts, Vault, Memory, Hubs & devices. Bots: All
// bots, then each bot by its picture and name, opening its pages under tabs (Frames.tsx). Hub, for the hub's owners
// and admins only: People, Machines, Billing (a fleetd cloud team's, once fleetd's computers are on for it), Every bot and Setup, which says how many required steps are left. Vault shows
// only on a hub that serves it. A search at the index's head narrows to an option by name. A page that became a part
// of another (route.ts) has no entry: its links open the page that holds it.
import {
  Brain,
  CreditCard,
  Layers,
  LayoutGrid,
  ListChecks,
  LockKeyhole,
  MonitorSmartphone,
  Search,
  Server,
  SlidersHorizontal,
  UserRound,
  Users,
  X,
} from "lucide-react";
import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { Button, cx, underModal } from "../../ui";
import type { HubView } from "../../src/data/hubs";
import { HubScope, useData, useHub, useToolQuery } from "../../src/data/react";
import { useBillingShown } from "../admin/Billing";
import { HUB_PAGES as HUB_PAGES_SHOWN, YOU_PAGES } from "../../../shared/settingsPages";
import { useServes, useSettledAdministers } from "../admin/role";
import { ProjectAvatar } from "../projects/ProjectAvatar";
import { isArchived } from "../projects/model";
import { navigate } from "../shell/navigation";
import type { HubTab } from "../shell/routes";
import { HeadSlot, useProjects } from "./parts";
import {
  formatRoute,
  isEveryProject,
  isProjectTab,
  pageOf,
  projectFor,
  tabHref,
  useSettingsRoute,
  type Tab,
} from "./route";
import { openOption, optionsFor, pagePath, searchSettings } from "./search";
import { SettingsScreen } from "./SettingsScreen";
import { vaultServed } from "./vaultModel";
import n from "./sheet.module.css";

/** You's pages, by their short names in the index. */
const YOU: ReadonlyArray<{ tab: Tab; label: string; icon: ReactNode }> = [
  { tab: "general", label: YOU_PAGES.general, icon: <SlidersHorizontal /> },
  { tab: "accounts", label: YOU_PAGES.accounts, icon: <UserRound /> },
  { tab: "vault", label: YOU_PAGES.vault, icon: <LockKeyhole /> },
  { tab: "your-memory", label: YOU_PAGES.memory, icon: <Brain /> },
  { tab: "hubs", label: YOU_PAGES.hubs, icon: <MonitorSmartphone /> },
];

/** The Hub group's pages; Every bot opens on its first tab. */
const HUB_PAGES: ReadonlyArray<{
  tab: HubTab;
  label: string;
  icon: ReactNode;
}> = [
  { tab: "hub.people", label: HUB_PAGES_SHOWN.people, icon: <Users /> },
  { tab: "hub.machines", label: HUB_PAGES_SHOWN.machines, icon: <Server /> },
  { tab: "hub.billing", label: HUB_PAGES_SHOWN.billing, icon: <CreditCard /> },
  { tab: "hub.profiles", label: HUB_PAGES_SHOWN.everyBot, icon: <Layers /> },
  { tab: "hub.setup", label: HUB_PAGES_SHOWN.setup, icon: <ListChecks /> },
];

/** The bots the index lists by name; past them, All bots has the rest. */
const BOTS_SHOWN = 8;

const noInput = {};

/**
 * The sheet over the app, on `hub` (absent, the hub in scope): the hub its route names, which may be another than the
 * app's under it. A switch of hub (a Hub page's Managing) keeps the sheet on screen, its head and the page's frame with
 * it: only its index and page start afresh, in the other hub's scope, a query keeping the client it was made with.
 */
export function SettingsSheet({ hub: on, onClose }: { hub?: HubView; onClose: () => void }) {
  const here = useHub();
  const hub = on ?? here;
  const sheet = useRef<HTMLDivElement>(null);
  const [head, setHead] = useState<HTMLDivElement | null>(null);
  // Esc closes the sheet, unless something in it took the key first (a menu, a dialog, a search with words in it).
  useEffect(() => {
    const on = (e: globalThis.KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      if (
        document.querySelector(
          '[role="dialog"][data-state="open"], [role="menu"], [role="listbox"]',
        )
      )
        return;
      onClose();
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, [onClose]);
  // A page's bar shows while it scrolls, and fades a moment after.
  useEffect(() => {
    const el = sheet.current;
    if (el === null) return;
    const timers = new Map<Element, ReturnType<typeof setTimeout>>();
    const on = (e: Event) => {
      if (!(e.target instanceof HTMLElement)) return;
      const target = e.target;
      target.setAttribute("data-scrolling", "");
      clearTimeout(timers.get(target));
      timers.set(
        target,
        setTimeout(() => target.removeAttribute("data-scrolling"), 900),
      );
    };
    el.addEventListener("scroll", on, true);
    return () => {
      el.removeEventListener("scroll", on, true);
      timers.forEach((t) => clearTimeout(t));
    };
  }, []);
  // A modal: the app under it (what comes before the scrim) is out of reach and blurred until the sheet closes.
  useEffect(() => underModal(sheet.current?.parentElement ?? null), []);
  // Focus goes into the sheet, on the sheet itself, so the first Tab reaches the search and nothing shows a ring.
  useEffect(() => {
    sheet.current?.focus({ preventScroll: true });
  }, []);
  return (
    <div
      className={n.scrim}
      data-sheet="settings"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        ref={sheet}
        className={n.sheet}
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        tabIndex={-1}
      >
        <HubScope key={hub.id} hub={hub}>
          <Index />
        </HubScope>
        <div className={n.page}>
          <div className={n.head}>
            <div ref={setHead} className={n.headSlot} />
            <Button
              variant="ghost"
              iconOnly
              aria-label="Close settings"
              title="Close (Esc)"
              className={n.close}
              onClick={onClose}
            >
              <X aria-hidden />
            </Button>
          </div>
          <HubScope key={hub.id} hub={hub}>
            <HeadSlot.Provider value={head}>
              <SettingsScreen />
            </HeadSlot.Provider>
          </HubScope>
        </div>
      </div>
    </div>
  );
}

type Entry = {
  key: string;
  label: string;
  icon: ReactNode;
  current: boolean;
  badge?: string | undefined;
  go: () => void;
};

/** Where each entry goes, and whether it is the page on show. */
function useEntries() {
  const route = useSettingsRoute();
  const administers = useSettledAdministers();
  const vault = useData((st) => vaultServed(st.features));
  const { id } = useHub();
  // Billing is a fleetd cloud team's alone, once fleetd's computers are on for it: a self-hosted hub, or a team with
  // nothing to buy yet, has no such page, not even a row that says so.
  const billing = useBillingShown(administers);
  const steps = useServes("setup_list");
  const setup = useToolQuery("setup_list", noInput, {
    enabled: steps && administers,
  });
  const left = steps ? (setup.data?.requiredLeft ?? 0) : 0;
  const projects = useProjects();
  const on = pageOf(route.tab);
  const you: Entry[] = YOU.filter((p) => vault || p.tab !== "vault").map(
    (p) => ({
      key: p.tab,
      label: p.label,
      icon: p.icon,
      current: on === p.tab,
      go: () => (window.location.hash = tabHref(p.tab)),
    }),
  );
  // A bot's pages light its own row; the list of them lights All bots.
  const list = route.tab === "projects" && route.for === null;
  const open =
    isProjectTab(route.tab) && !list ? projectFor(route, projects) : null;
  const active = (projects ?? []).filter((p) => !isArchived(p));
  const bots: Entry[] = [
    {
      key: "projects",
      label: "All bots",
      icon: <LayoutGrid />,
      current: list,
      go: () => (window.location.hash = formatRoute({ tab: "projects" })),
    },
    ...active.slice(0, BOTS_SHOWN).map((p) => {
      const key = `${p.machineId}/${p.projectId}`;
      return {
        key,
        label: p.title,
        icon: <ProjectAvatar project={p} size={18} />,
        current: open === key,
        go: () =>
          (window.location.hash = formatRoute({ tab: "projects", for: key })),
      };
    }),
  ];
  const hub: Entry[] | null = administers
    ? HUB_PAGES.filter((p) => billing || p.tab !== "hub.billing").map((p) => ({
        key: p.tab,
        label: p.label,
        icon: p.icon,
        current: p.tab === "hub.profiles" ? isEveryProject(on) : on === p.tab,
        badge:
          p.tab === "hub.setup" && left > 0
            ? `${String(left)} left`
            : undefined,
        go: () => navigate({ id: "settings", tab: p.tab, at: id }),
      }))
    : null;
  return { you, bots, hub, administers, vault, billing };
}

function Item({ entry }: { entry: Entry }) {
  return (
    <button
      type="button"
      className={n.item}
      aria-current={entry.current ? "page" : undefined}
      onClick={entry.go}
    >
      <span className={n.itemIcon} aria-hidden>
        {entry.icon}
      </span>
      <span className={n.itemLabel}>{entry.label}</span>
      {entry.badge === undefined ? null : (
        <span className={n.badge}>{entry.badge}</span>
      )}
    </button>
  );
}

function Group({
  id,
  label,
  entries,
}: {
  id: string;
  label: string;
  entries: ReadonlyArray<Entry>;
}) {
  return (
    <div className={n.group} role="group" aria-labelledby={id}>
      <span id={id} className={n.groupLabel}>
        {label}
      </span>
      {entries.map((e) => (
        <Item key={e.key} entry={e} />
      ))}
    </div>
  );
}

/** The sheet's index: its title on the page title's line, a search, then the three groups. */
function Index() {
  const { you, bots, hub, administers, vault, billing } = useEntries();
  // A fleetd cloud team is a team to the person, never a hub.
  const cloud = useHub().cloud === true;
  const [query, setQuery] = useState("");
  const searching = query.trim() !== "";
  const results = searchSettings(query, optionsFor(administers, vault, billing));
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
                {o.key === o.tab ? null : (
                  <span className={n.where}>{pagePath(o.tab)}</span>
                )}
              </button>
            ))
          )}
        </div>
      ) : (
        <>
          <Group id="settings-you" label="You" entries={you} />
          <Group id="settings-bots" label="Bots" entries={bots} />
          {hub === null ? null : (
            <Group id="settings-hub" label={cloud ? "Team" : "Hub"} entries={hub} />
          )}
        </>
      )}
    </nav>
  );
}

function SearchField({
  query,
  setQuery,
  first,
}: {
  query: string;
  setQuery: (q: string) => void;
  first: ReturnType<typeof searchSettings>[number] | undefined;
}) {
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" && first) {
      openOption(first);
      setQuery("");
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      e.currentTarget
        .closest("nav")
        ?.querySelector<HTMLElement>("[data-result]")
        ?.focus();
    } else if (e.key === "Escape" && query !== "") {
      e.preventDefault();
      setQuery("");
    }
  };
  return (
    <label className={n.search}>
      <Search aria-hidden className={n.searchGlyph} />
      <input
        type="search"
        aria-label="Search settings"
        placeholder="Search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={onKey}
      />
    </label>
  );
}

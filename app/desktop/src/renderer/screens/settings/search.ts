// Settings search: every page and option by its own name, plus the words people use for it ("dark", "theme"), so
// typing in the sidebar's field narrows to the option and opening one lands on it. Matching is pure and tested; the
// reveal is a one-shot "focus this option" that the page showing it takes up when it renders.
import { useEffect, useRef, useSyncExternalStore } from "react";
import { ENTRIES } from "./catalog";
import { promptHref, tabHref, type Tab } from "./route";

export interface SettingsOption {
  /** Unique; also the reveal key the page's option registers with useReveal. */
  readonly key: string;
  readonly label: string;
  readonly tab: Tab;
  readonly keywords?: ReadonlyArray<string>;
  /** A prompt opens in the editor rather than being revealed on a page. */
  readonly prompt?: string;
}

export const PAGE_LABEL: Readonly<Record<Tab, string>> = {
  general: "General",
  notifications: "Notifications",
  agents: "Agents",
  machines: "Machines",
  projects: "Projects",
  mcp: "MCP servers",
  prompts: "Prompts",
  instructions: "Instructions",
  memory: "Memory",
  automations: "Automations",
  skills: "Skills",
};

/** "Dock" is the Mac's word for it. (No window in the unit tests.) */
export const BADGE = typeof window !== "undefined" && window.fleetd.platform === "darwin" ? "Dock badge" : "App icon badge";

const page = (tab: Tab, keywords: ReadonlyArray<string>): SettingsOption => ({ key: tab, label: PAGE_LABEL[tab], tab, keywords });

export const OPTIONS: ReadonlyArray<SettingsOption> = [
  page("general", ["preferences"]),
  { key: "general.appearance", label: "Appearance", tab: "general", keywords: ["theme", "dark", "light", "mode", "match system"] },
  { key: "general.presence", label: "Time in the app", tab: "general", keywords: ["presence", "focus", "activity", "privacy", "minutes", "tracking"] },
  { key: "general.hub", label: "Hub", tab: "general", keywords: ["pair", "connection", "disconnect", "key", "server"] },
  page("notifications", ["alerts", "mute"]),
  { key: "notifications.kinds", label: "Notify me when", tab: "notifications", keywords: ["notifications", "alerts", "mute", "finished", "done"] },
  { key: "notifications.sound", label: "Sound", tab: "notifications", keywords: ["notifications", "mute", "silent"] },
  { key: "notifications.badge", label: BADGE, tab: "notifications", keywords: ["badge", "dock", "count", "app icon"] },
  { key: "notifications.test", label: "Test notification", tab: "notifications", keywords: ["notifications", "alerts", "try"] },
  page("agents", ["limit", "at once", "parallel"]),
  { key: "agents.project", label: "Max agents per project", tab: "agents", keywords: ["limit", "at once", "parallel", "concurrency"] },
  { key: "agents.machines", label: "Machines", tab: "agents", keywords: ["max agents", "machine cap", "memory", "auto", "admin"] },
  { key: "agents.fleet", label: "Whole fleet", tab: "agents", keywords: ["max agents", "fleet limit", "fleet cap", "admin"] },
  { key: "agents.profiles", label: "Task profiles", tab: "agents", keywords: ["profile", "medium", "high", "effort", "model", "opus", "sonnet"] },
  page("machines", ["roles", "screens", "sessions", "browser", "device", "simulator", "emulator", "hosts"]),
  { key: "machines.roles", label: "Machine roles", tab: "machines", keywords: ["agents", "screens", "sessions", "browser", "android", "ios", "simulator", "emulator", "desktop", "chrome", "xcode", "kvm", "screen cap", "session cap"] },
  page("projects", ["project settings", "repo", "repository"]),
  { key: "projects.name", label: "Project name", tab: "projects", keywords: ["rename", "title"] },
  { key: "projects.repos", label: "Repos", tab: "projects", keywords: ["repo", "repository", "remote", "base branch", "checkout", "preview", "folder"] },
  { key: "projects.worktrees", label: "Worktrees", tab: "projects", keywords: ["worktree", "cleanup", "keep", "base branch", "branch", "disk"] },
  { key: "projects.memory", label: "Nightly memory refresh", tab: "projects", keywords: ["refresh", "nightly", "dreaming", "tidy"] },
  { key: "projects.env", label: "Environment variables", tab: "projects", keywords: ["env", ".env", "secrets", "api key", "token", "variables"] },
  { key: "projects.mcp", label: "Project MCP servers", tab: "projects", keywords: ["mcp", "tools", "servers", "connections"] },
  { key: "projects.setup", label: "Setup commands", tab: "projects", keywords: ["setup", "install", "dependencies", "codegen", "worktree", "lockfile", "pnpm"] },
  { key: "projects.train", label: "Merge train", tab: "projects", keywords: ["merge", "train", "checks", "ci", "required", "fast", "after merge"] },
  { key: "projects.profiles", label: "Task profiles", tab: "projects", keywords: ["profile", "medium", "high", "effort", "model", "override"] },
  { key: "projects.delete", label: "Delete project", tab: "projects", keywords: ["remove", "delete", "forget"] },
  page("mcp", ["mcp", "tools", "servers", "connections", "integrations"]),
  { key: "mcp.servers", label: "Global MCP servers", tab: "mcp", keywords: ["mcp", "stdio", "http", "sse", "headers", "token", "test connection"] },
  { key: "mcp.user", label: "Your own MCP servers", tab: "mcp", keywords: ["mcp", "claude.json", ".mcp.json", "strict"] },
  page("instructions", ["custom instructions", "rules", "my text"]),
  page("memory", ["remember", "remembered", "user.md", "MEMORY.md", "forget", "preferences", "rules"]),
  page("automations", ["schedule", "cron", "webhook", "recurring", "run now", "trigger"]),
  page("skills", ["skill", "SKILL.md", "skills.sh", "workflow", "install", ".agents", ".claude"]),
  page("prompts", ["templates", "system prompt"]),
  ...Object.entries(ENTRIES).map(([id, e]) => ({ key: `prompt:${id}`, label: e.name, tab: "prompts" as const, keywords: ["prompt", id], prompt: id })),
];

const words = (q: string) => q.toLowerCase().split(/\s+/u).filter(Boolean);

/**
 * The options every typed word appears in (in the name or a keyword), names that start with the query first, then
 * names that contain it, then keyword matches; otherwise in the order above, which follows the pages.
 */
export function searchSettings(query: string, options: ReadonlyArray<SettingsOption> = OPTIONS): SettingsOption[] {
  const ws = words(query);
  if (ws.length === 0) return [];
  const q = ws.join(" ");
  const rank = (o: SettingsOption): number | null => {
    const label = o.label.toLowerCase();
    const all = [label, ...(o.keywords ?? []).map((k) => k.toLowerCase())].join(" ");
    if (!ws.every((w) => all.includes(w))) return null;
    if (label.startsWith(q)) return 0;
    return ws.every((w) => label.includes(w)) ? 1 : 2;
  };
  return options
    .map((o, ix) => ({ o, ix, r: rank(o) }))
    .filter((x): x is { o: SettingsOption; ix: number; r: number } => x.r !== null)
    .sort((a, b) => a.r - b.r || a.ix - b.ix)
    .map((x) => x.o);
}

/** A prompt opens in the project the Prompts page was last showing: dropping it would make Save write hub-wide. */
export const optionHref = (o: SettingsOption): string => (o.prompt !== undefined ? promptHref(o.prompt) : tabHref(o.tab));

// The option to reveal once its page shows it.
let wanted: string | null = null;
const listeners = new Set<() => void>();
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

/** Opens an option: its page (or prompt), then focus on the option itself. */
export function openOption(o: SettingsOption) {
  wanted = o.prompt === undefined && o.key !== o.tab ? o.key : null;
  for (const l of listeners) l();
  window.location.hash = optionHref(o);
}

const FOCUSABLE = 'input, textarea, button:not([disabled]), [role="slider"]';

/** Marks an option's element: when a search opens this option, it scrolls into view and its first control takes focus. */
export function useReveal<T extends HTMLElement>(key: string) {
  const ref = useRef<T>(null);
  const want = useSyncExternalStore(subscribe, () => wanted);
  useEffect(() => {
    const el = ref.current;
    if (want !== key || el === null) return;
    wanted = null;
    el.scrollIntoView({ block: "nearest" });
    (el.querySelector<HTMLElement>(FOCUSABLE) ?? el).focus({ preventScroll: true });
  }, [want, key]);
  return ref;
}

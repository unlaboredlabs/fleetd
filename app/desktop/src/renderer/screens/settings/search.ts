// Settings search: every page and option by its own name, plus the words people use for it ("dark", "theme"), so
// typing in the sidebar's field narrows to the option and opening one lands on it. Matching is pure and tested; the
// reveal is a one-shot "focus this option" that the page showing it takes up when it renders.
import { useEffect, useRef, useSyncExternalStore } from "react";
import { ENTRIES } from "./catalog";
import { isHubTab, promptHref, tabHref, type Tab } from "./route";

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
  accounts: "Your accounts",
  "your-memory": "Your memory",
  devices: "Your devices",
  hubs: "Hubs",
  projects: "Project",
  agents: "Agents",
  instructions: "Instructions & memory",
  automations: "Automations",
  prompts: "Prompts",
  "hub.people": "People",
  "hub.machines": "Machines",
  "hub.profiles": "Profiles",
  "hub.tools": "Tools & skills",
  "hub.instructions": "Instructions & memory",
  "hub.prompts": "Prompts",
  "hub.accounts": "Hub accounts",
  "hub.setup": "Setup",
};

/** Where a search result is, beside its name: the page, and for a Hub page its group, as the sidebar nests them. */
export const pagePath = (tab: Tab): string =>
  !isHubTab(tab) ? PAGE_LABEL[tab] : tab === "hub.profiles" || tab === "hub.tools" || tab === "hub.instructions" || tab === "hub.prompts" ? `Every project › ${PAGE_LABEL[tab]}` : `Hub › ${PAGE_LABEL[tab]}`;

/** "Dock" is the Mac's word for it. (No window in the unit tests.) */
export const BADGE = typeof window !== "undefined" && window.fleetd.platform === "darwin" ? "Dock badge" : "App icon badge";

const page = (tab: Tab, keywords: ReadonlyArray<string>): SettingsOption => ({ key: tab, label: PAGE_LABEL[tab], tab, keywords });

/** Every option, in the sidebar's order. The Hub group's are found only by its owners and admins (optionsFor). */
export const OPTIONS: ReadonlyArray<SettingsOption> = [
  page("general", ["preferences"]),
  { key: "general.appearance", label: "Appearance", tab: "general", keywords: ["theme", "dark", "light", "mode", "match system"] },
  { key: "general.presence", label: "Time in the app", tab: "general", keywords: ["presence", "focus", "activity", "privacy", "minutes", "tracking"] },
  { key: "notifications", label: "Notifications", tab: "general", keywords: ["alerts", "mute"] },
  { key: "notifications.kinds", label: "Notify me when", tab: "general", keywords: ["notifications", "alerts", "mute", "finished", "done"] },
  { key: "notifications.sound", label: "Sound", tab: "general", keywords: ["notifications", "mute", "silent"] },
  { key: "notifications.badge", label: BADGE, tab: "general", keywords: ["badge", "dock", "count", "app icon"] },
  { key: "notifications.test", label: "Test notification", tab: "general", keywords: ["notifications", "alerts", "try"] },
  { key: "general.updates", label: "Version", tab: "general", keywords: ["version", "update", "check for updates", "edge", "stable", "channel", "what's new", "up to date"] },
  page("accounts", ["accounts", "connect", "sign in", "connections"]),
  { key: "claude", label: "Claude", tab: "accounts", keywords: ["claude", "anthropic", "subscription", "account", "api key", "token", "setup-token", "billing", "plan"] },
  { key: "claude.in-use", label: "Claude account in use", tab: "accounts", keywords: ["claude", "account", "connect", "runs on"] },
  { key: "claude.choice", label: "Runs on", tab: "accounts", keywords: ["claude", "subscription", "hub api", "api key", "switch"] },
  { key: "claude.subscription", label: "Your Claude subscription", tab: "accounts", keywords: ["claude", "subscription", "token", "setup-token", "oauth", "connect", "test"] },
  { key: "github", label: "GitHub", tab: "accounts", keywords: ["github", "git", "pull request", "pr", "account", "sign in", "connect"] },
  { key: "github.account", label: "Your GitHub", tab: "accounts", keywords: ["github", "connect", "pr", "pull request", "sign in", "token"] },
  { key: "onepassword", label: "1Password", tab: "accounts", keywords: ["1password", "one password", "password", "logins", "sign in", "vault", "fill", "credentials"] },
  { key: "onepassword.token", label: "1Password service account", tab: "accounts", keywords: ["1password", "service account", "token", "ops_", "OP_SERVICE_ACCOUNT_TOKEN", "vault", "test"] },
  page("your-memory", ["memory", "remember", "remembered", "user.md", "preferences", "how I work", "you", "forget"]),
  { key: "import-memory", label: "Import memory", tab: "your-memory", keywords: ["import", "chatgpt", "claude", "grok", "other assistant", "export", "bring", "memory"] },
  page("devices", ["devices", "phone", "signed in", "keys"]),
  { key: "devices.pair", label: "Pair a phone", tab: "devices", keywords: ["phone", "iphone", "android", "mobile", "pair", "qr", "scan", "code"] },
  page("hubs", ["hub", "pair", "connection", "server", "personal", "work", "team", "company"]),
  { key: "hubs.hub", label: "Hub", tab: "hubs", keywords: ["pair", "connection", "disconnect", "key", "server", "rename", "name", "label", "colour", "color", "remove"] },
  { key: "hubs.links", label: "Links to this hub", tab: "hubs", keywords: ["hub link", "link key", "navi", "other hub", "revoke"] },
  { key: "hubs.add", label: "Add a hub", tab: "hubs", keywords: ["pair", "another hub", "second hub", "connect", "personal", "work"] },
  { key: "hubs.hub-links", label: "Hub links", tab: "hubs", keywords: ["hub link", "link key", "navi", "other hub", "revoke"] },
  { key: "hubs.linked", label: "Linked hubs", tab: "hubs", keywords: ["hub link", "link key", "navi", "other hub", "reach"] },
  page("projects", ["project settings", "repo", "repository"]),
  { key: "projects.picture", label: "Project icon", tab: "projects", keywords: ["avatar", "photo", "image", "picture", "face", "color"] },
  { key: "projects.name", label: "Project name", tab: "projects", keywords: ["rename", "title"] },
  { key: "projects.repos", label: "Repos", tab: "projects", keywords: ["repo", "repository", "remote", "base branch", "checkout", "preview", "folder"] },
  { key: "projects.worktrees", label: "Worktrees", tab: "projects", keywords: ["worktree", "cleanup", "keep", "base branch", "branch", "disk"] },
  { key: "projects.env", label: "Environment variables", tab: "projects", keywords: ["env", ".env", "secrets", "api key", "token", "variables"] },
  { key: "projects.setup", label: "Default setup", tab: "projects", keywords: ["setup commands", "setup", "install", "dependencies", "codegen", "worktree", "lockfile", "pnpm"] },
  { key: "projects.telegram", label: "Telegram", tab: "projects", keywords: ["navi", "bot", "botfather", "phone", "pair"] },
  { key: "projects.approvals", label: "Approvals", tab: "projects", keywords: ["navi", "checker", "approve", "ask me", "yolo", "auto", "model", "effort"] },
  { key: "projects.approved", label: "Ran without asking", tab: "projects", keywords: ["navi", "checker", "log", "auto-approved", "yolo", "history"] },
  { key: "projects.integrations", label: "Integrations", tab: "projects", keywords: ["navi", "mcp", "connect"] },
  { key: "projects.payments", label: "Payments", tab: "projects", keywords: ["navi", "card", "credit card", "pay", "purchase", "buy", "book", "checkout", "1password"] },
  { key: "projects.signins", label: "Sign-ins", tab: "projects", keywords: ["navi", "browser", "sign in", "login", "logged in", "cookies", "forget", "sign out"] },
  { key: "projects.navi-skills", label: "Navi’s skills", tab: "projects", keywords: ["navi", "skill", "skills", "learned", "history", "versions", "revert"] },
  { key: "projects.delete", label: "Delete project", tab: "projects", keywords: ["remove", "delete", "forget"] },
  page("agents", ["limit", "at once", "parallel"]),
  { key: "agents.project", label: "Max agents", tab: "agents", keywords: ["limit", "at once", "parallel", "concurrency"] },
  { key: "agents.profiles", label: "Allowed profiles", tab: "agents", keywords: ["task profiles", "profile", "allowed", "model", "effort"] },
  { key: "projects.mcp", label: "Project MCP servers", tab: "agents", keywords: ["mcp", "tools", "servers", "connections", "integrations"] },
  { key: "agents.skills", label: "Skills", tab: "agents", keywords: ["skill", "SKILL.md", "skills.sh", "workflow", "install", ".agents", ".claude"] },
  page("instructions", ["custom instructions", "rules", "my text", "project"]),
  { key: "memory", label: "Project memory", tab: "instructions", keywords: ["memory", "remember", "remembered", "MEMORY.md", "forget", "rules"] },
  { key: "projects.memory", label: "Refresh memory every night", tab: "instructions", keywords: ["refresh", "nightly", "dreaming", "tidy", "memory"] },
  page("automations", ["schedule", "cron", "webhook", "recurring", "run now", "trigger"]),
  page("prompts", ["templates", "system prompt"]),
  ...Object.entries(ENTRIES).map(([id, e]) => ({ key: `prompt:${id}`, label: e.name, tab: "prompts" as const, keywords: ["prompt", id], prompt: id })),
  page("hub.people", ["team", "roles", "admin", "owner", "member", "remove", "claude account", "github account", "everyone's account", "usage"]),
  { key: "hub.invite", label: "Invite someone", tab: "hub.people", keywords: ["invite", "team", "join", "link", "add person"] },
  { key: "hub.invites", label: "Waiting to join", tab: "hub.people", keywords: ["invites", "open", "pending", "revoke"] },
  { key: "hub.links", label: "Hub links", tab: "hub.people", keywords: ["hub link", "link key", "navi", "other hub", "revoke", "everyone"] },
  page("hub.machines", ["machine", "computer", "box", "repair", "remove", "devices"]),
  { key: "hub.add-machine", label: "Add machine", tab: "hub.machines", keywords: ["machine", "ssh", "join", "computer", "this computer"] },
  { key: "hub.roles", label: "Machine roles", tab: "hub.machines", keywords: ["role", "sessions", "at once", "browser", "android", "ios", "desktop", "hosts"] },
  { key: "hub.caps", label: "Machine max agents", tab: "hub.machines", keywords: ["max agents", "whole fleet", "fleet cap", "machine cap", "limit", "at once", "all machines"] },
  { key: "hub.updates", label: "Updates", tab: "hub.machines", keywords: ["update", "upgrade", "hub version", "machine version", "fleetd update", "release"] },
  page("hub.profiles", ["task profiles", "profile", "model", "effort", "reasoning", "fast mode", "default", "every project"]),
  page("hub.tools", ["every project", "hub-wide", "global"]),
  { key: "hub.mcp", label: "MCP servers for every project", tab: "hub.tools", keywords: ["mcp", "tools", "servers", "global", "every project"] },
  { key: "mcp.servers", label: "Global MCP servers", tab: "hub.tools", keywords: ["mcp", "tools", "servers", "global", "every project"] },
  { key: "mcp.user", label: "Agents' own MCP servers", tab: "hub.tools", keywords: ["mcp", "own", "claude.json", ".mcp.json", "servers"] },
  { key: "hub.skills", label: "Hub-wide skills", tab: "hub.tools", keywords: ["skill", "skills", "SKILL.md", "skills.sh", "global", "every project"] },
  { key: "hub.instructions", label: "Instructions for every project", tab: "hub.instructions", keywords: ["custom instructions", "rules", "global", "hub-wide"] },
  { key: "hub.shared-memory", label: "Shared memory", tab: "hub.instructions", keywords: ["user.md", "memory", "shared", "retire", "old"] },
  page("hub.prompts", ["templates", "system prompt", "hub-wide", "global", "every project"]),
  page("hub.accounts", ["connections", "claude api key", "api key", "github app", "guided setup"]),
  { key: "admin.claude", label: "Hub Claude API key", tab: "hub.accounts", keywords: ["claude", "api key", "anthropic", "endpoint", "leads", "members may use"] },
  { key: "admin.claude.key", label: "Hub API key", tab: "hub.accounts", keywords: ["claude", "api key", "endpoint", "test", "anthropic"] },
  { key: "admin.claude.members", label: "Members may use the hub's key", tab: "hub.accounts", keywords: ["claude", "api key", "members", "allow"] },
  { key: "admin.claude.leads", label: "Leads and unrequested work", tab: "hub.accounts", keywords: ["claude", "lead", "automations", "train fixes", "runs on"] },
  { key: "admin.github", label: "GitHub App", tab: "hub.accounts", keywords: ["github", "app", "manifest", "installation", "webhook"] },
  page("hub.setup", ["setup", "guided setup", "first run", "fleetd init", "steps", "checklist"]),
];

/** What `administers` may find: everyone gets You and Projects; only an owner or admin, the Hub group too. */
export const optionsFor = (administers: boolean): ReadonlyArray<SettingsOption> => (administers ? OPTIONS : OPTIONS.filter((o) => !isHubTab(o.tab)));

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

/** The next page to show the element marked `key` (useReveal) scrolls to it and focuses it. */
export function revealNext(key: string | null) {
  wanted = key;
  for (const l of listeners) l();
}

/** Opens an option: its page (or prompt), then focus on the option itself. */
export function openOption(o: SettingsOption) {
  revealNext(o.prompt === undefined && o.key !== o.tab ? o.key : null);
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

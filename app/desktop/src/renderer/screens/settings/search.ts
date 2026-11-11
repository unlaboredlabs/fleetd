// Settings search: every page and option by its own name, plus the words people use for it ("dark", "theme"), so
// typing in the sidebar's field narrows to the option and opening one lands on it. Matching is pure and tested; the
// reveal is a one-shot "focus this option" that the page showing it takes up when it renders.
import { revealNext } from "./reveal";
import { isHubTab, tabHref, type Tab } from "./route";

export { revealNext, useReveal } from "./reveal";

export interface SettingsOption {
  /** Unique; also the reveal key the page's option registers with useReveal. */
  readonly key: string;
  readonly label: string;
  readonly tab: Tab;
  readonly keywords?: ReadonlyArray<string>;
}

export const PAGE_LABEL: Readonly<Record<Tab, string>> = {
  general: "General",
  accounts: "Your accounts",
  vault: "Vault",
  "your-memory": "Your memory",
  devices: "Your devices",
  hubs: "Hubs",
  projects: "Project",
  agents: "Agents",
  instructions: "Instructions & memory",
  automations: "Automations",
  prompts: "Built-in prompts",
  "project-vault": "Vault",
  "hub.people": "People",
  "hub.machines": "Machines",
  "hub.updates": "Updates",
  "hub.profiles": "Profiles",
  "hub.tools": "Tools & skills",
  "hub.instructions": "Instructions & memory",
  "hub.prompts": "Built-in prompts",
  "hub.accounts": "Hub accounts",
  "hub.vault": "Vault",
  "hub.setup": "Setup",
};

/** Where a search result is, beside its name: the page, and for a Hub page its group, as the sidebar nests them. */
export const pagePath = (tab: Tab): string =>
  tab === "project-vault" ? "Project › Vault" : !isHubTab(tab) ? PAGE_LABEL[tab] : tab === "hub.profiles" || tab === "hub.tools" || tab === "hub.instructions" || tab === "hub.prompts" ? `Every project › ${PAGE_LABEL[tab]}` : `Hub › ${PAGE_LABEL[tab]}`;

const page = (tab: Tab, keywords: ReadonlyArray<string>): SettingsOption => ({ key: tab, label: PAGE_LABEL[tab], tab, keywords });

/** Every option, in the sidebar's order. The Hub group's are found only by its owners and admins (optionsFor). */
export const OPTIONS: ReadonlyArray<SettingsOption> = [
  page("general", ["preferences"]),
  { key: "general.name", label: "Name", tab: "general", keywords: ["your name", "rename", "display name", "profile", "account", "who you are"] },
  { key: "general.appearance", label: "Appearance", tab: "general", keywords: ["theme", "dark", "light", "mode", "match system"] },
  { key: "general.presence", label: "Time in the app", tab: "general", keywords: ["presence", "focus", "activity", "privacy", "minutes", "tracking"] },
  { key: "notifications", label: "Notifications", tab: "general", keywords: ["alerts", "mute"] },
  { key: "notifications.kinds", label: "Notify me when", tab: "general", keywords: ["notifications", "alerts", "mute", "finished", "done"] },
  { key: "notifications.test", label: "Test notification", tab: "general", keywords: ["notifications", "alerts", "try"] },
  { key: "general.updates", label: "Version", tab: "general", keywords: ["version", "update", "check for updates", "edge", "stable", "up to date"] },
  page("accounts", ["accounts", "connect", "sign in", "connections"]),
  {
    key: "claude",
    label: "Claude",
    tab: "accounts",
    keywords: ["claude", "anthropic", "subscription", "account", "in use", "runs on", "hub api", "api key", "switch", "token", "setup-token", "oauth", "connect", "test", "billing", "plan"],
  },
  { key: "github", label: "GitHub", tab: "accounts", keywords: ["github", "git", "pull request", "pr", "account", "sign in", "connect"] },
  { key: "github.account", label: "Your GitHub", tab: "accounts", keywords: ["github", "connect", "pr", "pull request", "sign in", "token"] },
  { key: "onepassword", label: "1Password", tab: "accounts", keywords: ["1password", "one password", "password", "logins", "sign in", "vault", "fill", "credentials"] },
  { key: "onepassword.token", label: "1Password service account", tab: "accounts", keywords: ["1password", "service account", "token", "ops_", "OP_SERVICE_ACCOUNT_TOKEN", "vault", "test"] },
  page("vault", ["vault", "passwords", "logins", "cards", "credit card", "addresses", "address", "variables", "env", "secrets", "api key", "token", "activity", "audit"]),
  { key: "vault.import", label: "Import from 1Password", tab: "vault", keywords: ["1password", "one password", "import", "vault", "logins", "cards"] },
  page("your-memory", ["memory", "remember", "remembered", "user.md", "preferences", "how I work", "you", "forget"]),
  { key: "import-memory", label: "Import memory", tab: "your-memory", keywords: ["import", "chatgpt", "claude", "grok", "other assistant", "export", "bring", "memory"] },
  page("devices", ["devices", "phone", "signed in", "keys"]),
  { key: "devices.pair", label: "Pair a phone", tab: "devices", keywords: ["phone", "iphone", "android", "mobile", "pair", "qr", "scan", "code"] },
  page("hubs", ["hub", "pair", "connection", "server", "personal", "work", "team", "company"]),
  { key: "hubs.hub", label: "Hub", tab: "hubs", keywords: ["pair", "connection", "disconnect", "key", "server", "rename", "name", "label", "colour", "color", "remove", "restart"] },
  { key: "hubs.add", label: "Add a hub", tab: "hubs", keywords: ["pair", "another hub", "second hub", "connect", "personal", "work"] },
  { key: "hubs.links", label: "Hub links", tab: "hubs", keywords: ["hub link", "links to this hub", "link key", "other hub", "revoke"] },
  page("projects", ["project settings", "repo", "repository"]),
  { key: "projects.picture", label: "Project icon", tab: "projects", keywords: ["avatar", "photo", "image", "picture", "face"] },
  { key: "projects.color", label: "Bot color", tab: "projects", keywords: ["avatar", "colour", "bot", "pebble", "palette"] },
  { key: "projects.name", label: "Project name", tab: "projects", keywords: ["rename", "title"] },
  { key: "projects.only-me", label: "Only me", tab: "projects", keywords: ["private", "personal", "share", "shared", "who sees", "owner", "everyone"] },
  { key: "projects.repos", label: "Repos", tab: "projects", keywords: ["repo", "repository", "remote", "base branch", "checkout", "preview", "folder"] },
  { key: "projects.env", label: "Environment variables", tab: "projects", keywords: ["env", ".env", "secrets", "api key", "token", "variables"] },
  { key: "projects.setup", label: "Setup", tab: "projects", keywords: ["setup commands", "install", "dependencies", "codegen", "worktree", "lockfile", "pnpm"] },
  { key: "projects.linked", label: "Linked hubs", tab: "projects", keywords: ["hub link", "link key", "other hub", "reach"] },
  { key: "projects.approvals", label: "Approvals", tab: "projects", keywords: ["checker", "approve", "ask me", "yolo", "auto"] },
  { key: "projects.approved", label: "Ran without asking", tab: "projects", keywords: ["checker", "log", "auto-approved", "yolo", "history"] },
  { key: "projects.mcp", label: "MCP servers", tab: "projects", keywords: ["mcp", "integrations", "tools", "servers", "connections", "connect", "oauth", "sign in"] },
  { key: "projects.payments", label: "Payments", tab: "projects", keywords: ["card", "credit card", "pay", "purchase", "buy", "book", "checkout", "1password"] },
  { key: "projects.signins", label: "Sign-ins", tab: "projects", keywords: ["browser", "sign in", "login", "logged in", "cookies", "forget", "sign out"] },
  { key: "projects.skills", label: "Project skills", tab: "projects", keywords: ["skill", "skills", "learned", "history", "versions", "revert"] },
  { key: "projects.archive", label: "Archive project", tab: "projects", keywords: ["archive", "bring back", "unarchive", "hide", "restore"] },
  { key: "projects.delete", label: "Delete project", tab: "projects", keywords: ["remove", "delete", "forget"] },
  page("agents", ["limit", "at once", "parallel"]),
  { key: "agents.project", label: "Max agents", tab: "agents", keywords: ["limit", "at once", "parallel", "concurrency"] },
  { key: "agents.profiles", label: "Allowed profiles", tab: "agents", keywords: ["task profiles", "profile", "allowed", "model", "effort"] },
  { key: "agents.skills", label: "Skills", tab: "agents", keywords: ["skill", "SKILL.md", "skills.sh", "workflow", "install", ".agents", ".claude"] },
  page("instructions", ["custom instructions", "rules", "my text", "project"]),
  { key: "memory", label: "Project memory", tab: "instructions", keywords: ["memory", "remember", "remembered", "MEMORY.md", "forget", "rules", "refresh", "nightly", "tidy"] },
  { key: "project-vault", label: "Project vault", tab: "project-vault", keywords: ["vault", "env", ".env", "variables", "secrets", "api key", "token", "logins", "cards"] },
  page("automations", ["schedule", "cron", "webhook", "recurring", "run now", "trigger"]),
  page("prompts", ["prompt", "templates", "system prompt", "lead", "reviewer", "writer", "voice"]),
  page("hub.people", ["team", "roles", "admin", "owner", "member", "remove", "claude account", "github account", "everyone's account", "usage"]),
  { key: "hub.invite", label: "Invite someone", tab: "hub.people", keywords: ["invite", "team", "join", "link", "add person"] },
  { key: "hub.invites", label: "Waiting to join", tab: "hub.people", keywords: ["invites", "open", "pending", "revoke"] },
  { key: "hub.links", label: "Hub links", tab: "hub.people", keywords: ["hub link", "link key", "other hub", "revoke", "everyone"] },
  page("hub.machines", ["machine", "computer", "box", "repair", "remove", "devices"]),
  { key: "hub.add-machine", label: "Add machine", tab: "hub.machines", keywords: ["machine", "ssh", "join", "computer", "this computer"] },
  { key: "hub.roles", label: "Machine roles", tab: "hub.machines", keywords: ["role", "sessions", "browser", "android", "desktop", "mac", "hosts"] },
  { key: "hub.screens", label: "Screens", tab: "hub.machines", keywords: ["screens", "browser", "android", "emulator", "linux desktop", "agents’ mac", "mac", "turn on", "at once", "idle"] },
  { key: "hub.caps", label: "Machine max agents", tab: "hub.machines", keywords: ["max agents", "machine cap", "limit", "at once"] },
  { key: "hub.recordings", label: "Screen recordings", tab: "hub.machines", keywords: ["recordings", "retention", "keep", "days", "screens"] },
  page("hub.updates", ["update", "upgrade", "update automatically", "automatic updates", "auto update", "update now", "fleetd update", "release", "version", "build"]),
  page("hub.profiles", ["task profiles", "profile", "model", "effort", "reasoning", "fast mode", "default", "every project"]),
  { key: "hub.lead", label: "Lead runs on", tab: "hub.profiles", keywords: ["lead", "lead model", "lead effort", "profile", "model", "effort"] },
  page("hub.tools", ["every project", "hub-wide", "global"]),
  { key: "hub.mcp", label: "MCP servers for every project", tab: "hub.tools", keywords: ["mcp", "tools", "servers", "global", "every project"] },
  { key: "mcp.user", label: "Agents' own MCP servers", tab: "hub.tools", keywords: ["mcp", "own", "claude.json", ".mcp.json", "servers"] },
  { key: "hub.skills", label: "Hub-wide skills", tab: "hub.tools", keywords: ["skill", "skills", "SKILL.md", "skills.sh", "global", "every project"] },
  { key: "hub.instructions", label: "Instructions for every project", tab: "hub.instructions", keywords: ["custom instructions", "rules", "global", "hub-wide"] },
  page("hub.accounts", ["connections", "claude api key", "api key", "github app", "guided setup"]),
  { key: "admin.claude", label: "Hub Claude API key", tab: "hub.accounts", keywords: ["claude", "api key", "anthropic", "endpoint", "test", "leads", "automations", "runs on", "members may use"] },
  { key: "admin.claude.members", label: "Members may use the hub's key", tab: "hub.accounts", keywords: ["claude", "api key", "members", "allow"] },
  { key: "admin.github", label: "GitHub App", tab: "hub.accounts", keywords: ["github", "app", "manifest", "installation", "webhook"] },
  page("hub.vault", ["vault", "team card", "shared login", "every project", "hub-wide", "cards", "logins", "addresses"]),
  { key: "vault.key", label: "Vault key", tab: "hub.vault", keywords: ["vault key", "recovery code", "rotate", "unlock", "passphrase", "locked"] },
  page("hub.setup", ["setup", "guided setup", "first run", "fleetd init", "steps"]),
];

const VAULT_TABS: ReadonlyArray<Tab> = ["vault", "project-vault", "hub.vault"];

/**
 * What `administers` may find: everyone gets You and Projects; only an owner or admin, the Hub group too. The Vault's
 * pages only on a hub that serves it (`vault`).
 */
export const optionsFor = (administers: boolean, vault = true): ReadonlyArray<SettingsOption> =>
  OPTIONS.filter((o) => (administers || !isHubTab(o.tab)) && (vault || !VAULT_TABS.includes(o.tab)));

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

/** Opens an option: its page, then focus on the option itself. */
export function openOption(o: SettingsOption) {
  revealNext(o.key !== o.tab ? o.key : null);
  window.location.hash = tabHref(o.tab);
}

// Settings search: every page and option by its own name, plus the words people use for it ("dark", "theme"), so
// typing in the sidebar's field narrows to the option and opening one lands on it. Matching is pure and tested; the
// reveal is a one-shot "focus this option" that the page showing it takes up when it renders.
import { openConnections } from "../connections/state";
import { revealNext } from "./reveal";
import { isEveryProject, isHubTab, pageOf, tabHref, type Tab } from "./route";

export { revealNext, useReveal } from "./reveal";

export interface SettingsOption {
  /** Unique; also the reveal key the page's option registers with useReveal. */
  readonly key: string;
  readonly label: string;
  readonly tab: Tab;
  readonly keywords?: ReadonlyArray<string>;
  /** It isn't in Settings: Connections (D653) holds it, and opening it opens that sheet. */
  readonly opens?: "connections";
}

export const PAGE_LABEL: Readonly<Record<Tab, string>> = {
  general: "General",
  accounts: "Accounts",
  vault: "Vault",
  "your-memory": "Memory",
  devices: "Your devices",
  hubs: "Hubs & devices",
  projects: "Bot",
  agents: "Agents",
  instructions: "Instructions & memory",
  automations: "Automations",
  prompts: "Built-in prompts",
  "project-vault": "Vault",
  "hub.people": "People",
  "hub.machines": "Machines",
  "hub.billing": "Billing",
  "hub.updates": "Updates",
  "hub.profiles": "Agents",
  "hub.tools": "Tools & skills",
  "hub.instructions": "Instructions",
  "hub.prompts": "Built-in prompts",
  "hub.accounts": "Hub accounts",
  "hub.vault": "Vault",
  "hub.setup": "Setup",
};

/**
 * Where a search result is, beside its name: the page that holds it (route.ts's pageOf, for what was a page once),
 * and for a Hub page its group, as the sidebar and Every project's tabs nest them.
 */
export const pagePath = (tab: Tab): string => {
  const on = pageOf(tab);
  if (on === "project-vault") return "Bot › Vault";
  if (!isHubTab(on)) return PAGE_LABEL[on];
  return `${isEveryProject(on) ? "Bot defaults" : "Hub"} › ${PAGE_LABEL[on]}`;
};

const page = (tab: Tab, keywords: ReadonlyArray<string>): SettingsOption => ({ key: tab, label: PAGE_LABEL[tab], tab, keywords });

/**
 * What moved to Connections (D653): Settings' Integrations, MCP servers (a bot's, every bot's) and
 * Machines' Network (Tailscale). Found by their old names and words, each opens the sheet.
 */
const CONNECTIONS: ReadonlyArray<SettingsOption> = [
  {
    key: "connections",
    label: "Connections",
    tab: "general",
    opens: "connections",
    keywords: ["integrations", "apps", "connect", "sign in", "oauth", "mcp", "mcp servers", "custom mcp", "tools", "servers", "global", "mcp servers for every bot", "headers"],
  },
  { key: "connections.paper", label: "Paper", tab: "general", opens: "connections", keywords: ["paper", "design", "connect"] },
  { key: "connections.notion", label: "Notion", tab: "general", opens: "connections", keywords: ["notion", "docs", "wiki", "connect"] },
  {
    key: "connections.tailscale",
    label: "Tailscale",
    tab: "general",
    opens: "connections",
    keywords: ["tailscale", "tailnet", "network", "vpn", "magicdns", "private", "gateway", "connect"],
  },
];

/** Every option, in the sidebar's order. The Hub group's are found only by its owners and admins (optionsFor). */
export const OPTIONS: ReadonlyArray<SettingsOption> = [
  ...CONNECTIONS,
  page("general", ["preferences"]),
  { key: "general.name", label: "Name", tab: "general", keywords: ["your name", "rename", "display name", "profile", "account", "who you are"] },
  { key: "general.appearance", label: "Appearance", tab: "general", keywords: ["theme", "dark", "light", "mode", "match system", "see-through sidebar", "transparent", "solid sidebar"] },
  { key: "general.presence", label: "Time in the app", tab: "general", keywords: ["presence", "focus", "activity", "privacy", "minutes", "tracking"] },
  { key: "notifications", label: "Notifications", tab: "general", keywords: ["notify me when", "alerts", "mute", "finished", "done"] },
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
  page("vault", ["vault", "team vault", "passwords", "logins", "cards", "credit card", "team card", "shared login", "addresses", "address", "activity", "audit", "set aside", "vault for every bot", "hub-wide"]),
  { key: "vault.import", label: "Import from 1Password", tab: "vault", keywords: ["1password", "one password", "import", "vault", "logins", "cards"] },
  page("your-memory", ["memory", "remember", "remembered", "user.md", "preferences", "how I work", "you", "forget"]),
  { key: "import-memory", label: "Import memory", tab: "your-memory", keywords: ["import", "chatgpt", "claude", "grok", "other assistant", "export", "bring", "memory"] },
  page("hubs", ["hub", "pair", "connection", "server", "personal", "work", "team", "company"]),
  { key: "hubs.hub", label: "Hub", tab: "hubs", keywords: ["pair", "connection", "disconnect", "key", "server", "rename", "name", "label", "colour", "color", "remove", "restart"] },
  { key: "hubs.add", label: "Add a hub", tab: "hubs", keywords: ["pair", "another hub", "second hub", "connect", "personal", "work"] },
  { key: "devices", label: PAGE_LABEL.devices, tab: "hubs", keywords: ["devices", "phone", "signed in", "keys"] },
  { key: "devices.pair", label: "Pair a phone", tab: "hubs", keywords: ["phone", "iphone", "android", "mobile", "pair", "qr", "scan", "code"] },
  page("projects", ["bot settings", "repo", "repository"]),
  { key: "projects.picture", label: "Bot icon", tab: "projects", keywords: ["avatar", "photo", "image", "picture", "face"] },
  { key: "projects.look", label: "Bot shape and color", tab: "projects", keywords: ["avatar", "color", "colour", "shape", "bot", "pebble", "ghost", "kitty", "bunny", "toast", "palette"] },
  { key: "projects.name", label: "Bot name", tab: "projects", keywords: ["rename", "title"] },
  { key: "projects.repos", label: "Repos", tab: "projects", keywords: ["repo", "repository", "remote", "base branch", "checkout", "preview", "folder"] },
  { key: "projects.env", label: "Environment variables", tab: "projects", keywords: ["env", ".env", "secrets", "api key", "token", "variables"] },
  {
    key: "projects.computer",
    label: "Computer",
    tab: "projects",
    keywords: ["setup", "setup commands", "install", "dependencies", "codegen", "worktree", "lockfile", "pnpm", "computer image", "prebuilt", "snapshot", "rebuild", "sandbox"],
  },
  { key: "projects.approvals", label: "Approvals", tab: "projects", keywords: ["checker", "approve", "ask me", "yolo", "auto"] },
  { key: "projects.approved", label: "Ran without asking", tab: "projects", keywords: ["checker", "log", "auto-approved", "yolo", "history"] },
  { key: "projects.mcp", label: "Bot connections", tab: "projects", keywords: ["what this bot uses", "this bot's connections"] },
  { key: "projects.payments", label: "Payments", tab: "projects", keywords: ["card", "credit card", "pay", "purchase", "buy", "book", "checkout", "1password"] },
  { key: "projects.signins", label: "Sign-ins", tab: "projects", keywords: ["browser", "sign in", "login", "logged in", "cookies", "forget", "sign out"] },
  { key: "projects.skills", label: "Bot skills", tab: "projects", keywords: ["skill", "skills", "learned", "history", "versions", "revert"] },
  { key: "projects.archive", label: "Archive bot", tab: "projects", keywords: ["archive", "bring back", "unarchive", "hide", "restore"] },
  { key: "projects.delete", label: "Delete bot", tab: "projects", keywords: ["remove", "delete", "forget", "project"] },
  page("agents", ["limit", "at once", "parallel"]),
  { key: "agents.project", label: "Max agents", tab: "agents", keywords: ["limit", "at once", "parallel", "concurrency"] },
  { key: "agents.profiles", label: "Allowed profiles", tab: "agents", keywords: ["task profiles", "profile", "allowed", "model", "effort"] },
  { key: "agents.skills", label: "Skills", tab: "agents", keywords: ["skill", "SKILL.md", "skills.sh", "workflow", "install", ".agents", ".claude"] },
  page("instructions", ["custom instructions", "rules", "my text", "project"]),
  { key: "memory", label: "Bot memory", tab: "instructions", keywords: ["memory", "remember", "remembered", "MEMORY.md", "forget", "rules", "refresh", "nightly", "tidy"] },
  { key: "project-vault", label: "Bot variables", tab: "project-vault", keywords: ["vault", "env", ".env", "variables", "secrets", "api key", "token"] },
  page("automations", ["schedule", "cron", "webhook", "recurring", "run now", "trigger"]),
  page("prompts", ["prompt", "templates", "system prompt", "lead", "reviewer", "writer", "voice"]),
  page("hub.people", ["team", "roles", "admin", "owner", "member", "remove", "claude account", "github account", "everyone's account", "usage"]),
  { key: "hub.invite", label: "Invite someone", tab: "hub.people", keywords: ["invite", "team", "join", "link", "add person"] },
  { key: "hub.invites", label: "Waiting to join", tab: "hub.people", keywords: ["invites", "open", "pending", "revoke"] },
  page("hub.machines", ["machine", "computer", "box", "repair", "remove", "devices"]),
  page("hub.billing", ["billing", "payment", "pay", "stripe", "invoice", "card", "subscription"]),
  { key: "hub.billing.plan", label: "Plan", tab: "hub.billing", keywords: ["plan", "solo", "team", "scale", "upgrade", "subscription", "price"] },
  { key: "hub.billing.credits", label: "Credits", tab: "hub.billing", keywords: ["credits", "top up", "add credits", "balance", "buy"] },
  { key: "hub.billing.usage", label: "Computer time", tab: "hub.billing", keywords: ["usage", "hours", "computer time", "spend", "cost"] },
  { key: "hub.billing.cap", label: "Spend cap", tab: "hub.billing", keywords: ["cap", "limit", "budget", "spend cap", "monthly"] },
  { key: "hub.add-machine", label: "Add machine", tab: "hub.machines", keywords: ["machine", "ssh", "join", "computer", "this computer"] },
  { key: "hub.roles", label: "Machine roles", tab: "hub.machines", keywords: ["role", "sessions", "browser", "android", "desktop", "mac", "hosts"] },
  { key: "hub.screens", label: "Screens", tab: "hub.machines", keywords: ["screens", "browser", "android", "emulator", "linux desktop", "agents’ mac", "mac", "turn on", "at once", "idle"] },
  { key: "hub.caps", label: "Machine max agents", tab: "hub.machines", keywords: ["max agents", "machine cap", "limit", "at once"] },
  { key: "hub.sandboxes", label: "Providers", tab: "hub.machines", keywords: ["providers", "sandbox", "sandboxes", "hosted", "api key", "limit", "at once", "cloud", "capacity", "connect"] },
  {
    key: "hub.provided",
    label: "fleetd's computers",
    tab: "hub.machines",
    keywords: ["fleetd's computers", "computers", "computer time", "hosted", "cloud", "size", "asleep", "awake", "at once", "plan", "vm", "sandbox"],
  },
  { key: "hub.where", label: "What runs where", tab: "hub.machines", keywords: ["what runs where", "where agents run", "where screens run", "route", "routing", "browser", "linux desktop", "android", "ios simulator", "mac", "your machines"] },
  { key: "hub.recordings", label: "Screen recordings", tab: "hub.machines", keywords: ["recordings", "retention", "keep", "days", "screens"] },
  { key: "hub.updates", label: PAGE_LABEL["hub.updates"], tab: "hub.machines", keywords: ["update", "upgrade", "update automatically", "automatic updates", "auto update", "update now", "fleetd update", "release", "version", "build"] },
  { key: "hub.profiles", label: "Agents for every bot", tab: "hub.profiles", keywords: ["bot defaults", "defaults", "every bot", "hub-wide"] },
  { key: "hub.task-profiles", label: "Profiles", tab: "hub.profiles", keywords: ["task profiles", "profile", "model", "effort", "reasoning", "fast mode", "default", "every bot"] },
  { key: "hub.lead", label: "Lead runs on", tab: "hub.profiles", keywords: ["lead", "lead model", "lead effort", "profile", "model", "effort"] },
  { key: "hub.tools", label: PAGE_LABEL["hub.tools"], tab: "hub.profiles", keywords: ["every bot", "hub-wide", "global"] },
  { key: "hub.skills", label: "Hub-wide skills", tab: "hub.profiles", keywords: ["skill", "skills", "SKILL.md", "skills.sh", "global", "every bot"] },
  { key: "hub.instructions", label: "Instructions for every bot", tab: "hub.instructions", keywords: ["custom instructions", "rules", "global", "hub-wide"] },
  { key: "vault.key", label: "Vault key", tab: "hub.vault", keywords: ["vault key", "recovery code", "rotate", "unlock", "passphrase", "locked"] },
  page("hub.setup", ["setup", "guided setup", "first run", "fleetd init", "steps"]),
  // Hub accounts was a page once: its name still finds the accounts, on Setup, and each of its options the account that holds it.
  { key: "hub.accounts", label: PAGE_LABEL["hub.accounts"], tab: "hub.setup", keywords: ["accounts", "connections", "claude api key", "api key", "github app", "guided setup"] },
  { key: "admin.claude", label: "Hub Claude API key", tab: "hub.setup", keywords: ["claude", "api key", "anthropic", "endpoint", "test", "leads", "automations", "runs on", "members may use"] },
  { key: "admin.claude.members", label: "Members may use the hub's key", tab: "hub.setup", keywords: ["claude", "api key", "members", "allow"] },
  { key: "admin.github", label: "GitHub App", tab: "hub.setup", keywords: ["github", "app", "manifest", "installation", "webhook"] },
];

const VAULT_TABS: ReadonlyArray<Tab> = ["vault", "project-vault", "hub.vault"];

/**
 * What `administers` may find: everyone gets You and Projects; only an owner or admin, the Hub group too. The Vault's
 * pages only on a hub that serves it (`vault`); Billing only on a fleetd cloud team (`billing`), where Machines holds
 * fleetd's computers in place of the providers a team connects with its own key (admin/Provided.tsx). General's
 * Version only where it shows (`version`): never in the web app on fleetd cloud, which updates itself (General.tsx).
 */
export const optionsFor = (administers: boolean, vault = true, billing = false, version = true): ReadonlyArray<SettingsOption> =>
  OPTIONS.filter(
    (o) =>
      (administers || !isHubTab(o.tab)) &&
      (vault || !VAULT_TABS.includes(o.tab)) &&
      (version || o.key !== "general.updates") &&
      (billing || o.tab !== "hub.billing") &&
      o.key !== (billing ? "hub.sandboxes" : "hub.provided"),
  );

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

/** Where a result is, beside its name: Connections, or the page that holds it; none for a page itself. */
export const whereOf = (o: SettingsOption): string | null => (o.opens === "connections" ? (o.key === "connections" ? null : "Connections") : o.key === o.tab ? null : pagePath(o.tab));

/** Opens an option: its page, then focus on the option itself; one of Connections', that sheet. */
export function openOption(o: SettingsOption) {
  if (o.opens === "connections") {
    openConnections();
    return;
  }
  revealNext(o.key !== o.tab ? o.key : null);
  window.location.hash = tabHref(o.tab);
}

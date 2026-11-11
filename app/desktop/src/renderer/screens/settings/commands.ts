// Settings in the command palette: its pages and a few settings by their own names. One entry per place:
// Notifications covers its sound and badge, and the theme commands cover Appearance. The Hub group's pages are offered
// to its owners and admins only. main.tsx registers them once, with the app's data layer.
import { registerCommands, type Command } from "../palette";
import type { DataLayer } from "../../src/data/queries";
import type { HubInfoOutput, SetupListOutput } from "../../../shared/contracts";
import { administers } from "../admin/model";
import { toHash, type HubTab } from "../shell/routes";
import { tabHref } from "./route";
import { revealNext } from "./search";

const go = (hash: string) => {
  window.location.hash = hash;
};

const pages: Command[] = [
  {
    id: "go:settings.notifications",
    title: "Notifications",
    detail: "What alerts you",
    group: "settings",
    keywords: ["alerts", "mute", "notify me when"],
    run: () => {
      revealNext("notifications");
      go(tabHref("general"));
    },
  },
  {
    id: "go:settings.prompts",
    title: "Built-in prompts",
    detail: "What fleetd itself tells a project's agents",
    group: "settings",
    keywords: ["prompts", "templates", "system prompt"],
    run: () => go(tabHref("prompts")),
  },
  {
    id: "go:settings.projects",
    title: "Project settings",
    detail: "A project's name, repos, environment variables, setup and MCP servers, or delete it",
    group: "settings",
    keywords: ["env", "secrets", "setup", "mcp", "integrations", "delete project", "rename"],
    run: () => go(tabHref("projects")),
  },
  {
    id: "go:settings.instructions",
    title: "Instructions & memory",
    detail: "A project's own instructions, and what its leads remember",
    group: "settings",
    keywords: ["custom instructions", "rules", "memory", "remember"],
    run: () => go(tabHref("instructions")),
  },
  {
    id: "go:settings.accounts",
    title: "Your accounts",
    detail: "The Claude account and GitHub your work runs on",
    group: "settings",
    keywords: ["claude", "github", "account", "subscription", "connections"],
    run: () => go(tabHref("accounts")),
  },
  {
    id: "go:settings.your-memory",
    title: "Your memory",
    detail: "How you work, as the leads remember it: yours alone",
    group: "settings",
    keywords: ["memory", "remember", "forget", "preferences"],
    run: () => go(tabHref("your-memory")),
  },
  {
    id: "go:settings.devices",
    title: "Your devices",
    detail: "Hubs & devices: the devices signed in as you, and Pair a phone",
    group: "settings",
    keywords: ["phone", "pair", "qr", "mobile", "devices"],
    run: () => go(tabHref("devices")),
  },
  {
    id: "go:settings.hubs",
    title: "Hubs & devices",
    detail: "The hubs this app is paired with, their links, and your devices",
    group: "settings",
    keywords: ["hub", "hubs", "pair", "add a hub", "hub links", "connections"],
    run: () => go(tabHref("hubs")),
  },
  {
    id: "go:settings.updates",
    title: "Version",
    detail: "Whether fleetd is up to date",
    group: "settings",
    keywords: ["version", "update", "upgrade", "edge", "channel"],
    run: () => {
      revealNext("general.updates");
      go(tabHref("general"));
    },
  },
  // A setting by its own name, typed rather than listed, so "max agents" finds it.
  ...(
    [
      ["Max agents", "How many of a project's agents run at once", "agents", ["agents", "limit", "at once", "cap", "concurrency"]],
      ["Hub", "The connection, and this app's key", "hubs", ["connection", "disconnect", "key"]],
    ] as const
  ).map(
    ([title, detail, tab, keywords]): Command => ({
      id: `setting:${title}`,
      title,
      detail,
      group: "settings",
      keywords,
      searchOnly: true,
      run: () => go(tabHref(tab)),
    }),
  ),
];

/** Registers the Settings pages with the palette, for the life of the app. Returns the unregister. */
export function registerSettingsCommands(layer: DataLayer): () => void {
  // The Hub group, for an owner or admin as hub_info last said (D211).
  const info = layer.toolQuery("hub_info", {});
  const admin = () => administers(layer.queryClient.getQueryData<HubInfoOutput>(info.queryKey));
  const setup = layer.toolQuery("setup_list", {});
  // Settings opens on Hub › Setup while a required step is left, for those who can take it.
  const left = () => (admin() ? (layer.queryClient.getQueryData<SetupListOutput>(setup.queryKey)?.requiredLeft ?? 0) : 0);
  const offPages = registerCommands([
    {
      id: "settings.open",
      title: "Settings",
      detail: "You, your projects, and the hub",
      group: "settings",
      keywords: ["preferences", "administration"],
      run: () => go(left() > 0 ? toHash({ id: "settings", tab: "hub.setup" }) : tabHref("general")),
    },
    ...pages,
  ]);
  const hubPage = (id: string, title: string, detail: string, tab: HubTab, keywords: ReadonlyArray<string>): Command => ({
    id,
    title,
    detail,
    group: "settings",
    keywords: ["hub", "administration", "admin", ...keywords],
    enabled: admin,
    run: () => go(toHash({ id: "settings", tab })),
  });
  const offAdmin = registerCommands([
    hubPage("go:hub.machines", "Machines", "Settings › Hub: add a machine, its roles, max agents, updates", "hub.machines", ["machine", "add machine", "fleet cap", "machine roles", "update", "upgrade"]),
    hubPage("go:hub.profiles", "Agents for every project", "Every project: task profiles, global MCP servers and hub-wide skills", "hub.profiles", ["profiles", "task profiles", "model", "effort"]),
    hubPage("go:hub.tools", "Tools & skills", "Every project › Agents: global MCP servers and hub-wide skills", "hub.tools", ["mcp", "skills", "global", "every project"]),
    hubPage("go:hub.instructions", "Instructions for every project", "Every project: instructions and shared memory", "hub.instructions", ["instructions", "memory caps", "global"]),
    hubPage("go:hub.accounts", "Hub accounts", "Hub › Setup: the hub's Claude API key and GitHub App", "hub.accounts", ["claude", "api key", "github app", "connections"]),
    hubPage("go:hub.setup", "Setup", "Settings › Hub: the hub's accounts and its other setup steps", "hub.setup", ["setup", "guided setup", "accounts", "steps"]),
  ]);
  return () => {
    offAdmin();
    offPages();
  };
}

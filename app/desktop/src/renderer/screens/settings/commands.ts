// Settings in the command palette: its pages, each setting by its own name, and every prompt by its plain name (typed, not listed: there
// are 60 of them), each opening in a project's Prompts. The Hub group's pages are offered to its owners and admins
// only. main.tsx registers them once, with the app's data layer.
import { registerCommands, registerSource, type Command } from "../palette";
import { GROUPS, describe, groupOf } from "./catalog";
import { hashKey } from "@tanstack/react-query";
import type { DataLayer } from "../../src/data/queries";
import type { HubInfoOutput, SetupListOutput } from "../../../shared/contracts";
import { administers } from "../admin/model";
import { toHash, type HubTab } from "../shell/routes";
import type { PromptSummary } from "./contracts";
import { promptHref, tabHref } from "./route";
import { BADGE, revealNext } from "./search";

const go = (hash: string) => {
  window.location.hash = hash;
};

const pages: Command[] = [
  {
    id: "go:settings.notifications",
    title: "Notifications",
    detail: "What alerts you, sound, the badge",
    group: "settings",
    keywords: ["alerts", "sound", "badge", "dock", "mute"],
    run: () => {
      revealNext("notifications");
      go(tabHref("general"));
    },
  },
  {
    id: "go:settings.prompts",
    title: "Prompts",
    detail: "Everything fleetd tells a project's agents",
    group: "settings",
    keywords: ["templates", "system prompt"],
    run: () => go(tabHref("prompts")),
  },
  {
    id: "go:settings.projects",
    title: "Project settings",
    detail: "A project's name, repos, worktrees, environment variables and setup, or delete it",
    group: "settings",
    keywords: ["env", "secrets", "worktrees", "setup", "delete project", "rename"],
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
    detail: "The devices signed in as you, and Pair a phone",
    group: "settings",
    keywords: ["phone", "pair", "qr", "mobile", "devices"],
    run: () => go(tabHref("devices")),
  },
  {
    id: "go:settings.hubs",
    title: "Hubs",
    detail: "The hubs this app is paired with, and their links",
    group: "settings",
    keywords: ["hub", "pair", "add a hub", "hub links", "connections"],
    run: () => go(tabHref("hubs")),
  },
  {
    id: "go:settings.updates",
    title: "Version",
    detail: "Which fleetd this app runs, and whether the hub is up to date",
    group: "settings",
    keywords: ["version", "update", "upgrade", "edge", "channel"],
    run: () => {
      revealNext("general.updates");
      go(tabHref("general"));
    },
  },
  // Each setting by its own name, typed rather than listed, so "max agents" or "dark mode" finds it.
  ...(
    [
      ["Max agents", "How many of a project's agents run at once", "agents", ["agents", "limit", "at once", "cap", "concurrency"]],
      ["Appearance", "Light, dark or match system", "general", ["theme", "dark mode", "light mode"]],
      ["Hub", "The connection, and this app's key", "hubs", ["connection", "disconnect", "key"]],
      ["Notify me when", "Which kinds of notification show", "general", ["notifications", "alerts", "mute"]],
      ["Sound", "Notifications play a sound or not", "general", ["notifications", "mute", "silent"]],
      [BADGE, "How many projects need you, on the app icon", "general", ["badge", "dock", "count", "app icon"]],
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

const groupTitle = (p: PromptSummary) => GROUPS.find((g) => g.key === groupOf(p))?.title ?? "";

/**
 * Registers the Settings pages and a `prompts` source with the palette, for the life of the app. The prompts come
 * from the data layer's hub-wide prompt_get list, the same read the Prompts page makes, fetched the first time the
 * palette asks while the connection is fresh (names don't change with edits). Returns the unregister.
 */
export function registerSettingsCommands(layer: DataLayer): () => void {
  const read = layer.toolQuery("prompt_get", {});
  const prompts = (): ReadonlyArray<PromptSummary> => layer.queryClient.getQueryData<{ prompts: PromptSummary[] }>(read.queryKey)?.prompts ?? [];
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
    hubPage("go:hub.profiles", "Profiles", "Every project: the task profiles agents run on", "hub.profiles", ["task profiles", "model", "effort"]),
    hubPage("go:hub.tools", "Tools & skills", "Every project: global MCP servers and hub-wide skills", "hub.tools", ["mcp", "skills", "global", "every project"]),
    hubPage("go:hub.instructions", "Instructions for every project", "Every project: instructions and memory caps", "hub.instructions", ["instructions", "memory caps", "global"]),
    hubPage("go:hub.prompts", "Hub-wide prompts", "Every project: the texts fleetd sends every project's agents", "hub.prompts", ["prompts", "templates", "global"]),
    hubPage("go:hub.accounts", "Hub accounts", "The hub's Claude API key, GitHub App and Google client", "hub.accounts", ["claude", "api key", "github app", "google", "connections"]),
  ]);
  const offSource = registerSource({
    id: "prompts",
    items: () => {
      const list = prompts();
      // A failed read is tried again the next time the palette opens.
      if (list.length === 0 && layer.store.getState().fresh) layer.queryClient.query(read).catch(() => undefined);
      return list
        .filter((p) => p.kind !== "instructions")
        .map((p) => {
          const { name, description } = describe(p);
          return {
            id: `prompt:${p.id}`,
            title: name,
            detail: description,
            group: "prompts",
            keywords: [p.id, p.title, groupTitle(p)],
            searchOnly: true,
            run: () => go(promptHref(p.id)),
          };
        });
    },
    subscribe: (onChange) =>
      layer.queryClient.getQueryCache().subscribe((e) => {
        if (e.type === "updated" && e.query.queryHash === hashKey(read.queryKey)) onChange();
      }),
  });
  return () => {
    offSource();
    offAdmin();
    offPages();
  };
}

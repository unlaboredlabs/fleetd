// Settings in the command palette: its pages, each setting by its own name, and every prompt by its plain name (typed, not listed: there
// are 60 of them), each opening in Settings → Prompts. main.tsx registers them once, with the app's data layer.
import { registerCommands, registerSource, type Command } from "../palette";
import { GROUPS, describe, groupOf } from "./catalog";
import { hashKey } from "@tanstack/react-query";
import type { DataLayer } from "../../src/data/queries";
import type { PromptSummary } from "./contracts";
import { promptHref, tabHref } from "./route";
import { BADGE } from "./search";

const go = (hash: string) => {
  window.location.hash = hash;
};

const pages: Command[] = [
  {
    id: "settings.open",
    title: "Settings",
    detail: "Appearance, the hub, pairing links",
    group: "settings",
    keywords: ["preferences"],
    run: () => go(tabHref("general")),
  },
  {
    id: "go:settings.notifications",
    title: "Notifications",
    detail: "What alerts you, sound, the badge",
    group: "settings",
    keywords: ["alerts", "sound", "badge", "dock", "mute"],
    run: () => go(tabHref("notifications")),
  },
  {
    id: "go:settings.prompts",
    title: "Prompts",
    detail: "Everything fleetd tells its agents",
    group: "settings",
    keywords: ["templates", "system prompt"],
    run: () => go(tabHref("prompts")),
  },
  {
    id: "go:settings.projects",
    title: "Project settings",
    detail: "A project's name, worktrees, environment variables and setup commands, or delete it",
    group: "settings",
    keywords: ["env", "secrets", "worktrees", "setup", "delete project", "rename"],
    run: () => go(tabHref("projects")),
  },
  {
    id: "go:settings.instructions",
    title: "Instructions",
    detail: "A project's own, added to its agents' first message",
    group: "settings",
    keywords: ["custom instructions", "rules"],
    run: () => go(tabHref("instructions")),
  },
  // Each setting by its own name, typed rather than listed, so "max agents" or "dark mode" finds it.
  ...(
    [
      ["Max agents", "How many agents run at once, per project and in all", "agents", ["agents", "limit", "at once", "whole fleet", "cap", "concurrency"]],
      ["Appearance", "Light, dark or match system", "general", ["theme", "dark mode", "light mode"]],
      ["Hub", "The connection, and this app's key", "general", ["connection", "disconnect", "key"]],
      ["Notify me when", "Which kinds of notification show", "notifications", ["notifications", "alerts", "mute"]],
      ["Sound", "Notifications play a sound or not", "notifications", ["notifications", "mute", "silent"]],
      [BADGE, "How many projects need you, on the app icon", "notifications", ["badge", "dock", "count", "app icon"]],
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
  const offPages = registerCommands(pages);
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
    offPages();
  };
}

// Settings in the command palette: its pages, each setting by its own name, and every prompt by its plain name (typed, not listed: there
// are 60 of them), each opening in Settings → Prompts. main.tsx registers them once, with the app's data layer.
import { registerCommands, registerSource, type Command } from "../palette";
import { GROUPS, describe, groupOf } from "./catalog";
import { hashKey } from "@tanstack/react-query";
import type { DataLayer } from "../../src/data/queries";
import type { PromptSummary } from "./contracts";
import { promptHref, tabHref } from "./route";

const go = (hash: string) => {
  window.location.hash = hash;
};

const pages: Command[] = [
  {
    id: "settings.open",
    title: "Settings",
    detail: "Appearance, motion, the hub, data",
    group: "settings",
    keywords: ["preferences"],
    run: () => go(tabHref("general")),
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
    id: "go:settings.instructions",
    title: "Instructions",
    detail: "Your own, added to every agent's first message",
    group: "settings",
    keywords: ["custom instructions", "rules"],
    run: () => go(tabHref("instructions")),
  },
  // Each setting by its own name, typed rather than listed, so "max agents" or "dark mode" finds it.
  ...(
    [
      ["Max agents", "How many agents run at once, per project and in all", "agents", ["agents", "limit", "at once", "whole fleet", "cap", "concurrency"]],
      ["Appearance", "Light, dark or match system", "general", ["theme", "dark mode", "light mode"]],
      ["Motion", "Keep motion or reduce it", "general", ["animation", "reduce motion"]],
      ["Hub", "The connection, and this app's key", "general", ["connection", "disconnect", "key"]],
      ["Pairing links", "Open fleetd:// links in this app", "general", ["links", "default app"]],
      ["Time data", "How long the time inspector keeps history", "general", ["retention", "history", "days"]],
      ["Claude auto memory", "Off for every agent unless a project turns it on", "general", ["memory"]],
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
 * from the data layer's hub-wide prompts_list, the same read the Prompts page makes, fetched the first time the
 * palette asks while the connection is fresh (names don't change with edits). Returns the unregister.
 */
export function registerSettingsCommands(layer: DataLayer): () => void {
  const read = layer.toolQuery("prompts_list", {});
  const prompts = (): ReadonlyArray<PromptSummary> => layer.queryClient.getQueryData<{ prompts: PromptSummary[] }>(read.queryKey)?.prompts ?? [];
  const offPages = registerCommands(pages, "default");
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

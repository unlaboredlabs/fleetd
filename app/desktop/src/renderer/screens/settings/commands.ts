// Settings in the command palette: its three pages, and every prompt by its plain name (typed, not listed: there
// are 60 of them), each opening in Settings → Prompts.
import { registerCommands, registerSource, type Command } from "../palette";
import { GROUPS, describe, groupOf } from "./catalog";
import type { PromptsListOutput, PromptSummary } from "./contracts";
import { call, hubPhase, onHubChange } from "./hub";
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
    keywords: ["preferences", "dark mode", "theme", "retention", "digest", "disconnect"],
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
];

let prompts: ReadonlyArray<PromptSummary> = [];
let asking = false;
const listeners = new Set<() => void>();

/** The list is fetched the first time the palette asks while connected; names don't change with edits. */
function load() {
  if (prompts.length > 0 || asking || hubPhase().phase !== "live") return;
  asking = true;
  call<PromptsListOutput>("prompts_list", {}).then(
    (o) => {
      asking = false;
      prompts = o.prompts.filter((p) => p.kind !== "instructions");
      for (const l of listeners) l();
    },
    () => {
      // Tried again the next time the palette opens.
      asking = false;
    },
  );
}

const groupTitle = (p: PromptSummary) => GROUPS.find((g) => g.key === groupOf(p))?.title ?? "";

registerCommands(pages, "default");
registerSource({
  id: "prompts",
  items: () => {
    load();
    return prompts.map((p) => {
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
  subscribe: (onChange) => {
    listeners.add(onChange);
    const off = onHubChange(load);
    return () => {
      listeners.delete(onChange);
      off();
    };
  },
});

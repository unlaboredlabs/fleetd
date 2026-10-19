// Commands that need nothing but the route table (notes/electron-routes.md): the palette itself, the shortcuts
// sheet, and plain navigation. A screen that does better registers the same id and wins while it is mounted.

import type { Command } from "./registry";
import { togglePalette, toggleShortcuts } from "./state";

const go = (route: string) => {
  window.location.hash = route;
};

/** A project's lead chat. */
export const chatRoute = (machineId: string, projectId: string): string =>
  `#/project/${encodeURIComponent(machineId)}/${encodeURIComponent(projectId)}`;

/** ⌘. from Status goes back to where you were; from anywhere else it opens Status. */
export const statusToggleTarget = (hash: string): "back" | "#/status" => (/^#\/status(?:[/?]|$)/u.test(hash) ? "back" : "#/status");

export const defaultCommands = (): Command[] => [
  { id: "palette.toggle", title: "Command palette", group: "actions", searchOnly: true, run: togglePalette },
  { id: "shortcuts.show", title: "Keyboard shortcuts", group: "actions", searchOnly: true, keywords: ["keys", "hotkeys", "help"], run: toggleShortcuts },
  {
    id: "status.toggle",
    title: "Status",
    detail: "Every project: working, waiting on you, idle or blocked",
    group: "go-to",
    run: () => {
      const target = statusToggleTarget(window.location.hash);
      if (target === "back") window.history.back();
      else go(target);
    },
  },
  { id: "go:time", title: "Time", detail: "Where the time went", group: "go-to", keywords: ["timeline", "inspector"], run: () => go("#/time") },
  { id: "go:machines", title: "Machines", detail: "Machines and setup checks", group: "go-to", run: () => go("#/machines") },
  { id: "go:projects.add", title: "Add a project…", detail: "Point the fleet at a folder", group: "actions", run: () => go("#/projects/add") },
  {
    id: "settings.open",
    title: "Settings",
    detail: "Appearance, motion and hub connection",
    group: "settings",
    keywords: ["preferences"],
    run: () => go("#/settings"),
  },
  { id: "go:settings.prompts", title: "Prompts", detail: "Settings", group: "settings", keywords: ["templates"], run: () => go("#/settings/prompts") },
  { id: "go:settings.instructions", title: "Instructions", detail: "Settings", group: "settings", run: () => go("#/settings/instructions") },
  { id: "go:onboarding", title: "Connect to a hub…", detail: "Pair this app with a fleetd hub", group: "actions", keywords: ["pair"], run: () => go("#/onboarding") },
];

// Commands that need nothing but the route table (notes/electron-routes.md): the palette itself, the shortcuts
// sheet, and plain navigation. Settings and Add project are defined by their own screens (settings/commands.ts,
// ProjectsHost), which are up for the life of the app.

import type { ThemeMode } from "../../ui";
import { timeRouteFor } from "../time/route";
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
  {
    id: "go:time",
    title: "Time",
    detail: "Where the time went: all work, or one piece of work's timeline",
    group: "go-to",
    keywords: ["timeline", "inspector", "breakdown", "insights", "slow", "critical path"],
    run: () => go(timeRouteFor(window.location.hash)),
  },
  { id: "go:machines", title: "Machines", detail: "Machines and setup checks", group: "go-to", run: () => go("#/machines") },
  { id: "go:onboarding", title: "Connect to a hub…", detail: "Pair this app with a fleetd hub", group: "actions", keywords: ["pair"], run: () => go("#/onboarding") },
];

/** The appearance switches, each hidden while it is the current choice; "dark" finds one. */
export const themeCommands = (mode: ThemeMode, setMode: (mode: ThemeMode) => void): Command[] =>
  (
    [
      ["dark", "Switch to dark theme", ["dark mode", "appearance"]],
      ["light", "Switch to light theme", ["light mode", "appearance"]],
      ["system", "Match the system theme", ["auto", "appearance"]],
    ] as const
  ).map(
    ([value, title, keywords]): Command => ({
      id: `theme:${value}`,
      title,
      group: "actions",
      keywords,
      searchOnly: true,
      enabled: () => mode !== value,
      run: () => setMode(value),
    }),
  );

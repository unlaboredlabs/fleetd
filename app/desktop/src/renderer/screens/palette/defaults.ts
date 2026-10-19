// Commands that need nothing but the route table (notes/electron-routes.md): the palette itself, the shortcuts
// sheet, and plain navigation. A screen that does better (status at the focused order's scope, the inbox panel's
// own toggle) registers the same id and wins while it is mounted.

import type { Command } from "./registry";
import { togglePalette, toggleShortcuts } from "./state";

const go = (route: string) => {
  window.location.hash = route;
};

/** The route part of the hash and its query, e.g. "#/order/W14?inbox" → ["/order/W14", URLSearchParams("inbox")]. */
export const splitHash = (hash: string): [string, URLSearchParams] => {
  const body = hash.replace(/^#/u, "");
  const at = body.indexOf("?");
  const path = at < 0 ? body : body.slice(0, at);
  return [path === "" ? "/" : path, new URLSearchParams(at < 0 ? "" : body.slice(at + 1))];
};

/** Status at the scope you're looking at: an order's, a project's, or the fleet's. */
export const statusRouteFor = (hash: string): string => {
  const [path] = splitHash(hash);
  const order = /^\/order\/([^/?]+)/u.exec(path)?.[1];
  if (order !== undefined) return `#/status/order/${order}`;
  const project = /^\/board\/([^/]+)\/([^/]+)/u.exec(path);
  if (project) return `#/status/project/${project[1] ?? ""}/${project[2] ?? ""}`;
  return "#/status";
};

/** The inbox is a panel kept in the query (`?inbox`), so it opens over whatever route you're on. */
export const toggleInboxHash = (hash: string): string => {
  const [path, query] = splitHash(hash);
  if (query.has("inbox")) {
    query.delete("inbox");
    query.delete("ask");
  } else query.set("inbox", "");
  const rest = query.toString().replace(/=(?=&|$)/gu, "");
  return `#${path}${rest === "" ? "" : `?${rest}`}`;
};

export const defaultCommands = (): Command[] => [
  { id: "palette.toggle", title: "Command palette", group: "actions", searchOnly: true, run: togglePalette },
  { id: "shortcuts.show", title: "Keyboard shortcuts", group: "actions", searchOnly: true, keywords: ["keys", "hotkeys", "help"], run: toggleShortcuts },
  { id: "board.open", title: "Board", detail: "Every open order", group: "go-to", run: () => go("#/board") },
  {
    id: "inbox.toggle",
    title: "Inbox",
    detail: "What needs you",
    group: "go-to",
    keywords: ["needs you", "questions", "asks"],
    run: () => go(toggleInboxHash(window.location.hash)),
  },
  {
    id: "status.toggle",
    title: "Status",
    detail: "How the fleet, a project or an order is doing",
    group: "go-to",
    run: () => {
      const [path] = splitHash(window.location.hash);
      if (path.startsWith("/status")) window.history.back();
      else go(statusRouteFor(window.location.hash));
    },
  },
  { id: "go:machines", title: "Machines", detail: "Machines and setup checks", group: "go-to", run: () => go("#/machines") },
  { id: "go:time", title: "Time", detail: "Where the time went", group: "go-to", keywords: ["timeline", "inspector"], run: () => go("#/time") },
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

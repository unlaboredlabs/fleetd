// status.toggle (⌘., from the shared shortcut map; never a key literal here). From an order it opens that order's
// Status, from a project's board the project's, otherwise the fleet's; from Status it goes back where it came from.
// F11's registry runs `run()`; the screen registers it while mounted (and F11 seeds it as the default elsewhere).

import { scopeFromRoute, scopeRoute, statusFor } from "./view";

let before: string | null = null;

/** The route ⌘. goes to from `hash`, remembering where Status was opened from. */
export const toggleRoute = (hash: string): string => {
  if (scopeFromRoute(hash) !== null) {
    const back = before ?? "#/board";
    before = null;
    return back;
  }
  before = hash === "" ? "#/" : hash;
  return scopeRoute(statusFor(hash));
};

export const statusToggleCommand = {
  id: "status.toggle",
  title: "Status",
  group: "go-to",
  keywords: ["progress", "eta", "health"],
  run: (): void => {
    window.location.hash = toggleRoute(window.location.hash);
  },
} as const;

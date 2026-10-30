// What the header says while the link to the hub isn't live, as Telegram's "Connecting…": the words take the title's
// place, so nothing is added to the screen and the list under it never moves (linkHeader.tsx, link.test.ts).
import type { HubState } from "./desktop";

/** The words in place of the title, with a spinner beside them while it dials; undefined while live. */
export const linkStatus = (state: HubState): { readonly text: string; readonly busy: boolean } | undefined => {
  switch (state.phase) {
    case "live":
    case "unpaired":
      return undefined;
    case "connecting":
    case "retrying":
      return { text: "Connecting…", busy: true };
    case "refused":
      return { text: "Not Connected", busy: false };
  }
};

/** How long a link is down before the title says so: a wake's quick redial doesn't flash it. */
export const LINK_GRACE_MS = 1000;

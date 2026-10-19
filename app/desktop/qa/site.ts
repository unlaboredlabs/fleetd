// The app shots on fleetd.sh that come from fixtures: each one a registered screen (registry.ts) on a sanitized lab
// recording (fixtures/recorded, E3b's kit), in the light theme at the medium window (1400x900) and 2x, the size the
// pages lay them out at. `pnpm qa:build && pnpm site:shots` writes them over the files in site/ (SITE_SHOTS=<file>,<file>
// to limit). The landing page's inbox shots come from a lab run instead (tests/lab/site-capture.ts). Both are taken
// last, once the screens are final.
//
// `recapture: true` marks a file that still shows the GPUI app: re-shoot it, review it with `git diff site/`, then drop
// the mark.

export interface SiteShot {
  // Under site/.
  file: string;
  // A screen id from registry.ts, for its route and how to open it.
  screen: string;
  // A recording in fixtures/recorded.
  recording: string;
  // Instead of the registry's route, e.g. an order the recording has.
  route?: string;
  recapture?: true;
}

export const siteShots: readonly SiteShot[] = [
  // The landing page's board: one order at work, its PRs each with the agent that wrote it and the checkers under it.
  { file: "fleet-board.png", screen: "board", recording: "lab-demo", recapture: true },
  { file: "docs/img/board.png", screen: "board", recording: "lab-demo", recapture: true },
  // No recording has a clone in progress yet: record one, or show the sheet as it opens.
  { file: "docs/img/add-project.png", screen: "projects.add", recording: "lab-demo", recapture: true },
  { file: "docs/img/steering.png", screen: "order.steer", recording: "lab-demo", route: "#/order/W1", recapture: true },
  { file: "docs/img/time.png", screen: "time.timeline", recording: "lab-demo", route: "#/time/order/W1", recapture: true },
];

// Shot by the lab run (tests/lab/site-capture.ts), not here; listed so every app image on the site carries its mark.
// The landing page's callouts over them are placed by hand and move with the layout.
export const labShots: readonly Pick<SiteShot, "file" | "recapture">[] = [
  { file: "capture-inbox.png", recapture: true },
  { file: "capture-reply.png", recapture: true },
];

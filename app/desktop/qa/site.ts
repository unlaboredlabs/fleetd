// The app shots on fleetd.sh that come from fixtures: each one a registered screen × fixture (registry.ts), in the
// light theme at the medium window (1400x900) and 2x, the size the pages lay them out at. `pnpm fixtures && pnpm
// qa:build && pnpm site:shots` writes them over the files in site/ (SITE_SHOTS=<file>,<file> to limit). The landing
// page's inbox shots come from a lab run instead (tests/lab/site-capture.ts).
//
// `recapture: true` marks a file that still shows the GPUI app: re-shoot it once its screen is final, review the
// result with `git diff site/`, then drop the mark.

export interface SiteShot {
  // Under site/.
  file: string;
  screen: string;
  fixture: string;
  recapture?: true;
}

export const siteShots: readonly SiteShot[] = [
  // The landing page's board: one order at work, its PRs each with the agent that wrote it and the checkers under it.
  { file: "fleet-board.png", screen: "board", fixture: "board-stage", recapture: true },
  { file: "docs/img/board.png", screen: "board", fixture: "board-stage", recapture: true },
  { file: "docs/img/add-project.png", screen: "projects.add.cloning", fixture: "projects-cloning", recapture: true },
  { file: "docs/img/steering.png", screen: "order.steer", fixture: "typical", recapture: true },
  { file: "docs/img/time.png", screen: "time.timeline", fixture: "typical", recapture: true },
];

// Shot by the lab run (tests/lab/site-capture.ts), not here; listed so every app image on the site carries its mark.
// The landing page's callouts over them are placed by hand and move with the layout.
export const labShots: readonly Pick<SiteShot, "file" | "recapture">[] = [
  { file: "capture-inbox.png", recapture: true },
  { file: "capture-reply.png", recapture: true },
];

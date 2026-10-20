// The app shots on fleetd.sh that come from fixtures: each one a registered screen (registry.ts) on a fixture of E3b's
// kit built from sanitized lab traffic (`typical` is the recorded lab hub, kit/shared.ts; a group fixture such as
// `projects-cloning` extends it), in the light theme at the medium window (1400x900) and 2x, the size the pages lay
// them out at. `pnpm fixtures && pnpm qa:build && pnpm site:shots` writes them over the files in the repo
// (SITE_SHOTS=<file>,<file> to limit): the landing page's in site/, the docs' in docs/site/public/img/, which the
// docs build copies to site/docs/img/. The landing page's inbox shots come from a lab run instead
// (tests/lab/site-capture.ts). Re-shoot after a change to what these screens show, and review with `git diff site/ docs/site/public/img/`.

export interface SiteShot {
  // From the repo root.
  file: string;
  // A screen id from registry.ts, for its route and how to open it.
  screen: string;
  // A fixture the registry shoots that screen on, so the QA gate already vouches for it.
  fixture: string;
}

export const siteShots: readonly SiteShot[] = [
  { file: "docs/site/public/img/add-project.png", screen: "projects.add.cloning", fixture: "projects-cloning" },
  { file: "docs/site/public/img/time.png", screen: "time.timeline", fixture: "typical" },
];

// Shot by the lab run (tests/lab/site-capture.ts), not here; listed so this file names every app image on the site.
// The landing page's callouts over them are placed by hand and move with the layout.
export const labShots: readonly string[] = ["capture-inbox.png", "capture-reply.png"];

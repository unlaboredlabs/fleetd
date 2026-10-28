// The app shots on fleetd.sh that come from fixtures: each one a registered screen (registry.ts) on a fixture of E3b's
// kit built from sanitized lab traffic (`typical` is the recorded lab hub, kit/shared.ts; a group fixture such as
// `projects-cloning` extends it), at the medium window (1400x900) and 2x, the size the pages lay them out at, in the
// light theme unless the entry says dark. `pnpm fixtures && pnpm qa:build && pnpm site:shots` writes them over the files in the repo
// (SITE_SHOTS=<file>,<file> to limit): the docs' in docs/site/public/img/, which the docs build copies to
// site/docs/img/. The landing page's are clips instead (showcase.spec.ts). Re-shoot after a change to what these screens show, and review with `git diff site/ docs/site/public/img/`.

export interface SiteShot {
  // From the repo root.
  file: string;
  // A screen id from registry.ts, for its route and how to open it.
  screen: string;
  // A fixture the registry shoots that screen on, so the QA gate already vouches for it.
  fixture: string;
  // The registry entry's variant, when the screen has several on that fixture.
  variant?: string;
  theme?: "light" | "dark";
}

export const siteShots: readonly SiteShot[] = [
  { file: "docs/site/public/img/chat.png", screen: "chat", variant: "strip", fixture: "live-3" },
  { file: "docs/site/public/img/chat-history.png", screen: "chat", variant: "history", fixture: "chat-long" },
  { file: "docs/site/public/img/status.png", screen: "status.fleet", fixture: "typical" },
  { file: "docs/site/public/img/max-agents.png", screen: "settings.agents", variant: "from-panel", fixture: "settings-agents" },
  { file: "docs/site/public/img/chat-command.png", screen: "chat", variant: "inline-chat", fixture: "chat-gated" },
  { file: "docs/site/public/img/chat-secret.png", screen: "chat", variant: "inline-chat", fixture: "chat-secret" },
  { file: "docs/site/public/img/add-project.png", screen: "projects.add.cloning", fixture: "projects-cloning" },
  { file: "docs/site/public/img/time.png", screen: "time.timeline", fixture: "typical" },
];

// THE screen registry: every screen × fixture the QA gate shoots and checks. A screen PR adds its screens here; the
// suite then covers them at every size and theme on Linux and macOS, and any finding fails the PR.
//
// To register a screen (routes and ids: F1's route table, src/renderer/screens/shell/routes.ts):
//   1. The screen's root carries data-screen="<id>", or "<id>.<state>" for a sub-state such as "board.empty"; the
//      harness waits for either.
//   2. Add an entry below: the id, the hash route that shows it, and the fixtures it must survive: the stress
//      fixtures that touch its data (long-text, many-*), plus empty and the error states it renders.
//   3. A screen with no route of its own gets `open`, using keys, roles and labels rather than CSS classes:
//        { id: "palette", route: "#/", fixtures: ["typical"], open: (page) => page.keyboard.press("ControlOrMeta+K") }
//        { id: "inbox", route: "#/board?inbox", fixtures: ["needs-you", "long-text", "empty"] }
// Fixtures are E3b's, built by `pnpm fixtures` into app/desktop/fixtures/<name>.json.
// Run it locally: `pnpm fixtures && pnpm qa:build && pnpm qa` (QA_SCREENS=<id>,<id> to limit), then open
// qa-results/index.html.

import type { Page } from "@playwright/test";

export const fixtures = [
  "empty",
  "typical",
  "long-text",
  "many-prompts",
  "many-agents",
  "needs-you",
  "conversation",
  "hub-unreachable",
  "pairing-failed",
  "node-too-old",
] as const;
export type FixtureName = (typeof fixtures)[number];

export const sizes = {
  small: { width: 1024, height: 700 },
  medium: { width: 1400, height: 900 },
  large: { width: 1920, height: 1200 },
} as const;
export type SizeName = keyof typeof sizes;

export const themes = ["light", "dark"] as const;
export type Theme = (typeof themes)[number];

export interface Screen {
  id: string;
  // Hash route, e.g. "#/settings/prompts".
  route: string;
  fixtures: readonly FixtureName[];
  // Defaults to every size.
  sizes?: readonly SizeName[];
  // Brings up a screen that has no route of its own; runs after the route has loaded.
  open?: (page: Page) => Promise<void>;
  // Registered ahead of its PR: skipped, with this reason, until the owner deletes the field.
  pending?: string;
}

const gallerySections = [
  "tokens",
  "text",
  "buttons",
  "fields",
  "choices",
  "overlays",
  "tabs",
  "status",
  "markdown",
  "code",
  "diff",
  "table",
  "list",
  "layout",
] as const;

export const screens: readonly Screen[] = [
  // E0/F1: the frame (top bar, sidebar) around the default route, and the connection states it shows.
  {
    id: "shell",
    route: "#/",
    fixtures: ["empty", "typical", "hub-unreachable", "pairing-failed", "node-too-old"],
  },
  // E2: every design-system primitive with short, long and empty content, one section per entry, so the primitives
  // pass before any screen uses them. Needs a build with the gallery in it: `pnpm qa:build`.
  ...gallerySections.map((s) => ({ id: `gallery.${s}`, route: `#/gallery?section=${s}`, fixtures: ["long-text"] as const })),
];

// Platform checks that need a screen writer's work before they can pass; the owner turns theirs on when it lands.
export const platformChecks: Record<"appMenu", boolean> = {
  // F1: the macOS app menu, with an Edit menu wired to the text actions.
  appMenu: false,
};

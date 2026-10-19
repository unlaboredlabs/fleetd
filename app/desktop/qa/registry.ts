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
  // Group fixtures (fixtures/<group>/index.ts), named <group>-<what>.
  "projects-cloning",
  "projects-errors",
  "projects-machines",
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
  // F8: Add project (the pick list, its empty and loading states, gh and machine problems) and Machines.
  { id: "projects.add", route: "#/projects/add", fixtures: ["typical", "empty", "long-text", "node-too-old", "hub-unreachable"] },
  // Opened from Machines, which subscribed first: the sheet must still find the live connection and list repos.
  {
    id: "projects.add.pick",
    route: "#/machines",
    fixtures: ["typical"],
    open: async (page) => {
      await page.getByRole("button", { name: "Add project…" }).click();
    },
  },
  // The sheet's later states, reached by adding from the pick list (fixtures/projects answers project_add).
  {
    id: "projects.add.cloning",
    route: "#/projects/add",
    fixtures: ["projects-cloning"],
    open: async (page) => {
      await page.getByRole("listbox", { name: "Repos" }).waitFor();
      await page.getByRole("textbox", { name: "GitHub URL, folder path, or filter" }).fill("acme/checkout-v2");
      await page.keyboard.press("Enter");
      // The fixture's progress events are timed; shoot once the bar shows git's 42%.
      await page.locator('[role="progressbar"][aria-valuenow="34"]').waitFor();
    },
  },
  {
    id: "projects.add.ready",
    route: "#/projects/add",
    fixtures: ["typical", "long-text"],
    open: async (page) => {
      await page.getByRole("listbox", { name: "Repos" }).waitFor();
      await page.getByRole("textbox", { name: "GitHub URL, folder path, or filter" }).fill("/home/dev/src/pricing");
      await page.keyboard.press("Enter");
    },
  },
  {
    id: "projects.add.error",
    route: "#/projects/add",
    fixtures: ["typical", "projects-errors"],
    open: async (page) => {
      await page.getByRole("listbox", { name: "Repos" }).waitFor();
      await page.getByRole("textbox", { name: "GitHub URL, folder path, or filter" }).fill("acme/ledger-ui");
      await page.keyboard.press("Enter");
    },
  },
  { id: "machines", route: "#/machines", fixtures: ["typical", "empty", "long-text", "many-agents", "hub-unreachable", "projects-machines"] },
  // F11: the command palette, its reply mode (typed text switches it) and the shortcuts sheet.
  {
    id: "palette",
    route: "#/",
    fixtures: ["typical", "long-text", "empty", "many-prompts"],
    open: (page) => page.keyboard.press("ControlOrMeta+K"),
  },
  {
    id: "palette.reply",
    route: "#/",
    fixtures: ["needs-you", "long-text", "empty"],
    open: async (page) => {
      await page.keyboard.press("ControlOrMeta+K");
      await page.getByRole("combobox", { name: "Search or reply" }).fill("1 go 2 nvm 3 b");
    },
  },
  { id: "shortcuts", route: "#/", fixtures: ["typical"], open: (page) => page.keyboard.press("ControlOrMeta+Slash") },
];

// Platform checks that need a screen writer's work before they can pass; the owner turns theirs on when it lands.
export const platformChecks: Record<"appMenu", boolean> = {
  // F1: the macOS app menu, with an Edit menu wired to the text actions.
  appMenu: false,
};

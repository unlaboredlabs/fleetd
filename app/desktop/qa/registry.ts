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
  // F9: the whole real prompt registry, with edits, a project's own texts and a default changed under an edit.
  "settings-prompts",
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

export const screens: readonly Screen[] = [
  // E0/F1: the frame (top bar, sidebar) around the default route, and the connection states it shows.
  {
    id: "shell",
    route: "#/",
    fixtures: ["empty", "typical", "hub-unreachable", "pairing-failed", "node-too-old"],
  },
  // E2: every design-system primitive with stress content, so the primitives pass before any screen uses them.
  { id: "gallery", route: "#/gallery", fixtures: ["typical"], pending: "E2's gallery (feat/desktop-ui) has not landed" },
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
  // F9: Settings. Prompts opens on the lead's first message, the longest text; many-prompts lists 72 with long
  // keys and titles; settings-prompts is the real registry with edits. Compare and Update are deep links.
  ...settings([
    { id: "settings.general", route: "#/settings/general", fixtures: ["typical", "empty", "hub-unreachable"] },
    {
      id: "settings.prompts",
      route: "#/settings/prompts?prompt=lead.start",
      fixtures: ["settings-prompts", "many-prompts", "long-text", "empty", "hub-unreachable"],
    },
    {
      id: "settings.prompts.compare",
      route: "#/settings/prompts?prompt=task.brief.write&for=devbox/storefront&view=compare",
      fixtures: ["settings-prompts"],
    },
    { id: "settings.prompts.update", route: "#/settings/prompts?prompt=lead.start&view=update", fixtures: ["settings-prompts"] },
    { id: "settings.instructions", route: "#/settings/instructions?for=devbox/storefront", fixtures: ["settings-prompts", "typical", "empty"] },
  ]),
];

/** Shows a placeholder until F1's screen host (feat/desktop-shell-ui) imports SettingsScreen; then this goes. */
function settings(list: Screen[]): Screen[] {
  return list.map((s) => ({ ...s, pending: "F1's screen host does not show SettingsScreen on this branch yet" }));
}

// Platform checks that need a screen writer's work before they can pass; the owner turns theirs on when it lands.
export const platformChecks: Record<"appMenu", boolean> = {
  // F1: the macOS app menu, with an Edit menu wired to the text actions.
  appMenu: false,
};

// THE screen registry: every screen × fixture the QA gate shoots and checks. A screen PR adds its screens here; the
// suite then covers them at every size and theme on Linux and macOS, and any finding fails the PR.
//
// To register a screen (routes and ids: F1's route table, src/renderer/screens/shell/routes.ts):
//   1. The screen's root carries data-screen="<id>", or "<id>.<state>" for a sub-state such as "board.empty"; the
//      harness waits for either.
//   2. Add an entry below: the id, the hash route that shows it, and the fixtures it must survive: the stress
//      fixtures that touch its data (long-text, many-*), plus empty and the error states it renders.
//      A screen whose route ends on an error or not-found state ("<id>.error", "<id>.not-found") fails, unless
//      the entry says `expect: "error"`; register error fixtures as a separate entry with that field.
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
  // F9: the whole real prompt registry, with edits, a project's own texts and a default changed under an edit.
  "settings-prompts",
  "board-stage",
  "board-finish",
  // Group fixtures (fixtures/<group>/index.ts), named <group>-<what>.
  "projects-cloning",
  // F10: the connect screen's states (fixtures/onboarding).
  "onboarding-first-run",
  "onboarding-local-hub",
  "onboarding-link",
  "onboarding-app-pair",
  "onboarding-app-pair-expired",
  "onboarding-app-pair-untrusted",
  "onboarding-rate-limited",
  "onboarding-unreadable-key",
  "onboarding-file-store",
  "onboarding-not-found",
  "onboarding-app-too-old",
  "onboarding-hub-too-old",
  "projects-errors",
  "projects-machines",
  // F5: the inbox with the open-asks read refused.
  "inbox-error",
  // F6: the Status view's own states (fixtures/status).
  "status-stale",
  "status-planning",
  "status-skeleton",
  // E3b's shared stress fixture; the time inspector fills it with a ~15k-span order (fixtures/time).
  "time-heavy",
  "conversation-20k",
  "order-told-overrides",
  // F4: every steering state (fixtures/order).
  "order-steering",
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
  // The route is meant to land on an error or not-found state ("<id>.error"). Without this, such a state fails the
  // test: a route to a missing entity would otherwise check an empty error page and pass.
  expect?: "error";
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
  // F1: the frame (top bar, sidebar of projects) around #/, which opens the last project's chat (the first one on a
  // fresh install), and the connection states it shows. With no projects, #/ offers to add one (home.empty).
  {
    id: "shell",
    route: "#/",
    fixtures: ["empty", "typical", "many-agents", "long-text", "hub-unreachable", "pairing-failed", "node-too-old"],
  },
  { id: "home.empty", route: "#/", fixtures: ["empty"] },
  // F10: connecting to a hub, one fixture per state (fixtures/onboarding). The form: no hub here, a hub found, a
  // refused key, app-pair.json used up / expired / untrusted, a rate limit, an unreadable saved key and a key that
  // would be kept in a file. #/onboarding?key opens on the key path; a fleetd://pair link lands with ?hub=&code=.
  {
    id: "onboarding",
    route: "#/onboarding",
    fixtures: [
      "pairing-failed",
      "onboarding-first-run",
      "onboarding-local-hub",
      "onboarding-app-pair",
      "onboarding-app-pair-expired",
      "onboarding-app-pair-untrusted",
      "onboarding-rate-limited",
      "onboarding-unreadable-key",
      "onboarding-file-store",
    ],
  },
  { id: "onboarding.key", route: "#/onboarding?key", fixtures: ["pairing-failed", "onboarding-file-store"] },
  {
    id: "onboarding",
    route: "#/onboarding?hub=http%3A%2F%2Fbuildbox%3A4790&code=WXYZ-6789",
    fixtures: ["onboarding-link"],
    sizes: ["small"],
  },
  // Reaching a saved hub: the words for a refused connect and an unknown name. (A first attempt can't be shot: the
  // harness first settles on #/, whose sidebar stays busy while a connection is on its way.)
  { id: "onboarding.connecting", route: "#/onboarding", fixtures: ["hub-unreachable", "onboarding-not-found"] },
  // A hub on another protocol, either way round.
  { id: "onboarding.mismatch", route: "#/onboarding", fixtures: ["onboarding-app-too-old", "onboarding-hub-too-old"] },
  // F5: the inbox panel with every ask shape (needs-you), the long-text stress ask, and nothing to answer.
  { id: "inbox", route: "#/board?inbox", fixtures: ["needs-you", "long-text", "empty"], pending: "the lead chat removed the inbox (A1); F5 deletes it (A5)" },
  // The answering flow, as the fixture's hub plays it (ask.answered, then ask.delivered once the undo window has
  // passed): the first question collapses to "You chose" with the 10 s Undo and every count drops at once; the
  // approval (no undo window) shows its receipt at once; then the first one's receipt arrives. Shot at the end.
  {
    id: "inbox.answered",
    route: "#/board?inbox&ask=A1",
    pending: "the lead chat removed the inbox (A1); F5 deletes it (A5)",
    fixtures: ["needs-you"],
    open: async (page) => {
      await page.keyboard.press("1");
      await page.keyboard.press("Enter");
      // The board shows the same cards; the panel's are the ones answered here.
      const panel = page.getByRole("complementary", { name: "Needs you" });
      const first = panel.getByRole("region", { name: /You chose: Public snapshot link/u });
      await first.getByText(/You can undo this for \d+ s/u).waitFor();
      // The stale-badge bug: the title-bar badge and the board's Needs you must both say 5 now, not 6.
      const badge = (n: number) => page.getByRole("button", { name: /need you/u }).filter({ hasText: new RegExp(`^${String(n)} need you`, "u") });
      const board = (n: number) => page.getByText(new RegExp(`^Needs you ${String(n)}$`, "u"));
      await badge(5).waitFor({ timeout: 3_000 });
      await board(5).waitFor({ timeout: 3_000 });
      const approval = panel.getByRole("region", { name: /database migration/u });
      await approval.getByRole("radio", { name: /Approve/u }).click();
      await approval.getByRole("button", { name: /Send answer/u }).click();
      await badge(4).waitFor({ timeout: 3_000 });
      await board(4).waitFor({ timeout: 3_000 });
      await panel.getByRole("region", { name: /You chose: Approved/u }).getByText(/The lead has your answer/u).waitFor();
      await first.getByText(/The lead has your answer/u).waitFor({ timeout: 15_000 });
    },
  },
  // The open-asks read refused: the reason, the hub's fix and Retry; the badge is plain "Inbox", not loading.
  { id: "inbox.error", route: "#/board?inbox", fixtures: ["inbox-error"], expect: "error", pending: "the lead chat removed the inbox (A1); F5 deletes it (A5)" },
  // F2: the board (#/ and #/board). board.empty, board.list, board.stage and board.finish are its states: the stage
  // and finish fixtures put one order on it mid-run and after every PR merged.
  {
    id: "board",
    route: "#/board",
    pending: "the lead chat removed the board as a surface (A1); F2 deletes it (A4)",
    // hub-unreachable: the composer shows main's reason and fix for a lost hub, so their wording is seen and checked.
    fixtures: ["empty", "typical", "long-text", "many-agents", "needs-you", "board-stage", "board-finish", "hub-unreachable"],
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
      await page.locator('[role="progressbar"][aria-valuenow="42"]').waitFor();
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
    // The error state is the point: a clone refused because its folder exists, offering to add that folder.
    expect: "error",
    open: async (page) => {
      await page.getByRole("listbox", { name: "Repos" }).waitFor();
      await page.getByRole("textbox", { name: "GitHub URL, folder path, or filter" }).fill("acme/ledger-ui");
      await page.keyboard.press("Enter");
    },
  },
  { id: "machines", route: "#/machines", fixtures: ["typical", "empty", "long-text", "many-agents", "hub-unreachable", "projects-machines"] },
  // F11: the command palette (projects first, then go-tos), a typed search, and the shortcuts sheet.
  {
    id: "palette",
    route: "#/",
    fixtures: ["typical", "long-text", "empty", "many-prompts"],
    open: (page) => page.keyboard.press("ControlOrMeta+K"),
  },
  {
    id: "palette.search",
    route: "#/",
    fixtures: ["typical", "long-text", "empty"],
    open: async (page) => {
      await page.keyboard.press("ControlOrMeta+K");
      await page.getByRole("combobox", { name: "Search" }).fill("st");
    },
  },
  { id: "shortcuts", route: "#/", fixtures: ["typical"], open: (page) => page.keyboard.press("ControlOrMeta+Slash") },
  // F9: Settings. Prompts opens on the lead's first message, the longest text; many-prompts lists 72 with long
  // keys and titles; settings-prompts is the real registry with edits. Compare and Update are deep links.
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
  // F6: Status, one row per project: every state word, long titles, no projects, quiet sources, every lead
  // planning, the skeleton before the first answer, and the link down.
  {
    id: "status.fleet",
    route: "#/status",
    fixtures: ["typical", "long-text", "empty", "many-agents", "hub-unreachable", "status-stale", "status-planning", "status-skeleton"],
  },
  // F7: the time inspector (fixtures/time): an order's timeline, ~15k spans in time-heavy; the fleet's breakdown;
  // its insights. Each tab's root carries its own id, so the three are shot apart.
  {
    id: "time.timeline",
    route: "#/time/order/W8",
    fixtures: ["typical", "long-text", "many-agents", "time-heavy", "empty"],
  },
  {
    id: "time.breakdown",
    route: "#/time",
    fixtures: ["typical", "long-text", "empty"],
  },
  // With no hub, the breakdown says so in words (time.breakdown.offline): a connection state, not an error page.
  { id: "time.breakdown", route: "#/time", fixtures: ["hub-unreachable"] },
  // The harness waits for the id before `open`, so the insights entry waits for the screen root, then opens the tab.
  {
    id: "time",
    route: "#/time",
    fixtures: ["typical", "long-text", "empty"],
    open: (page) => page.getByRole("tab", { name: "Insights" }).click(),
  },
];

// Platform checks that need a screen writer's work before they can pass; the owner turns theirs on when it lands.
export const platformChecks: Record<"appMenu", boolean> = {
  // F1: the macOS app menu, with an Edit menu wired to the text actions.
  appMenu: true,
};

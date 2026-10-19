// THE screen registry: every screen × fixture the QA gate shoots and checks. A screen PR adds its screens here; the
// suite then covers them at every size and theme on Linux and macOS, and any finding fails the PR.
//
// To register a screen (routes and ids: F1's route table, src/renderer/screens/shell/routes.ts):
//   1. The screen's root carries data-screen="<id>", or "<id>.<state>" for a sub-state such as "chat.loading"; the
//      harness waits for either.
//   2. Add an entry below: the id, the hash route that shows it, and the fixtures it must survive: the stress
//      fixtures that touch its data (long-text, many-*), plus empty and the error states it renders.
//      A screen whose route ends on an error or not-found state ("<id>.error", "<id>.not-found") fails, unless
//      the entry says `expect: "error"`; register error fixtures as a separate entry with that field.
//   3. A screen with no route of its own gets `open`, using keys, roles and labels rather than CSS classes:
//        { id: "palette", route: "#/", fixtures: ["typical"], open: (page) => page.keyboard.press("ControlOrMeta+K") }
//        { id: "chat", route: "#/project/devbox/storefront", fixtures: ["chat-strip"], variant: "strip-open",
//          open: (page) => page.getByRole("button", { name: /agents? working/u }).first().click() }
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
  "hub-unreachable",
  "pairing-failed",
  "node-too-old",
  // F9: the whole real prompt registry, with edits, a project's own texts and a default changed under an edit.
  "settings-prompts",
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
  // F6: the Status view's own states (fixtures/status).
  "status-stale",
  "status-planning",
  "status-legacy",
  "status-skeleton",
  // E3b's shared stress fixture; the time inspector fills it with a ~15k-span order (fixtures/time).
  "time-heavy",
  // The lead chat (fixtures/chat, E3b): a long conversation with migrated order history, a reply streaming in,
  // attachments, the two inline items (secret entry, gated command), a 20-agent strip with PR and merge one-liners,
  // the lead waiting on you, and a project with no messages yet.
  "chat-long",
  "chat-streaming",
  "chat-attachments",
  "chat-secret",
  "chat-gated",
  "chat-strip",
  "chat-waiting",
  "chat-empty",
  // F6: Status as one row per project (fixtures/status). F9: the max-agents slider at its cap with work queued.
  "status-rows",
  "chat-max-agents",
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
  // Tells apart two entries for one screen on the same fixture (say, a strip folded and opened): it joins the id in
  // the test title and the file names.
  variant?: string;
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

/** An entry's name in test titles, shot files and the contact sheet. */
export const label = (s: Pick<Screen, "id" | "variant">) => (s.variant === undefined ? s.id : `${s.id}~${s.variant}`);

export const screens: readonly Screen[] = [
  // E0/F1: the frame (top bar, sidebar) around the default route, and the connection states it shows.
  {
    id: "shell",
    route: "#/",
    fixtures: ["empty", "typical", "many-agents", "long-text", "hub-unreachable", "pairing-failed", "node-too-old"],
  },
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
    fixtures: ["long-text", "empty"],
    open: async (page) => {
      await page.keyboard.press("ControlOrMeta+K");
      await page.getByRole("combobox", { name: "Search or reply" }).fill("1 go 2 nvm 3 b");
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
  // F6: Status for the fleet, a project and an order: live, stale sources, planning, long text and unknown wire
  // values, a hub without the progress model, the skeleton before the first answer, and the link down. F6's one-list
  // Status (below) replaces these.
  ...(
    [
      ["status.fleet", "#/status"],
      ["status.project", "#/status/project/devbox/storefront"],
      ["status.order", "#/status/order/W1"],
    ] as const
  ).map(([id, route]) => ({
    id,
    route,
    fixtures: ["typical", "long-text", "empty", "hub-unreachable", "status-stale", "status-planning", "status-legacy", "status-skeleton"] as const,
  })),
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
  // The lead chat (lead-chat-spec.md). Registered ahead of the slices, each pending until its writer lands it and
  // deletes `pending` (check the id, route and open step then). The project is the fixtures' devbox/storefront.
  // A1 (F1): the sidebar's needs-you dot and running indicator, around the remembered project's chat.
  {
    id: "shell",
    route: "#/",
    fixtures: ["chat-waiting", "chat-strip", "chat-empty"],
    pending: "A1 frame (F1) and fixtures/chat (E3b)",
  },
  // A2/A3 (F3, F4): the conversation and its composer: Markdown, paging through a long history with the migrated
  // orders, a reply streaming in, attachments, the lead waiting on you, a first message, and the link down.
  {
    id: "chat",
    route: "#/project/devbox/storefront",
    fixtures: ["chat-long", "chat-streaming", "chat-attachments", "chat-waiting", "chat-empty", "typical", "long-text", "empty", "hub-unreachable"],
    pending: "A2 messages (F3), A3 composer (F4) and fixtures/chat (E3b)",
  },
  // A5 (F5): the two inline items: the masked secret field, and the exact gated command with Approve / Deny.
  {
    id: "chat",
    route: "#/project/devbox/storefront",
    fixtures: ["chat-secret", "chat-gated", "long-text"],
    variant: "inline",
    pending: "A5 inline secret and gated command (F5) and fixtures/chat (E3b)",
  },
  // A4 (F2): the live strip under the lead's message, 20 agents with PR and merge one-liners; then expanded to its
  // lanes.
  {
    id: "chat",
    route: "#/project/devbox/storefront",
    fixtures: ["chat-strip", "many-agents"],
    variant: "strip",
    pending: "A4 live strip (F2)",
  },
  {
    id: "chat",
    route: "#/project/devbox/storefront",
    fixtures: ["chat-strip", "many-agents", "long-text"],
    open: (page) => page.getByRole("button", { name: /agents? working/u }).first().click(),
    variant: "strip-open",
    pending: "A4 live strip (F2): confirm the expand control's name",
  },
  // A9 (F9): Max agents, in the chat header and in Settings, at its cap with work queued (the fixture waits on CAP's
  // contract).
  {
    id: "chat",
    route: "#/project/devbox/storefront",
    fixtures: ["chat-max-agents", "long-text"],
    open: (page) => page.getByRole("button", { name: /Max agents/u }).first().click(),
    variant: "max-agents",
    pending: "A9 Max agents slider (F9): confirm the header control's name",
  },
  {
    id: "settings.general",
    route: "#/settings/general",
    fixtures: ["chat-max-agents", "long-text"],
    variant: "max-agents",
    pending: "A9 Max agents slider (F9)",
  },
  // A6 (F6): Status as one row per project (state word, two-tone bar, agents running, last merged); it replaces the
  // status.* entries above.
  {
    id: "status",
    route: "#/status",
    fixtures: ["status-rows", "typical", "long-text", "empty", "hub-unreachable"],
    pending: "A6 status rows (F6)",
  },
];

// Platform checks that need a screen writer's work before they can pass; the owner turns theirs on when it lands.
export const platformChecks: Record<"appMenu", boolean> = {
  // F1: the macOS app menu, with an Edit menu wired to the text actions.
  appMenu: true,
};

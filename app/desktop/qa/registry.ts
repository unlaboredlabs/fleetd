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
//      Two entries for one screen on the same fixture (a strip folded and opened) need a `variant` apiece.
// Fixtures are E3b's, built by `pnpm fixtures` into app/desktop/fixtures/<name>.json.
// Run it locally: `pnpm fixtures && pnpm qa:build && pnpm qa` (QA_SCREENS=<id>,<id> to limit), then open
// qa-results/index.html.

import { expect, type Page } from "@playwright/test";
import { CHAT_SENDS } from "../fixtures/composer/sends.ts";

/** A 1×1 PNG, for the composer's attach step. */
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64");

export const fixtures = [
  "empty",
  "typical",
  "long-text",
  "many-prompts",
  "many-agents",
  "conversation",
  "hub-unreachable",
  "pairing-failed",
  "node-too-old",
  // F9: the whole real prompt registry, with edits, a project's own texts and a default changed under an edit.
  "settings-prompts",
  "settings-agents",
  // F2: the lead chat's live strip with 0, 3 and 20 agents at work (fixtures/live).
  "live-0",
  "live-3",
  "live-20",
  // F4: the chat composer's sends (fixtures/composer).
  "composer-sends",
  "composer-waiting",
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
  // F6: the Status view's own states (fixtures/status), and E3b's eight-project mix (all four words, planning,
  // stale, a ~120-character name).
  "status-rows",
  "status-stale",
  "status-planning",
  "status-skeleton",
  // E3b's shared stress fixture; the time inspector fills it with a ~15k-span order (fixtures/time).
  "time-heavy",
  "conversation-20k",
  // The lead chat (fixtures/chat, E3b): a long conversation with migrated order history, a reply streaming in,
  // attachments, the two inline items (secret entry, gated command), the lead waiting on you, a first message.
  "chat-long",
  "chat-streaming",
  "chat-attachments",
  "chat-secret",
  "chat-gated",
  "chat-waiting",
  "chat-empty",
  // F5 (A5): a chat with every state of the two inline items (fixtures/inline).
  "inline-items",
] as const;
export type FixtureName = (typeof fixtures)[number];

export const sizes = {
  small: { width: 1024, height: 700 },
  medium: { width: 1400, height: 900 },
  large: { width: 1920, height: 1200 },
  // The smallest window (main/index.ts): the sidebar has hidden itself. Shot only where an entry asks for it.
  narrow: { width: 900, height: 600 },
  // The macOS window shot: wide enough to keep the sidebar, short enough for the smallest runner's screen once the
  // menu bar and the Dock are off it (1024×768 leaves 680 px).
  window: { width: 1024, height: 640 },
} as const;
export type SizeName = keyof typeof sizes;
/** What an entry without `sizes` is shot at. */
export const defaultSizes: readonly SizeName[] = ["small", "medium", "large"];

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

// The fixtures' storefront project, a real hub project from the sanitized recording, so its id is a UUID; it shows
// only in the route, never as text.
const CHAT = "#/project/devbox/dcffccea-c5a7-40a6-940d-7f70239ffa22";

/** An entry's name in test titles, shot files and the contact sheet. */
export const label = (s: Pick<Screen, "id" | "variant">) => (s.variant === undefined ? s.id : `${s.id}~${s.variant}`);

export const screens: readonly Screen[] = [
  // F2 (A4): the live strip under the lead's latest message, in the project's chat. live-0 draws no strip.
  {
    id: "chat",
    route: CHAT,
    fixtures: ["live-0", "live-3", "live-20"],
    variant: "strip",
  },
  // F4 (A3): the composer under storefront's chat while the lead works. Sent from the box: refused (Resend, Edit,
  // Dismiss), cut off by the link, unanswered (Resend, Dismiss), and one still sending; then a message that found no
  // hub, back in the box with the reason, and a file attached beside it. composer-waiting: the hub stored the
  // message, but the lead can't take it yet, and says why.
  { id: "chat", route: CHAT, fixtures: ["composer-sends"] },
  {
    id: "chat.composer",
    route: CHAT,
    fixtures: ["composer-sends"],
    open: async (page) => {
      await page.locator('[data-screen="chat"]').waitFor({ timeout: 30_000 });
      const box = page.getByRole("textbox", { name: "Message the lead" });
      for (const text of [CHAT_SENDS.refused, CHAT_SENDS.cutOff, CHAT_SENDS.unanswered, CHAT_SENDS.sending]) {
        await box.fill(text);
        await box.press("Enter");
        await expect(box).toHaveValue("");
      }
      await expect(page.locator('[data-receipt="failed"]')).toHaveCount(1);
      await expect(page.locator('[data-receipt="unanswered"]')).toHaveCount(1);
      await box.fill(CHAT_SENDS.offline);
      await box.press("Enter");
      await expect(page.getByText("Not connected to the hub, so this wasn’t sent.")).toBeVisible();
      await page.locator('[data-composer] input[type="file"]').setInputFiles({ name: "checkout-error.png", mimeType: "image/png", buffer: PNG });
      await expect(page.getByText(/checkout-error\.png · \d+ B/)).toBeVisible();
    },
  },
  {
    id: "chat.composer",
    route: CHAT,
    fixtures: ["composer-waiting"],
    open: async (page) => {
      await page.locator('[data-screen="chat"]').waitFor({ timeout: 30_000 });
      const box = page.getByRole("textbox", { name: "Message the lead" });
      await box.fill(CHAT_SENDS.waiting);
      await box.press("Enter");
      await expect(page.getByText(/the lead doesn’t have it yet/)).toBeVisible();
    },
  },
  // ...and opened to its lanes.
  {
    id: "chat",
    route: CHAT,
    // The expand control is the strip's header button, named by its headline ("18 agents working · 1 needs you ·
    // 1 queued"); scoped to the strip, since the sidebar's project button also says "3 agents working". long-text has
    // no agent at work in this project, so it has no strip; live-20 carries the long commands and paths.
    fixtures: ["live-3", "live-20"],
    open: (page) =>
      page.getByRole("region", { name: /agents? working/u }).getByRole("button", { name: /agents? working/u, expanded: false }).click(),
    variant: "strip-open",
  },
  // The lead chat (lead-chat-spec.md), registered ahead of its slices, each pending until its writer lands it and
  // deletes `pending` (check the id, route and open step then).
  // A1 (F1): the sidebar's needs-you dot and running indicator around the remembered project's chat, and on Status
  // with status-rows (eight projects mixing both marks, neither, and a ~120-character name; only some have chats, so
  // it is shot beside Status rather than a chat).
  {
    id: "shell",
    route: "#/",
    fixtures: ["chat-waiting", "live-20", "chat-empty"],
    variant: "chat",
  },
  { id: "shell", route: "#/status", fixtures: ["status-rows"], variant: "sidebar" },
  // The smallest window: the sidebar has hidden itself, its toggle and the chat's title share the top row.
  { id: "shell", route: "#/", fixtures: ["chat-waiting", "long-text"], variant: "narrow", sizes: ["narrow"] },
  // ...and shown again with the toggle at that width, the chat beside it.
  {
    id: "shell",
    route: "#/",
    fixtures: ["chat-waiting", "long-text"],
    variant: "narrow-open",
    sizes: ["narrow"],
    open: async (page) => {
      // The toggle shows it for the width it is pressed at, so narrow the page first (the size the suite sets next).
      const session = await page.context().newCDPSession(page);
      const deviceScaleFactor = await page.evaluate(() => window.devicePixelRatio);
      await session.send("Emulation.setDeviceMetricsOverride", { ...sizes.narrow, deviceScaleFactor, mobile: false });
      await page.getByRole("button", { name: "Show the sidebar" }).click();
      await page.getByRole("navigation", { name: "Sidebar" }).waitFor();
    },
  },
  // A2/A3 (F3, F4): the conversation and its composer: Markdown, paging through a long history with the migrated
  // orders, a reply streaming in, attachments, the lead waiting on you, a first message, and the link down.
  {
    id: "chat",
    route: CHAT,
    fixtures: ["chat-long", "chat-streaming", "chat-attachments", "chat-waiting", "chat-empty", "typical", "long-text", "hub-unreachable"],
  },
  // The top of a long chat: scrolled back through every page to the past orders the migration reads back ("From
  // before this chat"), so that history is rendered and checked too, not only the newest page.
  {
    id: "chat",
    route: CHAT,
    fixtures: ["chat-long"],
    variant: "history",
    open: async (page) => {
      const log = page.getByLabel("Conversation with the lead");
      const start = page.getByText("This is the start of the conversation.");
      for (let i = 0; i < 30 && !(await start.isVisible()); i++) {
        // A wheel releases the chat's pin to the newest message; then each top reached loads the page before it.
        await log.hover();
        await page.mouse.wheel(0, -50_000);
        await log.evaluate((el) => el.scrollTo({ top: 0 }));
        await page.getByText("Loading earlier messages…").waitFor({ state: "hidden", timeout: 5_000 });
      }
      await page.getByText("From before this chat").waitFor({ timeout: 10_000 });
    },
  },
  // A link to a project the hub doesn't have (here, a hub with none): says so, rather than loading forever.
  { id: "chat", route: CHAT, fixtures: ["empty"], variant: "missing", expect: "error" },
  // A5 (F5): the two inline items, every state: the masked secret field (and saved, withdrawn), the exact command
  // with Approve / Deny (and ran, failed, open again after the node was offline, a denied tool permission, running).
  { id: "chat", route: CHAT, fixtures: ["inline-items"], variant: "inline" },
  // ...and E3b's own chat fixtures with an item in a longer conversation.
  {
    id: "chat",
    route: CHAT,
    fixtures: ["chat-secret", "chat-gated", "long-text"],
    variant: "inline-chat",
  },
  // A9 (F9): Max agents in the chat header, at the cap with work queued (Settings has it under settings.agents).
  {
    id: "chat",
    route: CHAT,
    fixtures: ["settings-agents", "long-text"],
    // The header control's accessible name is "Max agents: <running> running of <max>[, <n> waiting]".
    open: (page) => page.getByRole("button", { name: /^Max agents: \d+ running of \d+/u }).click(),
    variant: "max-agents",
  },
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
  // F11: the command palette (projects first, then go-tos), a typed search, and the shortcuts sheet. status-rows
  // has eight projects, one with a ~120-character name.
  {
    id: "palette",
    route: "#/",
    fixtures: ["typical", "long-text", "empty", "many-prompts", "status-rows"],
    open: (page) => page.keyboard.press("ControlOrMeta+K"),
  },
  {
    id: "palette.search",
    route: "#/",
    fixtures: ["typical", "long-text", "empty", "status-rows"],
    open: async (page) => {
      await page.keyboard.press("ControlOrMeta+K");
      await page.getByRole("combobox", { name: "Search" }).fill("st");
    },
  },
  { id: "shortcuts", route: "#/", fixtures: ["typical"], open: (page) => page.keyboard.press("ControlOrMeta+Slash") },
  // F9: Settings. Prompts opens on the lead's first message, the longest text; many-prompts lists 72 with long
  // keys and titles; settings-prompts is the real registry with edits. Compare and Update are deep links.
  // Max agents: the fleet cap and each project's slider.
  { id: "settings.agents", route: "#/settings/agents", fixtures: ["settings-agents", "long-text", "empty", "hub-unreachable"] },
  { id: "settings.general", route: "#/settings/general", fixtures: ["typical", "empty", "hub-unreachable"] },
  // Notifications: the kinds, sound, the Dock badge, and the line after a test was sent.
  { id: "settings.notifications", route: "#/settings/notifications", fixtures: ["typical"] },
  {
    id: "settings.notifications",
    route: "#/settings/notifications",
    fixtures: ["typical"],
    variant: "test-sent",
    open: async (page) => {
      await page.getByRole("button", { name: "Send a test notification" }).click();
      await page.getByRole("status").filter({ hasText: /Sent|doesn’t show/u }).waitFor();
    },
  },
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
    fixtures: ["typical", "status-rows", "long-text", "empty", "many-agents", "hub-unreachable", "status-stale", "status-planning", "status-skeleton"],
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

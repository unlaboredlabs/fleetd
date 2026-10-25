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

import { type ElectronApplication, expect, type Locator, type Page } from "@playwright/test";
import { AGENT_ROUTE } from "../fixtures/agents/route.ts";
import { STEER_WORDS } from "../fixtures/agents/steers.ts";
import { CHAT_SENDS } from "../fixtures/composer/sends.ts";
import { OFFLINE_SENDS } from "../fixtures/offline/sends.ts";

/**
 * What the system answers when the app posts a notification: shown, or not supported. Nothing reaches the screen of
 * the machine running QA either way.
 */
const systemNotifications = (app: ElectronApplication, supported: boolean) =>
  app.evaluate(({ Notification }, ok) => {
    Notification.isSupported = () => ok;
    Notification.prototype.show = () => undefined;
  }, supported);

/** A 1×1 PNG, for the composer's attach step. */
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64");

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
  "settings-agents",
  // ...with storefront's medium switch off (fixtures/settings).
  "settings-medium-off",
  // F2: the lead chat's live strip with 0, 3 and 20 agents at work (fixtures/live).
  "live-0",
  "live-3",
  "live-20",
  // F4: the chat composer's sends (fixtures/composer).
  "composer-sends",
  "composer-waiting",
  // The lead mid-turn: the quiet line under its reply counts up and says what it does now and what the turn did; and
  // once it's over, how long it worked (fixtures/lead).
  "lead-planning",
  "lead-long",
  "lead-counting",
  "lead-worked",
  // Group fixtures (fixtures/<group>/index.ts), named <group>-<what>.
  "projects-cloning",
  "projects-dropped",
  // F10: the connect screen's states (fixtures/onboarding).
  "onboarding-first-run",
  "onboarding-code-refused",
  "onboarding-setup-terminal",
  "onboarding-first-chat",
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
  // F6: the Status view's own states (fixtures/status), and E3b's eight-project mix (all four words, stale, a
  // ~120-character name).
  "status-rows",
  "status-stale",
  "status-skeleton",
  // The bar's hover on a figure that holds while its work is paused (fixtures/status).
  "status-paused",
  // E3b's shared stress fixture; the time inspector fills it with a ~15k-span order (fixtures/time).
  "time-heavy",
  // The Factory (fixtures/factory): a repo whose reads fail beside one on a plain git host, and a range with no merges.
  "factory-stale",
  "factory-none",
  // The lead chat (fixtures/chat, E3b): a long conversation with migrated order history, a reply streaming in,
  // attachments, the two inline items (secret entry, gated command), the lead waiting on you, a first message.
  "chat-long",
  "chat-streaming",
  "chat-attachments",
  "chat-secret",
  "chat-gated",
  "chat-waiting",
  "chat-empty",
  // The long chat with three lead replies arriving once you've read back a page (fixtures/transcript).
  "transcript-new",
  // UX-1 [23]: a long lead reply streaming in, in small deltas (fixtures/stream).
  "stream-long",
  // The chat as a messaging app (fixtures/bubbles): split bubbles with a reply, charts and a table, a PR card with its
  // diff, and the lead asking.
  "bubbles-casual",
  "bubbles-charts",
  "bubbles-pr",
  "bubbles-ask",
  // F5 (A5): a chat with every state of the two inline items (fixtures/inline), with every answer failing, and with
  // two approvals the hub reopens after Approve.
  "inline-items",
  "inline-failures",
  "inline-reopened",
  // UX-1 A3: the PR list and PR view (fixtures/prs): no PRs, the reads on their way, GitHub out of reach, GitHub's
  // rate limit reached, a PR that fails to load, and a PR of 240 files with a 3,000-line file.
  "prs-none",
  "prs-loading",
  "prs-no-github",
  "prs-rate-limited",
  "prs-error",
  "prs-heavy",
  // UX-1: the sidebar's reasons and a new reply (fixtures/sidebar); one agent's live work (fixtures/agents).
  "sidebar-reasons",
  "agents-work",
  // ...with its steers that ended otherwise: never replied to, withdrawn, failed (fixtures/agents).
  "agents-steers",
  // UX [7]: no hub, and the last launch's disk cache on screen with a message queued; back online with that chat not
  // read again yet, and with that read failed (fixtures/offline).
  "offline-held",
  "offline-reread",
  "offline-reread-failed",
  // ...and the inline items' chat from the cache, with no hub (fixtures/inline).
  "inline-offline",
  // The sequences that blanked the window (fixtures/resilience): a hub restart mid-chat, a burst of plan items with
  // a new reply streaming, and the link dropping mid-reply.
  "resilience-burst",
  "resilience-hub-restart",
  "resilience-reconnect-streaming",
  // C1: the app's own update and the hub's (fixtures/updates).
  "updates-idle",
  "updates-checking",
  "updates-unsupported",
  "updates-current",
  "updates-available",
  "updates-downloading",
  "updates-ready",
  "updates-deb",
  "updates-failed",
  "updates-download-failed",
  "updates-hub-current",
  "updates-hub-unknown",
  "updates-hub-available",
  "updates-hub-behind",
  "updates-hub-behind-local",
  "updates-hub-behind-local-channel",
  "updates-hub-info-failed",
  "updates-terminal-not-local",
  "updates-terminal-not-found",
  "updates-terminal-no-terminal",
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
  // Brings up a screen that has no route of its own; runs after the route has loaded. `app` reaches the main process,
  // for what only it decides (whether the system shows notifications).
  open?: (page: Page, app: ElectronApplication) => Promise<void>;
  // Tells apart two entries for one screen on the same fixture (say, a strip folded and opened): it joins the id in
  // the test title and the file names.
  variant?: string;
  // The route is meant to land on an error or not-found state ("<id>.error"). Without this, such a state fails the
  // test: a route to a missing entity would otherwise check an empty error page and pass. "card": an error card
  // (src/renderer/src/Boundary.tsx) is the point; every other entry fails while one is up, or the window is blank.
  expect?: "error" | "card";
  // Once the screen is up, plays the fixture's timeline again with it open (the app opens on another project), and
  // checks the screen after the last frame: for sequences such as a hub restart mid-chat (fixtures/resilience).
  replay?: true;
  // Runs on the real clock, not the fixture's fixed one. Playwright's fake clock formats an invalid date as now
  // (Intl.DateTimeFormat#format(NaN)), where the real one throws: a crash that blanked the window hid behind it.
  realClock?: true;
}

// The fixtures' storefront project, a real hub project from the sanitized recording, so its id is a UUID; it shows
// only in the route, never as text.
const CHAT = "#/project/devbox/dcffccea-c5a7-40a6-940d-7f70239ffa22";

/** Makes a part throw while rendering, in the QA build (src/renderer/src/Boundary.tsx), so its error card shows. */
const crash = (part: string) => async (page: Page) => {
  await page.evaluate((p) => window.dispatchEvent(new CustomEvent("fleetd:qa-crash", { detail: p })), part);
};

/** The updates sheet, as the palette's "Check for updates" opens it (the app menu runs the same command). */
const openUpdates = async (page: Page) => {
  await page.keyboard.press("ControlOrMeta+K");
  await page.getByRole("combobox", { name: "Search" }).fill("Check for updates");
  await page.keyboard.press("Enter");
};

// storefront's PRs in the panel beside its chat (fixtures/prs): the list, and #11 (in review, its reviewers at work),
// #10 (checks failed), #8 (merged), #14 (a person's, review asked for) and #13 (240 files) open.
const PRS = `${CHAT}/prs`;
const PR = (n: number) => `${PRS}/acme/storefront/${String(n)}`;
const openChanges = (page: Page) => page.getByRole("tab", { name: /^Changes/u }).click();
/**
 * The PR reads still on their way (prs-loading never answers them). The gate waits out busy regions before it
 * shoots, so the entry reaches the screen from a settled one, waits for the placeholder and then lifts its busy flag:
 * the shot is what you see while the hub answers.
 */
const whileLoading = (go: (page: Page) => Promise<void>, shown: (page: Page) => Locator) => async (page: Page) => {
  await go(page);
  await shown(page).first().waitFor({ timeout: 10_000 });
  await page.evaluate(() => {
    for (const el of document.querySelectorAll("[aria-busy='true']")) el.removeAttribute("aria-busy");
  });
};

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
  // hub, queued to go when the link is back, and a file attached beside it. composer-waiting: the hub stored the
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
      await expect(page.locator('[data-receipt="queued"]')).toHaveCount(1);
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
  // Stop beside Send while the lead works, pressed: the hub's answer is still on its way.
  {
    id: "chat.composer",
    route: CHAT,
    fixtures: ["composer-sends"],
    variant: "stopping",
    open: async (page) => {
      await page.locator('[data-screen="chat"]').waitFor({ timeout: 30_000 });
      await page.getByRole("button", { name: "Stop the lead and its agents" }).click();
      await expect(page.getByRole("button", { name: "Stopping the lead and its agents" })).toBeDisabled();
      await expect(page.getByText("Stopping the lead and its agents…")).toBeVisible();
    },
  },
  // ⌘Enter while the lead works: a chat message like any other, its receipt saying it stopped the lead's step.
  {
    id: "chat.composer",
    route: CHAT,
    fixtures: ["composer-sends"],
    variant: "steer-now",
    open: async (page) => {
      await page.locator('[data-screen="chat"]').waitFor({ timeout: 30_000 });
      const box = page.getByRole("textbox", { name: "Message the lead" });
      await expect(page.getByText(/stops its step and sends now/)).toBeVisible();
      await box.fill(CHAT_SENDS.now);
      await box.press("ControlOrMeta+Enter");
      await expect(box).toHaveValue("");
      const mine = page.locator('[data-entry="message"]').filter({ hasText: CHAT_SENDS.now });
      await expect(mine.getByText("delivered; the lead stopped its step to read this")).toBeVisible();
    },
  },
  // ↑ in the empty box brings back your last message.
  {
    id: "chat.composer",
    route: CHAT,
    fixtures: ["composer-sends"],
    variant: "recall",
    open: async (page) => {
      await page.locator('[data-screen="chat"]').waitFor({ timeout: 30_000 });
      const box = page.getByRole("textbox", { name: "Message the lead" });
      await expect(box).toBeFocused();
      await box.press("ArrowUp");
      await expect(box).toHaveValue("1 yes, 2 literal");
    },
  },
  // The lead at work: under its reply, how long it has worked, what it is doing now and what its turn did so far;
  // lead-long wraps, lead-counting only counts; lead-worked: the turn is over, and the line says how long it took.
  { id: "chat", route: CHAT, fixtures: ["lead-planning", "lead-long", "lead-counting", "lead-worked"], variant: "activity" },
  // The line above the box says what the lead waits on, and Show brings the open approval into view.
  {
    id: "chat",
    route: CHAT,
    fixtures: ["chat-gated"],
    variant: "show-waiting",
    open: async (page) => {
      await page.locator('[data-screen="chat"]').waitFor({ timeout: 30_000 });
      await expect(page.getByText("1 command to approve")).toBeVisible();
      await page.locator("[data-attention]").getByRole("button", { name: "Show" }).click();
      await expect(page.getByRole("button", { name: "Approve", exact: true })).toBeInViewport();
    },
  },
  // A blocked project: the line above the box says why, in the hub's words (checkout's main CI is red).
  {
    id: "chat",
    route: "#/project/devbox/6e8e753c-fe9a-4b79-aec3-5812d498c197",
    fixtures: ["sidebar-reasons"],
    variant: "blocked",
    open: async (page) => {
      await page.locator('[data-screen="chat"]').waitFor({ timeout: 30_000 });
      await expect(page.locator('[data-attention="blocked"]')).toHaveText("Blocked: main CI is red on acme/checkout");
    },
  },
  // An empty chat's starter fills the box (never sends) and gives it the cursor.
  {
    id: "chat",
    route: CHAT,
    fixtures: ["chat-empty"],
    variant: "starter",
    open: async (page) => {
      await page.locator('[data-screen="chat"]').waitFor({ timeout: 30_000 });
      await page.getByRole("button", { name: "Explain how this project is put together." }).click();
      const box = page.getByRole("textbox", { name: "Message the lead" });
      await expect(box).toHaveValue("Explain how this project is put together.");
      await expect(box).toBeFocused();
    },
  },
  // UX [7]: offline, the chat and the project list from the disk cache, marked offline as of the cache's time, with
  // the banner's Retry now; then a message typed offline joins the one already queued, each with Edit and Dismiss.
  { id: "chat", route: CHAT, fixtures: ["offline-held"], variant: "offline" },
  {
    id: "chat.composer",
    route: CHAT,
    fixtures: ["offline-held"],
    variant: "offline-queued",
    open: async (page) => {
      await page.locator('[data-screen="chat"]').waitFor({ timeout: 30_000 });
      await expect(page.locator('[data-receipt="queued"]')).toHaveCount(1);
      const box = page.getByRole("textbox", { name: "Message the lead" });
      await box.fill(OFFLINE_SENDS.typed);
      await box.press("Enter");
      await expect(box).toHaveValue("");
      await expect(page.locator('[data-receipt="queued"]')).toHaveCount(2);
    },
  },
  // ...and Retry now pressed: an attempt runs ("Reconnecting…", Retry now disabled) and the chat stays marked offline.
  {
    id: "chat",
    route: CHAT,
    fixtures: ["offline-held"],
    variant: "reconnecting",
    open: async (page) => {
      await page.locator('[data-screen="chat"]').waitFor({ timeout: 30_000 });
      await page.getByRole("button", { name: "Retry now" }).click();
      await expect(page.getByText(/Reconnecting…/u)).toBeVisible();
      await expect(page.getByRole("button", { name: "Retry now" })).toBeDisabled();
      await expect(page.locator("header").getByText(/^Offline, as of/u)).toBeVisible();
    },
  },
  // Back online before the chat is read again: marked as last known, never as current; and when that read failed,
  // why, with Retry.
  {
    id: "chat",
    route: CHAT,
    fixtures: ["offline-reread"],
    variant: "reread",
    open: async (page) => {
      await page.locator('[data-screen="chat"]').waitFor({ timeout: 30_000 });
      await expect(page.locator("header").getByText(/^Last known, as of/u)).toBeVisible();
      await expect(page.getByText("Earlier messages load once you’re connected.")).toHaveCount(0);
    },
  },
  {
    id: "chat",
    route: CHAT,
    fixtures: ["offline-reread-failed"],
    variant: "reread-failed",
    open: async (page) => {
      await page.locator('[data-screen="chat"]').waitFor({ timeout: 30_000 });
      await expect(page.getByText("Couldn’t load the newest messages.")).toBeVisible();
      await expect(page.locator('[data-screen="chat"]').getByRole("button", { name: "Retry", exact: true })).toBeVisible();
      await expect(page.locator("header").getByText(/^Last known, as of/u)).toBeVisible();
    },
  },
  // The strip's headline opens the panel's agents, where each one's work is (the chat doesn't list them itself): the
  // panel is closed first, so the shot shows the headline opening it.
  {
    id: "chat",
    route: CHAT,
    fixtures: ["live-3", "live-20"],
    variant: "strip-to-panel",
    open: async (page) => {
      const panel = page.getByRole("complementary", { name: "Agents and pull requests" });
      await page.getByRole("button", { name: "Hide agents and PRs" }).click();
      await panel.waitFor({ state: "detached" });
      // Scoped to the strip: the sidebar's project button also says "3 agents working".
      await page.getByRole("region", { name: /agents? working/u }).getByRole("button", { name: /agents? working/u }).click();
      await expect(panel.getByRole("list", { name: "Agents" })).toBeVisible();
    },
  },
  // A PR the chat names (in an event line, as "#10" in live-3 and as its GitHub URL in live-20) opens in the panel.
  {
    id: "chat",
    route: CHAT,
    fixtures: ["live-3", "live-20"],
    variant: "pr-link",
    open: async (page) => {
      const chat = page.getByRole("list", { name: "Conversation with the lead" });
      await chat.getByRole("link", { name: /^#10$|\/pull\/10$/u }).click();
      await page.getByRole("complementary", { name: "Agents and pull requests" }).locator('[data-screen^="prs.detail"]').waitFor();
      await expect(page).toHaveURL(/\/prs\/(acme\/storefront\/)?10$/u);
    },
  },
  // The lead chat (lead-chat-spec.md).
  // UX-1 [5]: each row says why it wants you (reply, approve · 2, secret, blocked), and docs' reply that arrives
  // after the app opened is bold.
  { id: "shell", route: "#/status", fixtures: ["sidebar-reasons"], variant: "sidebar" },
  // Hidden with its toggle in a wide window: the top row runs the full width, after the traffic lights.
  {
    id: "shell",
    route: "#/",
    fixtures: ["chat-waiting"],
    variant: "sidebar-hidden",
    open: async (page) => {
      await page.getByRole("button", { name: "Hide the sidebar" }).click();
      await page.getByRole("navigation", { name: "Sidebar" }).waitFor({ state: "detached" });
    },
  },
  // The panel beside the chat, open on a first launch on its Agents tab, and closed with its toggle.
  {
    id: "shell",
    route: "#/",
    fixtures: ["chat-waiting", "agents-work"],
    variant: "panel",
    open: async (page) => {
      await page.getByRole("complementary", { name: "Agents and pull requests" }).waitFor();
    },
  },
  {
    id: "shell",
    route: "#/",
    fixtures: ["chat-waiting"],
    variant: "panel-closed",
    open: async (page) => {
      await page.getByRole("button", { name: "Hide agents and PRs" }).click();
      await page.getByRole("complementary", { name: "Agents and pull requests" }).waitFor({ state: "detached" });
    },
  },
  // ...and in the smallest window, where it had hidden itself, shown with its toggle beside the chat.
  {
    id: "shell",
    route: "#/",
    fixtures: ["chat-waiting"],
    variant: "panel-narrow",
    sizes: ["narrow"],
    open: async (page) => {
      await page.getByRole("button", { name: "Show agents and PRs" }).click();
      await page.getByRole("complementary", { name: "Agents and pull requests" }).waitFor();
    },
  },
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
  // Back after a while: the chat opens at a "New" divider above what you hadn't seen (forty messages back from the
  // newest), and the button to the newest shows, since that's further down.
  {
    id: "chat",
    route: CHAT,
    fixtures: ["chat-long"],
    variant: "new",
    open: async (page) => {
      // What the app has seen is read once per launch, so mark storefront as seen forty back, then load again.
      await page.evaluate(() => {
        const key = "fleetd.seenChats";
        const seen = JSON.parse(localStorage.getItem(key) ?? "{}") as Record<string, number>;
        const [project, seq] = Object.entries(seen).find(([k]) => k.endsWith("/dcffccea-c5a7-40a6-940d-7f70239ffa22")) ?? [];
        if (project === undefined || seq === undefined) throw new Error("storefront's chat was never marked seen");
        localStorage.setItem(key, JSON.stringify({ ...seen, [project]: seq - 40 }));
      });
      await page.reload();
      await page.getByRole("separator").filter({ hasText: /^New$/ }).waitFor({ timeout: 10_000 });
      await page.getByRole("button", { name: "Latest" }).waitFor({ timeout: 10_000 });
    },
  },
  // Scrolled back through two pages while the lead writes: three replies land below, and the button to the newest
  // counts them.
  {
    id: "chat",
    route: CHAT,
    fixtures: ["transcript-new"],
    variant: "new-below",
    open: async (page) => {
      const log = page.getByLabel("Conversation with the lead");
      // The page before the newest may load as the chat opens; the replies come once the one before that is read.
      for (let i = 0; i < 2; i++) {
        await log.hover();
        await page.mouse.wheel(0, -50_000);
        await log.evaluate((el) => el.scrollTo({ top: 0 }));
        await page.getByText("Loading earlier messages…").waitFor({ state: "hidden", timeout: 5_000 });
      }
      await page.getByRole("button", { name: "3 new" }).waitFor({ timeout: 10_000 });
    },
  },
  // The chat as bubbles: a casual exchange the hub split into bubbles with your reply to one, charts and a table, a
  // PR card with its diff, and an ask waiting on you.
  { id: "chat", route: CHAT, fixtures: ["bubbles-casual", "bubbles-charts", "bubbles-pr", "bubbles-ask"], variant: "bubbles" },
  // A tapback put on one of the lead's bubbles, from the button its hover shows.
  {
    id: "chat",
    route: CHAT,
    fixtures: ["bubbles-casual"],
    variant: "tapback",
    open: async (page) => {
      const bubble = page.locator('[data-bubble="text"]').filter({ hasText: "Nightly was green" }).locator("..");
      await bubble.hover();
      await bubble.getByRole("button", { name: "Tapback" }).click();
      await page.getByRole("button", { name: "Love" }).click();
      await page.getByRole("img", { name: "You reacted: Love" }).waitFor({ timeout: 5_000 });
      await page.mouse.move(0, 0);
    },
  },
  // Replying to a bubble: its quote over the box, with what you write under it.
  {
    id: "chat",
    route: CHAT,
    fixtures: ["bubbles-casual"],
    variant: "reply",
    open: async (page) => {
      const bubble = page.locator('[data-bubble="text"]').filter({ hasText: "Both PRs are green" }).locator("..");
      await bubble.hover();
      await bubble.getByRole("button", { name: "Reply" }).click();
      await page.getByRole("textbox", { name: "Message the lead" }).fill("merge the dates one first");
      await page.mouse.move(0, 0);
    },
  },
  // UX-1 [23]: a long reply streams in with the chat open, the typing bubble standing in for it; checked after its last
  // delta.
  { id: "chat", route: CHAT, fixtures: ["stream-long"], variant: "stream", replay: true },
  // UX-1 [10]: just set up, no chat has a message yet: the empty chat shows the checklist on its last step.
  { id: "chat", route: CHAT, fixtures: ["onboarding-first-chat"], variant: "first-chat" },
  // Sequences that once blanked the window, replayed to the end: the chat must still be up, with no error card.
  {
    id: "chat",
    route: CHAT,
    fixtures: ["resilience-burst", "resilience-hub-restart", "resilience-reconnect-streaming"],
    variant: "resilience",
    replay: true,
    realClock: true,
  },
  // The error card itself, in place of the chat (the frame around it still works) and of the sidebar (the chat still
  // works). The QA build's probe makes the part throw.
  { id: "shell", route: CHAT, fixtures: ["typical", "long-text"], variant: "chat-card", expect: "card", open: crash("the chat") },
  { id: "chat", route: CHAT, fixtures: ["typical"], variant: "sidebar-card", expect: "card", open: crash("the sidebar") },
  // `#/` set again while it is turning into the last project's chat (#251), here mid-stream.
  {
    id: "chat",
    route: "#/",
    fixtures: ["chat-streaming"],
    variant: "home-reset",
    realClock: true,
    open: async (page) => {
      for (let i = 0; i < 5; i++) {
        await page.evaluate(() => {
          window.location.hash = "#/";
        });
        await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => done(null))));
      }
    },
  },
  // A link to a project the hub doesn't have (here, a hub with none): says so, rather than loading forever.
  { id: "chat", route: CHAT, fixtures: ["empty"], variant: "missing", expect: "error" },
  // A5 (F5): the two inline items, every state: the masked secret field, the exact command with Approve / Deny, open
  // again after the node was offline; answered ones folded to one line (saved, not needed, ran, ran with an error,
  // not run, denied, running).
  { id: "chat", route: CHAT, fixtures: ["inline-items"], variant: "inline" },
  // The same chat offline from the disk cache: an open item says it can't be answered now, and a secret never claims
  // the hub doesn't know its machine.
  {
    id: "chat",
    route: CHAT,
    fixtures: ["inline-offline"],
    variant: "inline-offline",
    open: async (page) => {
      await page.locator('[data-screen="chat"]').waitFor({ timeout: 30_000 });
      await expect(page.getByText("Offline: approve once the hub is back.").first()).toBeAttached();
      await expect(page.getByText("Offline: save it once the hub is back.").first()).toBeAttached();
      await expect(page.getByText(/doesn't know the machine/u)).toHaveCount(0);
    },
  },
  // Approve on a command that can't be undone asks once more, in the card.
  {
    id: "chat",
    route: CHAT,
    fixtures: ["inline-items"],
    variant: "inline-confirm",
    open: async (page) => {
      const card = page.getByRole("region", { name: "Command to approve" }).filter({ hasText: "database migration" });
      await card.getByRole("button", { name: "Approve", exact: true }).click();
      await card.getByText("It can't be undone.").waitFor();
    },
  },
  // A folded answer opened back up to its whole card.
  {
    id: "chat",
    route: CHAT,
    fixtures: ["inline-items"],
    variant: "inline-opened",
    open: async (page) => {
      const fold = page.getByRole("button", { name: /^Approved, ran in 12s/u });
      await fold.click();
      await page.getByText("purged 412 objects").waitFor();
    },
  },
  // Every answer fails: one plain line with Retry, and the typed secret stays in its field.
  {
    id: "chat",
    route: CHAT,
    fixtures: ["inline-failures"],
    variant: "inline-failed",
    open: async (page) => {
      await page.getByRole("textbox", { name: "Secret value" }).fill("sk_test_51Hx");
      await page.getByRole("button", { name: "Save secret" }).click();
      await page.getByText("Not saved: no answer in time.").waitFor();
      const card = page.getByRole("region", { name: "Command to approve" }).filter({ hasText: "invoice.ts" });
      await card.getByRole("button", { name: "Approve", exact: true }).click();
      await page.getByText("Not approved: something went wrong.").waitFor();
    },
  },
  // Approved, then reopened by the hub (the node is offline): both cards are open again with why, never "Approved,
  // running…". One gains its evidence; the other says what it said before, its approval and reopen in one refetch.
  {
    id: "chat",
    route: CHAT,
    fixtures: ["inline-reopened"],
    variant: "inline-reopened",
    open: async (page) => {
      const card = (text: string) => page.getByRole("region", { name: "Command to approve" }).filter({ hasText: text });
      // Each answer disables the card until it lands, then the card folds until the reopen's refetch: an enabled
      // Approve again is the card open again.
      const again = (c: ReturnType<typeof card>) => c.getByRole("button", { name: "Approve again", exact: true }).and(page.locator(":enabled"));
      for (const text of ["database migration", "release tag"]) {
        const c = card(text);
        await c.getByRole("button", { name: /^Approve( again)?$/u }).click();
        await c.getByRole("button", { name: "Yes, run it" }).click();
        await again(c).waitFor();
      }
    },
  },
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
  // C1: updates. The sidebar's line above the connection for each state that has one, and the sheet the palette's
  // "Check for updates" opens, for every state of this app (not checked yet, checking, a build that doesn't update,
  // up to date, found, downloading to restart, ready, the deb's command, a failed check, a failed download) and of the
  // hub (up to date, version unknown, a newer build on the channel, older than this app, there or on this computer).
  {
    id: "shell",
    route: "#/",
    fixtures: ["updates-available", "updates-downloading", "updates-ready", "updates-hub-behind"],
    variant: "updates",
  },
  {
    id: "updates",
    route: "#/",
    fixtures: [
      "updates-idle",
      "updates-checking",
      "updates-unsupported",
      "updates-current",
      "updates-available",
      "updates-downloading",
      "updates-ready",
      "updates-deb",
      "updates-failed",
      "updates-download-failed",
      "updates-hub-current",
      "updates-hub-unknown",
      "updates-hub-available",
      "updates-hub-behind",
      "updates-hub-behind-local",
    ],
    open: openUpdates,
  },
  // Update the hub on devbox: what runs there (hub_info) and the command, saying when it restarts the hub. And on this
  // computer when the command needs --channel, which Run in Terminal can't run: Copy only.
  {
    id: "updates",
    route: "#/",
    fixtures: ["updates-hub-behind", "updates-hub-behind-local-channel"],
    variant: "update-the-hub",
    open: async (page) => {
      await openUpdates(page);
      await page.getByRole("button", { name: "Update the hub" }).click();
      await page.getByText("Running on the hub now, so it waits for these:").waitFor();
    },
  },
  // Update the hub on this computer, idle: Run in Terminal opens fleetd update (a fixture opens nothing).
  {
    id: "updates",
    route: "#/",
    fixtures: ["updates-hub-behind-local"],
    variant: "run-in-terminal",
    open: async (page) => {
      await openUpdates(page);
      await page.getByRole("button", { name: "Update the hub" }).click();
      await page.getByRole("button", { name: "Run in Terminal" }).click();
      await page.getByText("fleetd update is running in Terminal.").waitFor();
    },
  },
  // Update the hub when the hub can't say what runs on it.
  {
    id: "updates",
    route: "#/",
    fixtures: ["updates-hub-info-failed"],
    variant: "update-the-hub",
    open: async (page) => {
      await openUpdates(page);
      await page.getByRole("button", { name: "Update the hub" }).click();
      await page.getByText(/^The hub couldn't say what's running/u).waitFor();
    },
  },
  // Run in Terminal's failures: the hub isn't here, no fleetd command, no terminal; each with the command instead.
  {
    id: "updates",
    route: "#/",
    fixtures: ["updates-terminal-not-local", "updates-terminal-not-found", "updates-terminal-no-terminal"],
    variant: "run-in-terminal",
    open: async (page) => {
      await openUpdates(page);
      await page.getByRole("button", { name: "Update the hub" }).click();
      await page.getByRole("button", { name: "Run in Terminal" }).click();
      await page.getByRole("alert").waitFor();
    },
  },
  // UX-1 A3: a project's PRs in the panel. The list (open first, then merged or closed lately); none at all; GitHub
  // out of reach; and a link to a project the hub doesn't have. The narrow window has hidden the panel; the link
  // shows it there.
  { id: "prs", route: PRS, fixtures: ["typical", "long-text", "many-agents", "prs-none", "prs-no-github", "prs-rate-limited", "hub-unreachable"] },
  // Offline with nothing held: the list says it shows once you're connected, never loading bars.
  {
    id: "prs",
    route: PRS,
    fixtures: ["offline-held"],
    variant: "offline",
    open: (page) => expect(page.getByText("Pull requests show once you’re connected.")).toBeVisible(),
  },
  { id: "prs", route: PRS, fixtures: ["typical"], variant: "narrow", sizes: ["narrow"] },
  { id: "prs", route: PRS, fixtures: ["empty"], variant: "missing", expect: "error" },
  {
    id: "prs",
    route: CHAT,
    fixtures: ["prs-loading"],
    variant: "loading",
    open: whileLoading(
      (page) => page.getByRole("tab", { name: /^Pull requests/u }).click({ timeout: 10_000 }),
      (page) => page.getByLabel("Loading the pull requests"),
    ),
  },
  // One PR in the list's place: its facts, description, checks, reviews with their findings, and its way to main so far.
  // #10's checks failed after its approval and an outdated review; a chat line's link names only the number.
  { id: "prs.detail", route: PR(11), fixtures: ["typical", "long-text", "prs-no-github", "prs-rate-limited"] },
  // ...and offline with nothing held: it says it shows once you're connected, never "Loading".
  {
    id: "prs.detail",
    route: PR(11),
    fixtures: ["offline-held"],
    variant: "offline",
    open: (page) => expect(page.getByText("#11 shows once you’re connected.")).toBeVisible(),
  },
  { id: "prs.detail", route: PR(10), fixtures: ["typical"], variant: "failed" },
  { id: "prs.detail", route: PR(8), fixtures: ["typical"], variant: "merged" },
  { id: "prs.detail", route: PR(14), fixtures: ["typical"], variant: "review-requested" },
  {
    id: "prs.detail",
    route: CHAT,
    fixtures: ["prs-loading"],
    variant: "loading",
    open: whileLoading(async (page) => {
      await page.evaluate((r) => {
        window.location.hash = r;
      }, PR(11));
    }, (page) => page.getByText(/^Loading #11/u)),
  },
  { id: "prs.detail", route: `${PRS}/11`, fixtures: ["typical"], variant: "by-number", sizes: ["small"] },
  { id: "prs.detail", route: PR(11), fixtures: ["prs-error"], expect: "error" },
  // Its changes: the files beside a diff drawn a screen at a time, one column or side by side, and a PR too big to
  // load at once.
  { id: "prs.detail", route: PR(11), fixtures: ["typical", "long-text", "prs-no-github"], variant: "changes", open: openChanges },
  {
    id: "prs.detail",
    route: PR(11),
    fixtures: ["typical"],
    variant: "split",
    open: async (page) => {
      await openChanges(page);
      await page.getByRole("button", { name: "Show side by side" }).click();
    },
  },
  { id: "prs.detail", route: PR(13), fixtures: ["prs-heavy"], variant: "changes", open: openChanges },
  // ...lowered from the header, applied once the keys rest, with Undo.
  {
    id: "chat",
    route: CHAT,
    fixtures: ["settings-agents"],
    variant: "max-agents-applied",
    open: async (page) => {
      await page.getByRole("button", { name: /^Max agents: \d+ running of \d+/u }).click();
      await page.getByRole("slider").focus();
      for (let i = 0; i < 3; i++) await page.keyboard.press("ArrowLeft");
      await page.getByRole("button", { name: "Undo" }).waitFor();
    },
  },
  // F1: the frame (top bar, sidebar of projects) around #/, which opens the last project's chat (the first one on a
  // fresh install), and the connection states it shows. With no projects, #/ offers to add one (home.empty).
  {
    id: "shell",
    route: "#/",
    fixtures: ["empty", "typical", "many-agents", "long-text", "hub-unreachable", "pairing-failed", "node-too-old", "offline-held"],
  },
  { id: "home.empty", route: "#/", fixtures: ["empty"] },
  // Settings opened from the sidebar takes its place; Back returns, with focus on the control that opened it.
  {
    id: "shell",
    route: "#/",
    fixtures: ["typical"],
    variant: "settings-back",
    open: async (page) => {
      await page.getByRole("navigation", { name: "Sidebar" }).getByRole("button", { name: /^Settings/u }).click();
      await page.getByRole("searchbox", { name: "Search settings" }).waitFor();
      await page.getByRole("button", { name: "Back" }).click();
      await expect(page.getByRole("navigation", { name: "Sidebar" }).getByRole("button", { name: /^Settings/u })).toBeFocused();
    },
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
  // UX-1 [22]: a code typed in lower case with no dash shows as ABCD-2345, and pressing Connect moves nothing above
  // the hub's answer: the field and the button stay where they were.
  {
    id: "onboarding",
    route: "#/onboarding",
    fixtures: ["onboarding-code-refused"],
    variant: "refused",
    open: async (page) => {
      await page.getByRole("textbox", { name: "Hub address" }).fill("http://buildbox:4790");
      const code = page.getByRole("textbox", { name: "Pairing code" });
      await code.fill("wxyz6789");
      await expect(code).toHaveValue("WXYZ-6789");
      const connect = page.getByRole("button", { name: "Connect", exact: true });
      const before = await connect.boundingBox();
      await code.press("Enter");
      await page.getByRole("alert").getByText("unknown or was already used").waitFor({ timeout: 10_000 });
      expect(await connect.boundingBox()).toEqual(before);
    },
  },
  // UX-1 [10]: "Set up fleetd on this Mac" opens `fleetd init` in a terminal, or, where none opens, shows the command
  // with Copy. Under a fixture main never runs anything; the fixture says which answer it gives.
  {
    id: "onboarding",
    route: "#/onboarding",
    fixtures: ["onboarding-setup-terminal", "onboarding-first-run"],
    variant: "setup",
    open: async (page) => {
      await page.getByRole("button", { name: /^Set up fleetd on this/u }).click();
      await page.getByText(/^Opened Terminal with|^Couldn't open a terminal/u).waitFor({ timeout: 10_000 });
    },
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
  // The link drops before project_add answers and the resync doesn't list the project: not on the hub yet, never
  // "failed", since a clone may still be running.
  {
    id: "projects.add.unlisted",
    route: "#/projects/add",
    fixtures: ["projects-dropped"],
    open: async (page) => {
      await page.getByRole("listbox", { name: "Repos" }).waitFor();
      await page.getByRole("textbox", { name: "GitHub URL, folder path, or filter" }).fill("acme/checkout-v2");
      await page.keyboard.press("Enter");
      await page.locator('[data-screen="projects.add.unlisted"]').waitFor();
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
  // UX-1 A2: the project's agents in the panel, those waiting on you first (none, many, long titles and commands, the
  // link down), and one agent's live work in the list's place: told, ran, edited, a failed command, a message
  // streaming in. An agent that isn't running any more says so.
  {
    id: "agents",
    route: `${CHAT}/agents`,
    fixtures: ["typical", "many-agents", "long-text", "hub-unreachable", "live-20", "agents-work"],
  },
  // ...and offline with nothing held: it says they show once you're connected, never loading bars.
  {
    id: "agents",
    route: `${CHAT}/agents`,
    fixtures: ["offline-held"],
    variant: "offline",
    open: (page) => expect(page.getByText("Agents show once you’re connected.")).toBeVisible(),
  },
  // ...and with All projects, every project's agents under its name, checkout's first as one waits on you.
  {
    id: "agents",
    route: `${CHAT}/agents`,
    fixtures: ["agents-work", "long-text", "many-agents"],
    variant: "all",
    open: async (page) => {
      await page.getByRole("button", { name: "All projects" }).click();
      await expect(page.getByRole("button", { name: "All projects" })).toHaveAttribute("aria-pressed", "true");
    },
  },
  // Under its work, your steers to it with their receipts, in every stage, and the box that steers it directly.
  { id: "agents.work", route: AGENT_ROUTE, fixtures: ["agents-work", "agents-steers"] },
  // ...and offline with nothing held: it says it shows once you're connected, never a blank loading pane.
  {
    id: "agents.work",
    route: AGENT_ROUTE,
    fixtures: ["offline-held"],
    variant: "offline",
    open: (page) => expect(page.getByText("This agent shows once you’re connected.")).toBeVisible(),
  },
  {
    id: "agents.work",
    route: AGENT_ROUTE,
    fixtures: ["agents-work"],
    variant: "steered",
    open: async (page) => {
      const box = page.getByRole("textbox", { name: "Steer this agent" });
      await box.fill(STEER_WORDS.agent);
      await box.press("Enter");
      await expect(box).toHaveValue("");
      await expect(page.locator('[data-steer="queued"]')).toHaveCount(2);
    },
  },
  // What it was told at its start, opened from its head.
  {
    id: "agents.work",
    route: AGENT_ROUTE,
    fixtures: ["agents-work"],
    variant: "told",
    open: async (page) => {
      await page.getByRole("button", { name: "What it was told" }).click();
      await expect(page.getByRole("dialog", { name: "What the writer was told" }).getByText("First message", { exact: true })).toBeVisible();
    },
  },
  { id: "agents.work", route: AGENT_ROUTE, fixtures: ["agents-work"], variant: "narrow", sizes: ["narrow"] },
  { id: "agents.work", route: `${CHAT}/agents/T99`, fixtures: ["typical"], variant: "finished" },
  { id: "machines", route: "#/machines", fixtures: ["typical", "empty", "long-text", "many-agents", "hub-unreachable", "projects-machines"] },
  // F11: the command palette (opening on the project on screen, then go-tos), a typed search, and the shortcuts
  // sheet. status-rows has eight projects, one with a ~120-character name.
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
  // Opened over a chat that isn't the first project: the selection starts on that project.
  { id: "palette", variant: "on-project", route: CHAT, fixtures: ["typical"], open: (page) => page.keyboard.press("ControlOrMeta+K") },
  // Settings by their own names, and the theme switch "dark" offers; matched letters are highlighted.
  {
    id: "palette.search",
    variant: "setting",
    route: "#/",
    fixtures: ["typical"],
    open: async (page) => {
      await page.keyboard.press("ControlOrMeta+K");
      await page.getByRole("combobox", { name: "Search" }).fill("max agents");
    },
  },
  {
    id: "palette.search",
    variant: "theme",
    route: "#/",
    fixtures: ["typical"],
    open: async (page) => {
      await page.keyboard.press("ControlOrMeta+K");
      await page.getByRole("combobox", { name: "Search" }).fill("dark");
    },
  },
  // ⌘K inside the palette: the actions of the selected row, here the project on screen.
  {
    id: "palette.actions",
    route: "#/",
    fixtures: ["typical", "long-text", "status-rows"],
    open: async (page) => {
      await page.keyboard.press("ControlOrMeta+K");
      await page.keyboard.press("ControlOrMeta+K");
    },
  },
  { id: "shortcuts", route: "#/", fixtures: ["typical"], open: (page) => page.keyboard.press("ControlOrMeta+Slash") },
  // F9: Settings. Prompts opens on the lead's first message, the longest text; many-prompts lists 72 with long
  // keys and titles; settings-prompts is the real registry with edits. Compare and Update are deep links.
  // Max agents: the fleet cap and each project's slider.
  { id: "settings.agents", route: "#/settings/agents", fixtures: ["settings-agents", "long-text", "empty", "hub-unreachable"] },
  // The two task profiles, and each project's medium switch: storefront's off in settings-medium-off.
  {
    id: "settings.agents",
    route: "#/settings/agents",
    fixtures: ["settings-agents", "settings-medium-off"],
    variant: "profiles",
    open: async (page) => {
      const profiles = page.getByRole("region", { name: "Task profiles" });
      await profiles.scrollIntoViewIfNeeded();
      await profiles.getByText("Medium: Opus 5.5, medium effort, for mechanical work").waitFor();
      await page.getByRole("region", { name: "storefront" }).getByRole("switch", { name: /Medium allowed/u }).waitFor();
    },
  },
  // The palette's "Max agents for this project": that project's slider scrolled to and focused.
  {
    id: "settings.agents",
    variant: "for-project",
    route: "#/settings/agents?for=devbox/dcffccea-c5a7-40a6-940d-7f70239ffa22",
    fixtures: ["settings-agents"],
    open: (page) => expect(page.getByRole("slider", { name: "storefront" })).toBeFocused(),
  },
  // A slider applies when you let go (keys: once they rest): a project lowered under its running agents, with the
  // pause and Undo; and the whole fleet moved below a project's own max, which warns.
  {
    id: "settings.agents",
    route: "#/settings/agents",
    fixtures: ["settings-agents"],
    variant: "applied",
    open: async (page) => {
      // storefront: 6 running under a max of 12, lowered to 4.
      await page.getByRole("slider", { name: "storefront" }).focus();
      for (let i = 0; i < 8; i++) await page.keyboard.press("ArrowLeft");
      await page.getByRole("button", { name: "Undo" }).waitFor();
    },
  },
  {
    id: "settings.agents",
    route: "#/settings/agents",
    fixtures: ["settings-agents"],
    variant: "fleet-below",
    open: async (page) => {
      await page.getByRole("slider").first().focus();
      for (let i = 0; i < 8; i++) await page.keyboard.press("ArrowLeft");
      await page.getByRole("button", { name: "Undo" }).waitFor();
    },
  },
  // Settings search: an option found by its name, and by nothing.
  {
    id: "settings.general",
    route: "#/settings/general",
    fixtures: ["typical"],
    variant: "search",
    open: (page) => page.getByRole("searchbox", { name: "Search settings" }).fill("max agents"),
  },
  {
    id: "settings.general",
    route: "#/settings/general",
    fixtures: ["typical"],
    variant: "search-none",
    open: (page) => page.getByRole("searchbox", { name: "Search settings" }).fill("zebra"),
  },
  // Prompts before one is picked.
  { id: "settings.prompts", route: "#/settings/prompts", fixtures: ["settings-prompts"], variant: "none" },
  { id: "settings.general", route: "#/settings/general", fixtures: ["typical", "empty", "hub-unreachable"] },
  // Notifications: the kinds, sound, the Dock badge, then the test's two answers: sent (with where to allow fleetd
  // if nothing showed) and a system that shows none.
  { id: "settings.notifications", route: "#/settings/notifications", fixtures: ["typical"] },
  {
    id: "settings.notifications",
    route: "#/settings/notifications",
    fixtures: ["typical"],
    variant: "test-sent",
    open: async (page, app) => {
      await systemNotifications(app, true);
      await page.getByRole("button", { name: "Send a test notification" }).click();
      await page.getByRole("status").filter({ hasText: /^Sent\./u }).waitFor();
    },
  },
  {
    id: "settings.notifications",
    route: "#/settings/notifications",
    fixtures: ["typical"],
    variant: "test-unsupported",
    open: async (page, app) => {
      await systemNotifications(app, false);
      await page.getByRole("button", { name: "Send a test notification" }).click();
      await page.getByRole("status").filter({ hasText: "doesn’t show notifications" }).waitFor();
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
  // F6: Status, one row per project: every state word, long titles, no projects, quiet sources, the skeleton before
  // the first answer, and the link down.
  {
    id: "status.fleet",
    route: "#/status",
    fixtures: ["typical", "status-rows", "long-text", "empty", "many-agents", "hub-unreachable", "status-stale", "status-skeleton"],
  },
  // A held figure: the bar's hover marks it, with why, above the drop that came before it. Nothing moves.
  {
    id: "status.fleet",
    route: "#/status",
    fixtures: ["status-paused"],
    variant: "paused",
    open: async (page) => {
      await page.getByRole("img", { name: /^78% done/u }).hover();
      await page.getByText("Held at 78% (paused: an agent hit a usage limit)").waitFor();
      await page.getByText("↓ 61% → 55%: CI failed on #212").waitFor();
    },
  },
  // The Factory (D33, fixtures/factory): the four tiles, the three charts, the projects table and the merge list over
  // 30 days; long titles; eight projects with one repo on two machines; no projects; no hub; failing reads; nothing
  // merged. Then one project, the last 90 days in weekly columns, the period before, and a column's hover card.
  {
    id: "factory",
    route: "#/factory",
    fixtures: ["typical", "long-text", "many-agents", "status-rows", "empty", "hub-unreachable", "factory-stale", "factory-none"],
  },
  { id: "factory", route: `#/factory?project=devbox/${CHAT.split("/").pop() ?? ""}`, fixtures: ["typical"], variant: "project" },
  // A hub with no metrics_get (chat-empty answers none): what to do, not an error, and no Factory in the sidebar.
  { id: "factory", route: "#/factory", fixtures: ["chat-empty"] },
  {
    id: "factory",
    route: "#/factory",
    fixtures: ["typical"],
    variant: "quarter",
    open: async (page) => {
      await page.getByRole("button", { name: "Last 30 days" }).click();
      await page.getByRole("menuitemradio", { name: "Last 90 days" }).click();
      await page.getByRole("heading", { name: "Merged per week, by route" }).waitFor();
    },
  },
  {
    id: "factory",
    route: "#/factory",
    fixtures: ["typical"],
    variant: "compare",
    open: async (page) => {
      await page.getByRole("button", { name: "Compare with the period before" }).click();
      await page.getByText("The period before").first().waitFor();
    },
  },
  {
    id: "factory",
    route: "#/factory",
    fixtures: ["typical"],
    variant: "hover",
    open: async (page) => {
      await page.getByRole("img", { name: /^Merged per day, by route/u }).hover();
      await page.getByRole("tooltip").waitFor();
    },
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

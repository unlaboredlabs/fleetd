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
import { AGENT_ROUTE, ELSEWHERE_IDLE_ROUTE } from "../fixtures/agents/route.ts";
import { STEER_WORDS } from "../fixtures/agents/steers.ts";
import { SESSION } from "../fixtures/sessions/ids.ts";
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
  // A machine past its memory estimate, and a project set past its machine (fixtures/settings).
  "settings-machines",
  // Administration (fixtures/admin): an owner's hub with three people and an invite waiting, as its owner, an admin and
  // a member.
  "admin-owner",
  "admin-admin",
  "admin-member",
  // ...and a hub from before people, whose People and Invites ask for an update.
  "admin-old-hub",
  // Administration › Machines (fixtures/machines): Add machine's three ways in, a run at its install step, and one
  // stopped at the node's service with its output and Retry.
  "machines-add",
  "machines-running",
  "machines-failed",
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
  // W100: the hub admin's setup, a design prototype (fixtures/setup).
  "setup-fresh",
  "setup-claude-logins",
  "setup-github",
  "setup-google",
  "setup-done",
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
  // status-rows with search blocked by a usage pause on buildbox: the top bar's reason with Resume (fixtures/topbar).
  "topbar-paused",
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
  // The panel's Checklist tab: a list the lead keeps, and none yet (fixtures/checklist).
  "checklist-listed",
  "checklist-empty",
  // The panel's Train, Activity and Decisions tabs (fixtures/train, fixtures/activity, fixtures/decisions).
  "train-full",
  "train-batch",
  "train-empty",
  "train-loading",
  "train-error",
  "activity-none",
  "activity-loading",
  "activity-error",
  "activity-old-hub",
  "decisions-none",
  "decisions-loading",
  "decisions-error",
  // ...and the work elsewhere on storefront's repo, seen from storefront and from checkout (fixtures/agents).
  "agents-elsewhere",
  "agents-states",
  // W46's design preview: storefront's browser sessions, one agent driving and one asking you to take over
  // (fixtures/sessions).
  "sessions-preview",
  // W58's Try it: storefront's #14 suggested, started, ready, starting, failed, ended, and from a read key
  // (fixtures/tryit).
  "tryit-fresh",
  "tryit-ready",
  "tryit-starting",
  "tryit-failed",
  "tryit-ended",
  "tryit-read",
  "tryit-read-ready",
  // W96: what there is to look at, a lead's nudge and a Try it suggestion, with nothing waiting (fixtures/look).
  "look-two",
  "stream-reply",
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
  // C1 and W38: the app's own update, the hub's and its machines', and the Update button's run (fixtures/updates).
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
  "updates-node-behind",
  "updates-everything",
  "updates-run-hub",
  "updates-run-nodes",
  "updates-run-done",
  "updates-run-hub-failed",
  "updates-run-hub-rolled-back",
  "updates-run-nodes-mixed",
  "updates-hub-ready",
  "updates-run-updated",
  "updates-refused",
  // fleetd.sh's showcase: one request played from send to merge, recorded by showcase.spec.ts (fixtures/showcase).
  "showcase-order",
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
/** One of storefront's browser sessions, open in the panel (fixtures/sessions). */
const SESSION_ROUTE = (id: string) => `${CHAT}/sessions/${id}`;

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

/** #14's Try it, ready: Mark up, a pin on the Dutch pay button, and what's wrong there in words. */
const markUp = async (page: Page) => {
  await page.getByRole("tab", { name: "Try it" }).click();
  await page.getByRole("button", { name: "Mark up" }).click();
  const layer = page.locator("[data-pin-layer]");
  const box = await layer.boundingBox();
  if (box === null) throw new Error("no page to mark up");
  // The pay button, as the Dutch checkout draws it (fixtures/tryit/pages.ts): 42% across, 64% down.
  await layer.click({ position: { x: box.width * 0.42, y: box.height * 0.64 } });
  await page.getByRole("textbox", { name: "What’s wrong at pin 1" }).fill("In Dutch the button wraps onto two lines. Keep it on one, as in German.");
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
  // F2 (A4): the live strip docked to the top of the project's composer. live-0 draws no strip.
  {
    id: "chat",
    route: CHAT,
    fixtures: ["live-0", "live-3", "live-20"],
    variant: "strip",
  },
  // A click on the strip opens its lanes above it, a row per agent.
  {
    id: "chat",
    route: CHAT,
    fixtures: ["live-3", "live-20"],
    variant: "strip-open",
    open: async (page) => {
      await page.getByRole("region", { name: /agents? working/u }).getByRole("button", { name: /agents? working/u }).click();
      await expect(page.getByRole("list", { name: "Agents at work" })).toBeVisible();
    },
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
  // `$` in the box: storefront's skills that fit, the repo's first; the outranked project copy of release is not
  // offered twice.
  {
    id: "chat.composer",
    route: CHAT,
    fixtures: ["typical"],
    variant: "skills",
    open: async (page) => {
      await page.locator('[data-screen="chat"]').waitFor({ timeout: 30_000 });
      const box = page.getByRole("textbox", { name: "Message the lead" });
      await box.fill("Ship today with $");
      await expect(page.getByRole("listbox", { name: "Skills" }).getByRole("option")).toHaveCount(5);
      await box.press("ArrowDown");
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
      // A quiet receipt is a mark beside the bubble, its words its label.
      await expect(mine.getByLabel("Delivered; the lead stopped its step to read this")).toBeVisible();
    },
  },
  // A message the hub took while the lead works waits for it to be free: no sentence under it, an open ring beside it,
  // its words the ring's label.
  {
    id: "chat.composer",
    route: CHAT,
    fixtures: ["composer-sends"],
    variant: "queued-mark",
    open: async (page) => {
      await page.locator('[data-screen="chat"]').waitFor({ timeout: 30_000 });
      const box = page.getByRole("textbox", { name: "Message the lead" });
      await box.fill(CHAT_SENDS.queued);
      await box.press("Enter");
      await expect(box).toHaveValue("");
      const mine = page.locator('[data-entry="message"]').filter({ hasText: CHAT_SENDS.queued });
      await expect(mine.getByLabel("Sent; the lead takes it when it’s free")).toBeVisible();
      await expect(mine.getByText("the lead takes it when it’s free")).toHaveCount(0);
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
  // A red main is a warning in the top bar, in the hub's words, not a block (checkout's `ios sessions`).
  {
    id: "chat",
    route: "#/project/devbox/6e8e753c-fe9a-4b79-aec3-5812d498c197",
    fixtures: ["sidebar-reasons"],
    variant: "red-main",
    open: async (page) => {
      await page.locator('[data-screen="chat"]').waitFor({ timeout: 30_000 });
      await expect(page.locator('[data-attention="warning"]')).toHaveText("ios sessions is red on main, fix in progress");
    },
  },
  // A project blocked by its machine's usage pause: the reason in the top bar, with Resume (search, on buildbox).
  {
    id: "chat",
    route: "#/project/buildbox/558dc655-fbca-48f0-abf1-6977a0709ea9",
    fixtures: ["topbar-paused"],
    variant: "usage-paused",
    open: async (page) => {
      const line = page.locator("header").locator('[data-attention="blocked"]');
      await expect(line).toContainText("Blocked: paused until Sun 23:40 UTC");
      await expect(line.getByRole("button", { name: /^Resume/u })).toBeVisible();
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
  { id: "chat", route: CHAT, fixtures: ["look-two"], variant: "look" },
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
  // An agent in the strip's lanes opens in the panel's agents, where its work is (the chat doesn't draw it itself):
  // the panel is closed first, so the shot shows the strip opening it.
  {
    id: "chat",
    route: CHAT,
    fixtures: ["live-3", "live-20"],
    variant: "strip-to-panel",
    open: async (page) => {
      const panel = page.getByRole("complementary", { name: "Project panel" });
      await page.getByRole("button", { name: "Hide the panel" }).click();
      await panel.waitFor({ state: "detached" });
      // Scoped to the strip: the sidebar's project button also says "3 agents working".
      const strip = page.getByRole("region", { name: /agents? working/u });
      await strip.getByRole("button", { name: /agents? working/u }).click();
      await strip.getByRole("list", { name: "Agents at work" }).getByRole("link").first().click();
      await panel.locator('[data-screen^="agents.work"]').waitFor();
      await expect(page).toHaveURL(/\/agents\/T\d+$/u);
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
      await page.getByRole("complementary", { name: "Project panel" }).locator('[data-screen^="prs.detail"]').waitFor();
      await expect(page).toHaveURL(/\/prs\/(acme\/storefront\/)?10$/u);
    },
  },
  // The lead chat (lead-chat-spec.md).
  // UX-1 [5]: each row says why it wants you (reply, approve · 2, secret, blocked), and docs' reply that arrives
  // after the app opened is bold.
  { id: "shell", route: "#/status", fixtures: ["sidebar-reasons"], variant: "sidebar" },
  // Administration's entry in the sidebar: there for the hub's owner, and not for a member.
  { id: "shell", route: "#/status", fixtures: ["admin-owner", "admin-member"], variant: "admin-entry" },
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
      await page.getByRole("complementary", { name: "Project panel" }).waitFor();
    },
  },
  {
    id: "shell",
    route: "#/",
    fixtures: ["chat-waiting"],
    variant: "panel-closed",
    open: async (page) => {
      await page.getByRole("button", { name: "Hide the panel" }).click();
      await page.getByRole("complementary", { name: "Project panel" }).waitFor({ state: "detached" });
    },
  },
  // The panel's Checklist tab: how far along, doing and to do, done folded; done unfolded; and none set yet.
  {
    id: "shell",
    route: `${CHAT}/checklist`,
    fixtures: ["checklist-listed"],
    variant: "panel-checklist",
    open: async (page) => {
      await page.getByRole("complementary", { name: "Project panel" }).locator('[data-screen="checklist"]').waitFor();
      await expect(page.getByRole("progressbar", { name: "Checklist progress" })).toHaveAttribute("aria-valuenow", "2");
    },
  },
  {
    id: "shell",
    route: `${CHAT}/checklist`,
    fixtures: ["checklist-listed"],
    variant: "panel-checklist-done",
    open: async (page) => {
      const panel = page.getByRole("complementary", { name: "Project panel" });
      await panel.getByRole("button", { name: /^Done/u }).click();
      await expect(panel.getByRole("button", { name: /^Done/u })).toHaveAttribute("aria-expanded", "true");
    },
  },
  // Pointing at an item shows its Delete; Clear done takes the done ones off at once, with Undo in its toast.
  {
    id: "shell",
    route: `${CHAT}/checklist`,
    fixtures: ["checklist-listed"],
    variant: "panel-checklist-hover",
    open: async (page) => {
      const panel = page.getByRole("complementary", { name: "Project panel" });
      await panel.locator('[data-item="4"]').hover();
      await expect(panel.getByRole("button", { name: "Delete “Gift cards apply before tax”" })).toBeVisible();
    },
  },
  {
    id: "shell",
    route: `${CHAT}/checklist`,
    fixtures: ["checklist-listed"],
    variant: "panel-checklist-cleared",
    open: async (page) => {
      const panel = page.getByRole("complementary", { name: "Project panel" });
      await panel.getByRole("button", { name: "Clear done" }).click();
      await expect(panel.getByRole("button", { name: "Clear done" })).toHaveCount(0);
      await page.getByRole("button", { name: "Undo" }).waitFor();
    },
  },
  {
    id: "shell",
    route: `${CHAT}/checklist`,
    fixtures: ["checklist-empty"],
    variant: "panel-checklist-empty",
    open: async (page) => {
      await page.getByRole("complementary", { name: "Project panel" }).getByText("No checklist yet").waitFor();
    },
  },
  // The panel's Train: a PR in CI with its checks, the line with its held and sent-back PRs, merges and a refusal; a
  // batch of three in CI; the shared fixtures' train (fixtures/prs's PRs); nothing on it; on its way; and failing.
  { id: "train", route: `${CHAT}/train`, fixtures: ["train-full", "train-batch", "train-empty", "typical", "long-text"] },
  { id: "train", route: `${CHAT}/train`, fixtures: ["train-error"], expect: "error" },
  {
    id: "train",
    route: CHAT,
    fixtures: ["train-loading"],
    variant: "loading",
    open: whileLoading(async (page) => {
      await page.evaluate((r) => {
        window.location.hash = r;
      }, `${CHAT}/train`);
    }, (page) => page.getByLabel("Loading the merge train")),
  },
  // The panel's Activity: storefront's feed; nothing yet; failing; a hub without events_list; and on its way.
  { id: "activity", route: `${CHAT}/activity`, fixtures: ["typical", "long-text", "activity-none", "activity-error", "activity-old-hub"] },
  {
    id: "activity",
    route: CHAT,
    fixtures: ["activity-loading"],
    variant: "loading",
    open: whileLoading(async (page) => {
      await page.evaluate((r) => {
        window.location.hash = r;
      }, `${CHAT}/activity`);
    }, (page) => page.getByLabel("Loading the activity")),
  },
  // The panel's Decisions: what the lead and you settled; none yet; failing; and on its way.
  { id: "decisions", route: `${CHAT}/decisions`, fixtures: ["typical", "long-text", "decisions-none"] },
  { id: "decisions", route: `${CHAT}/decisions`, fixtures: ["decisions-error"], expect: "error" },
  {
    id: "decisions",
    route: CHAT,
    fixtures: ["decisions-loading"],
    variant: "loading",
    open: whileLoading(async (page) => {
      await page.evaluate((r) => {
        window.location.hash = r;
      }, `${CHAT}/decisions`);
    }, (page) => page.getByLabel("Loading the decisions")),
  },
  // Resized from its edge with the keyboard: at its widest, and at its narrowest, where the tabs fold to icons.
  {
    id: "shell",
    route: CHAT,
    fixtures: ["checklist-listed"],
    variant: "panel-widest",
    open: async (page) => {
      const edge = page.getByRole("separator", { name: "Resize the panel" });
      await edge.focus();
      await edge.press("End");
      await expect(edge).toHaveAttribute("aria-valuenow", (await edge.getAttribute("aria-valuemax")) ?? "");
    },
  },
  {
    id: "shell",
    route: CHAT,
    fixtures: ["checklist-listed"],
    variant: "panel-narrowest",
    open: async (page) => {
      const edge = page.getByRole("separator", { name: "Resize the panel" });
      await edge.focus();
      await edge.press("Home");
      await expect(edge).toHaveAttribute("aria-valuenow", "320");
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
      await page.getByRole("button", { name: "Show the panel" }).click();
      await page.getByRole("complementary", { name: "Project panel" }).waitFor();
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
      // From the top of the chat, so the shot doesn't depend on where hovering the bubble scrolled it.
      await page.getByLabel("Conversation with the lead").evaluate((el) => el.scrollTo({ top: 0, behavior: "instant" }));
      const bubble = page.locator('[data-bubble="text"]').filter({ hasText: "Nightly was green" }).locator("..");
      await bubble.hover();
      await bubble.getByRole("button", { name: "Tapback" }).click();
      await page.getByRole("button", { name: "Love" }).click();
      await page.getByRole("img", { name: "You reacted: Love" }).waitFor({ timeout: 5_000 });
      await page.getByRole("dialog", { name: "Tapbacks" }).waitFor({ state: "hidden", timeout: 5_000 });
      await page.mouse.move(0, 0);
    },
  },
  // The tapback picker open while its bubble scrolls up out of the chat: it hides with the bubble rather than
  // following it to the window's top edge.
  {
    id: "chat",
    route: CHAT,
    fixtures: ["bubbles-casual"],
    variant: "tapback-scrolled",
    sizes: ["small"],
    open: async (page) => {
      const log = page.getByLabel("Conversation with the lead");
      await log.evaluate((el) => el.scrollTo({ top: 0, behavior: "instant" }));
      const bubble = page.locator('[data-bubble="text"]').filter({ hasText: "Morning." }).locator("..");
      const tapback = bubble.getByRole("button", { name: "Tapback" });
      await bubble.hover();
      await tapback.click();
      const picker = page.getByRole("dialog", { name: "Tapbacks" });
      await picker.waitFor({ timeout: 5_000 });
      // Scrolled so that the picker, flipped below the button (6 px under it), would put its tapbacks 2 px from the
      // window's top.
      const [box, surface, pick] = await Promise.all([tapback.boundingBox(), picker.boundingBox(), picker.getByRole("button").first().boundingBox()]);
      if (box === null || surface === null || pick === null) throw new Error("the Tapback button or its picker has no box");
      await log.evaluate((el, by) => el.scrollBy({ top: by, behavior: "instant" }), box.y + box.height + 6 + (pick.y - surface.y) - 2);
      const after = await tapback.boundingBox();
      if (after === null || after.y + after.height > -5) throw new Error("the chat didn't scroll the bubble past the window's top");
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
  // The lead writes a moment, then its reply arrives whole: the typing cells give way to the reply's bubble. Replayed
  // with the chat open, so the reply reaches it.
  { id: "chat", route: CHAT, fixtures: ["stream-reply"], variant: "reply-arrives", replay: true },
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
  // A9 (F9): Max agents beside the panel's working count ("6 working · max 12"), a link to the project's slider in
  // Settings, which it opens focused (Settings has the slider itself under settings.agents).
  {
    id: "settings.agents",
    route: `${CHAT}/agents`,
    fixtures: ["settings-agents"],
    variant: "from-panel",
    open: async (page) => {
      await page.getByRole("link", { name: /^Max agents: \d+$/u }).click();
      await expect(page.getByRole("slider", { name: "storefront" })).toBeFocused();
    },
  },
  // W89: one header row. The panel runs from the window's top, its tabs beside the chat's title: the two rows share a
  // top, a height and the hairline under them, and the bar carries no state word and no agents counter. The panel's
  // toggle stays at the window's top right, so the click that closed the panel opens it again in the same place.
  {
    id: "chat",
    route: `${CHAT}/agents`,
    fixtures: ["typical"],
    variant: "one-header-row",
    open: async (page) => {
      const tabs = page.locator("#project-panel").getByRole("tablist").first();
      await tabs.waitFor();
      const rows = await tabs.evaluate((list) => {
        const bar = document.querySelector("header");
        const head = list.parentElement;
        if (bar === null || head === null) return null;
        // The hairline is each row's bottom border, so one bottom edge is one line.
        const box = (el: Element) => ({ top: el.getBoundingClientRect().top, height: el.getBoundingClientRect().height, line: getComputedStyle(el).borderBottomWidth });
        return { bar: box(bar), panel: box(head) };
      });
      expect(rows).not.toBeNull();
      expect(rows?.panel).toEqual(rows?.bar);
      await expect(page.getByRole("button", { name: /^Max agents/u })).toHaveCount(0);
      const toggle = page.locator('[data-opens="panel"]');
      const open = await toggle.boundingBox();
      await toggle.click();
      await expect(toggle).toHaveAttribute("aria-pressed", "false");
      expect(await toggle.boundingBox()).toEqual(open);
      await toggle.click();
      await expect(toggle).toHaveAttribute("aria-pressed", "true");
      expect(await toggle.boundingBox()).toEqual(open);
      await page.locator("#project-panel").getByRole("tablist").first().waitFor();
    },
  },
  // C1 and W38: updates. The sidebar's line above the connection for each state that has one, and the sheet the
  // palette's "Check for updates" opens, for every state of this app (not checked yet, checking, a build that doesn't
  // update, up to date, found, downloading to restart, ready, the deb's command, a failed check, a failed download), of
  // the hub and its machines (up to date, version unknown, a newer build on the channel, older than this app, one
  // machine behind), and of an Update run already going when the sheet opens (the hub restarting, the machines).
  {
    id: "shell",
    route: "#/",
    fixtures: ["updates-available", "updates-downloading", "updates-ready", "updates-hub-behind", "updates-run-hub"],
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
      "updates-node-behind",
      "updates-everything",
      "updates-hub-ready",
      "updates-run-hub",
      "updates-run-nodes",
    ],
    open: openUpdates,
  },
  // W38: the one Update button, pressed: how each part ended (all updated and this app last; the hub's download
  // refused by its checksum; the hub put back; machines put back, failed or offline), and a key the hub refuses.
  {
    id: "updates",
    route: "#/",
    fixtures: ["updates-run-done", "updates-run-hub-failed", "updates-run-hub-rolled-back", "updates-run-nodes-mixed", "updates-hub-ready", "updates-refused"],
    variant: "pressed",
    open: async (page) => {
      await openUpdates(page);
      await page.getByRole("button", { name: "Update", exact: true }).click();
      await page.locator('[data-updates-part="all"] [role="alert"], [data-updates-part="all"] [role="status"]').first().waitFor();
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
      (page) => page.getByRole("tab", { name: /^Shipping/u }).click({ timeout: 10_000 }),
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
  // W58's Try it on #14: its writer's suggestion in the overview with Try it beside it, and the lead's proposed Try it
  // setting in the chat; a start played through to the page; the preview starting, ready, marked up and its feedback
  // sent; failed and ended; the merge line's Try it; and a read key, which gets no Try it to press (D162).
  { id: "prs.detail", route: PR(14), fixtures: ["tryit-fresh"], variant: "try-suggested" },
  {
    id: "chat",
    route: CHAT,
    fixtures: ["tryit-fresh"],
    variant: "try-suggested",
    open: async (page) => {
      await expect(page.getByRole("note").filter({ hasText: "suggests trying it" })).toBeVisible();
      await expect(page.getByText("Try it setting", { exact: true })).toBeVisible();
    },
  },
  {
    id: "tryit",
    route: PR(14),
    fixtures: ["tryit-fresh"],
    variant: "started",
    open: async (page) => {
      await page.getByRole("button", { name: "Try #14" }).first().click();
      await expect(page.locator('[data-screen="tryit.ready"]')).toBeVisible({ timeout: 15_000 });
      await expect(page.getByRole("application", { name: "The preview: your clicks and keys go to it" }).locator("img")).toBeVisible();
    },
  },
  ...(["tryit-starting", "tryit-ready", "tryit-failed", "tryit-ended"] as const).map(
    (fixture): Screen => ({ id: "tryit", route: PR(14), fixtures: [fixture], open: (page) => page.getByRole("tab", { name: "Try it" }).click() }),
  ),
  { id: "tryit", route: PR(14), fixtures: ["tryit-ready"], variant: "marked", open: markUp },
  {
    id: "tryit",
    route: PR(14),
    fixtures: ["tryit-ready"],
    variant: "sent",
    open: async (page) => {
      await markUp(page);
      await page.getByRole("button", { name: "Send to #14’s agents" }).click();
      await expect(page.getByText("Sent to #14’s writer, at its next step.", { exact: true })).toBeVisible();
    },
  },
  // The merge line only reopens (phase 1 starts none there): #9's preview is ready, the others have none.
  {
    id: "train",
    route: `${CHAT}/train`,
    fixtures: ["tryit-ready"],
    variant: "try",
    open: async (page) => {
      await expect(page.getByRole("button", { name: "Open #9’s preview, ready" })).toBeVisible();
      await expect(page.getByRole("button", { name: /^Try #/u })).toHaveCount(0);
    },
  },
  // ...and a read key with #14's preview running: it uses the page, with no Mark up, Send or End.
  {
    id: "tryit",
    route: PR(14),
    fixtures: ["tryit-read-ready"],
    open: async (page) => {
      await page.getByRole("tab", { name: "Try it" }).click();
      await expect(page.getByRole("application", { name: "The preview: your clicks and keys go to it" })).toBeVisible();
      // The chat's composer has a Send of its own: only the preview's are counted.
      await expect(page.getByRole("button", { name: /^(Mark up|End|Send to #14)/u })).toHaveCount(0);
    },
  },
  {
    id: "prs.detail",
    route: PR(14),
    fixtures: ["tryit-read"],
    variant: "read",
    open: async (page) => {
      await expect(page.getByRole("note").filter({ hasText: "suggests trying it" })).toBeVisible();
      await expect(page.getByRole("button", { name: "Try #14" })).toHaveCount(0);
    },
  },

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
  // W100: the hub admin's setup (a design prototype, docs/design/setup.md): the welcome, a step open beside the list
  // (Claude to do, the GitHub App, the Google client), and the end.
  { id: "setup.welcome", route: "#/setup/welcome", fixtures: ["setup-fresh"] },
  { id: "setup", route: "#/setup/claude", fixtures: ["setup-fresh", "setup-claude-logins", "setup-github"], variant: "claude" },
  { id: "setup", route: "#/setup/github", fixtures: ["setup-github"], variant: "github" },
  { id: "setup", route: "#/setup/google", fixtures: ["setup-google"], variant: "google" },
  { id: "setup.done", route: "#/setup/done", fixtures: ["setup-done"] },
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
  // W46: the Agents section's Sessions from a hub that serves them (fixtures/sessions): needs you, live and recent; one
  // live (the page the full width, no Steps beside it), one asking you to take over, one taken over (the page yours),
  // handed back with ⌘⇧↩; recorded ones replayed the full width, their steps closed, then opened with Steps, with a
  // video and without, a step's page snapshot open; one being saved, one lost and one expired.
  { id: "sessions", route: `${CHAT}/sessions`, fixtures: ["sessions-preview"] },
  // ...and a hub that doesn't serve them (every other fixture's): the link opens Agents, with no Sessions beside it.
  {
    id: "agents",
    route: `${CHAT}/sessions`,
    fixtures: ["typical"],
    variant: "no-sessions",
    open: async (page) => {
      await expect(page.locator('[data-screen="agents"]')).toBeVisible();
      await expect(page.getByRole("tab", { name: /^Screens/u })).toHaveCount(0);
    },
  },
  {
    id: "sessions",
    route: SESSION_ROUTE(SESSION.checkout),
    fixtures: ["sessions-preview"],
    variant: "live",
    open: async (page) => {
      await expect(page.getByRole("img", { name: /^The page: https:\/\/staging\.shop/u })).toBeVisible();
      await expect(page.getByText("Steps", { exact: true })).toHaveCount(0);
    },
  },
  { id: "sessions", route: SESSION_ROUTE(SESSION.payouts), fixtures: ["sessions-preview"], variant: "asking" },
  {
    id: "sessions",
    route: SESSION_ROUTE(SESSION.payouts),
    fixtures: ["sessions-preview"],
    variant: "yours",
    open: async (page, app) => {
      await page.getByRole("button", { name: "Take over", exact: true }).click();
      await expect(page.getByRole("button", { name: /^Hand back/u })).toBeVisible();
      await expect(page.getByRole("application", { name: "The page: your clicks and keys go to it" })).toBeFocused();
      // ⌘V (Ctrl+V) pastes this computer's clipboard into the page: the paste reaches the frame, which sends its text.
      await app.evaluate(({ clipboard }) => clipboard.writeText("482913"));
      // The listener is in place before the key is pressed: the evaluate and the key reach the page by different
      // paths, and a key that came first went unheard, its paste waited for until the test timed out.
      type Pasted = Window & { pasted?: { text: string; taken: boolean } };
      await page.evaluate(() => {
        window.addEventListener(
          "paste",
          (e) => {
            (window as Pasted).pasted = { text: e.clipboardData?.getData("text/plain") ?? "", taken: e.defaultPrevented };
          },
          { once: true },
        );
      });
      await page.keyboard.press("ControlOrMeta+V");
      await expect.poll(() => page.evaluate(() => (window as Pasted).pasted ?? null)).toEqual({ text: "482913", taken: true });
    },
  },
  // ...taken over, ⌘⇧↩ (Ctrl+Shift+Enter) hands it back: the keymap takes the keys before the page does.
  {
    id: "sessions",
    route: SESSION_ROUTE(SESSION.payouts),
    fixtures: ["sessions-preview"],
    variant: "handed-back",
    open: async (page) => {
      await page.getByRole("button", { name: "Take over", exact: true }).click();
      await page.getByRole("application").focus();
      await page.keyboard.press("ControlOrMeta+Shift+Enter");
      await expect(page.getByText("handing back", { exact: true })).toBeVisible();
    },
  },
  // ...and in a window of its own, the pop-out for taking over: the session alone, its page yours.
  {
    id: "session-window",
    route: `#/session/devbox/dcffccea-c5a7-40a6-940d-7f70239ffa22/${SESSION.payouts}`,
    fixtures: ["sessions-preview"],
    open: async (page) => {
      await page.reload();
      await page.getByRole("button", { name: "Take over", exact: true }).click();
      await expect(page.getByRole("button", { name: /^Hand back/u })).toBeVisible();
    },
  },
  {
    id: "sessions",
    route: SESSION_ROUTE(SESSION.share),
    fixtures: ["sessions-preview"],
    variant: "replay",
    open: async (page) => {
      await expect(page.locator("video")).toHaveCount(1);
      await expect(page.getByRole("button", { name: "Steps", exact: true })).toHaveAttribute("aria-pressed", "false");
      await expect(page.getByRole("list", { name: /^Its steps/u })).toHaveCount(0);
    },
  },
  // ...its steps opened with Steps, beside the recording.
  {
    id: "sessions",
    route: SESSION_ROUTE(SESSION.share),
    fixtures: ["sessions-preview"],
    variant: "steps",
    open: async (page) => {
      await page.getByRole("button", { name: "Steps", exact: true }).click();
      await expect(page.getByRole("list", { name: /^Its steps/u })).toBeVisible();
    },
  },
  // ...with a step's page snapshot open: the structure as the step found it, what it clicked highlighted.
  {
    id: "sessions",
    route: SESSION_ROUTE(SESSION.share),
    fixtures: ["sessions-preview"],
    variant: "snapshot",
    open: async (page) => {
      // A click by the agent's ref: the node's target finds it in the page and on the video.
      await page.getByRole("button", { name: "Steps", exact: true }).click();
      await page.getByRole("button", { name: "The page at 0:06" }).click();
      await expect(page.getByRole("list", { name: "The page’s structure" })).toBeVisible();
      await expect(page.locator("[data-target]")).toHaveText(/button.*Share.*clicked/u);
      await expect(page.locator("[data-target-box]")).toHaveCount(1);
    },
  },
  // ...recorded without a video (no ffmpeg on its machine), a login filled from 1Password in its steps and its
  // snapshot.
  {
    id: "sessions",
    route: SESSION_ROUTE(SESSION.pricing),
    fixtures: ["sessions-preview"],
    variant: "no-video",
    open: async (page) => {
      await page.getByRole("button", { name: "Steps", exact: true }).click();
      await expect(page.getByText("Filled login for staging.shop.example.com from 1Password")).toBeVisible();
      await page.getByRole("button", { name: "The page at 0:04" }).click();
      await expect(page.getByText("filled from 1Password, hidden")).toBeVisible();
    },
  },
  { id: "sessions", route: SESSION_ROUTE(SESSION.saving), fixtures: ["sessions-preview"], variant: "saving" },
  { id: "sessions", route: SESSION_ROUTE(SESSION.receipt), fixtures: ["sessions-preview"], variant: "lost" },
  { id: "sessions", route: SESSION_ROUTE(SESSION.expired), fixtures: ["sessions-preview"], variant: "expired" },
  // ...and an agent asking you to take over its browser, in its own view.
  { id: "agents", route: `${CHAT}/agents/T4`, fixtures: ["sessions-preview"], variant: "browser" },
  // ...and offline with nothing held: it says they show once you're connected, never loading bars.
  {
    id: "agents",
    route: `${CHAT}/agents`,
    fixtures: ["offline-held"],
    variant: "offline",
    open: (page) => expect(page.getByText("Agents show once you’re connected.")).toBeVisible(),
  },
  // ...and under them, folded, Also on this repo: the live work on storefront's repo that isn't its agents'. Opened, a
  // person's claim (who holds it, when it expires), checkout's agent and PR, an agent key's claim and an open PR
  // outside fleetd; what landed and the expired claim are not there.
  {
    id: "agents",
    route: `${CHAT}/agents`,
    fixtures: ["agents-elsewhere"],
    variant: "elsewhere",
    open: async (page) => {
      await page.getByRole("button", { name: /^Also on this repo/u }).click();
      await expect(page.getByText(/^held by you \(laptop\) · expires in \d+ h$/u)).toBeVisible();
      await expect(page.getByText(/^pushed straight to main/u)).toBeHidden();
    },
  },
  // ...checkout's, with no agents of its own: a note, then the same work seen from checkout (storefront's agent).
  {
    id: "agents",
    route: ELSEWHERE_IDLE_ROUTE,
    fixtures: ["agents-elsewhere"],
    variant: "elsewhere-idle",
    open: async (page) => {
      await expect(page.getByText("No agents are working here.")).toBeVisible();
      await page.getByRole("button", { name: /^Also on this repo/u }).click();
      await expect(page.getByText("storefront’s agent · running")).toBeVisible();
    },
  },
  // ...and with All projects, it gives way to every project's agents.
  {
    id: "agents",
    route: `${CHAT}/agents`,
    fixtures: ["agents-elsewhere"],
    variant: "elsewhere-all",
    open: async (page) => {
      await expect(page.getByRole("button", { name: /^Also on this repo/u })).toBeVisible();
      await page.getByRole("button", { name: "All projects" }).click();
      await expect(page.getByRole("button", { name: /^Also on this repo/u })).toBeHidden();
    },
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
  // Every live state's glyph at once (ui/DESIGN.md): working, thinking, waiting on you, queued and paused; a queued
  // agent starts thinking a moment in. Each glyph is labelled with its state for a screen reader.
  {
    id: "agents",
    route: `${CHAT}/agents`,
    fixtures: ["agents-states"],
    variant: "states",
    replay: true,
    open: async (page) => {
      const list = page.getByRole("list", { name: "Agents" });
      for (const state of ["needs you", "paused", "thinking", "working"]) await expect(list.getByRole("img", { name: state }).first()).toBeVisible();
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
  // A machine's row opened (its facts, its projects with their menus, the way to its roles) and the checks that pass.
  {
    id: "machines",
    route: "#/machines",
    fixtures: ["projects-machines", "long-text"],
    variant: "open",
    open: async (page) => {
      await page.getByRole("button", { name: "devbox details" }).click();
      await page.getByRole("list", { name: "Projects on devbox" }).waitFor();
      await page.getByRole("button", { name: /^\d+ (passing|more)$/u }).click();
      await page.getByRole("region", { name: "Setup checks" }).getByText("Hub reachable").waitFor();
    },
  },
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
  // Administration: People as the owner (every row changeable but their own) and as an admin (the owner out of
  // reach); Invites with Dana's waiting, and a new one just made with its link; Hub settings (the fleet and machine
  // caps, task profiles, machine roles, memory caps); Setup's placeholder; and a member who follows a link there.
  { id: "admin.people", route: "#/admin/people", fixtures: ["admin-owner", "admin-admin", "admin-old-hub"] },
  { id: "admin.invites", route: "#/admin/invites", fixtures: ["admin-owner", "admin-old-hub"] },
  {
    id: "admin.invites",
    route: "#/admin/invites",
    fixtures: ["admin-owner"],
    variant: "created",
    open: async (page) => {
      await page.getByLabel("Name").fill("Eve Park");
      await page.getByRole("button", { name: "Create invite link" }).click();
      await page.getByRole("region", { name: "Invite link for Eve Park" }).getByRole("button", { name: "Copy link" }).waitFor();
    },
  },
  // Machines: Add machine's three ways in; a host the hub can reach and its plan; a run going; a failed step with Retry.
  { id: "admin.machines", route: "#/admin/machines", fixtures: ["machines-add", "machines-running", "machines-failed"] },
  {
    id: "admin.machines",
    route: "#/admin/machines",
    fixtures: ["machines-add"],
    variant: "hosts",
    open: async (page) => {
      await page.getByRole("button", { name: "Choose…" }).click();
      await page.getByRole("list", { name: "Hosts" }).waitFor();
    },
  },
  {
    id: "admin.machines",
    route: "#/admin/machines",
    fixtures: ["machines-add"],
    variant: "plan",
    open: async (page) => {
      await page.getByRole("button", { name: "Choose…" }).click();
      await page.getByRole("button", { name: "Plan…" }).first().click();
      await page.getByRole("button", { name: "Add builder-1" }).waitFor();
    },
  },
  { id: "admin.hub", route: "#/admin/hub", fixtures: ["admin-owner", "settings-agents", "admin-old-hub"] },
  { id: "admin.setup", route: "#/admin/setup", fixtures: ["admin-owner"] },
  { id: "admin.denied", route: "#/admin/people", fixtures: ["admin-member"] },
  // No hub and nothing kept from one: connect first, never Loading… for ever.
  { id: "admin.offline", route: "#/admin/people", fixtures: ["hub-unreachable"] },
  // Machines on Administration: devbox's auto 22 and where it comes from, a machine set to 40 with the way back to
  // auto.
  {
    id: "admin.hub",
    route: "#/admin/hub",
    fixtures: ["settings-machines"],
    variant: "machines",
    open: async (page) => {
      const machines = page.getByRole("region", { name: "Machines" });
      await machines.scrollIntoViewIfNeeded();
      await machines.getByText("Auto: memory 60 GB, about 2 GB an agent.").waitFor();
      await machines.getByRole("button", { name: "Use auto" }).waitFor();
    },
  },
  // storefront set to 30 on devbox, which holds it at 22: the line, and for an admin the way to Administration.
  {
    id: "settings.agents",
    route: "#/settings/agents",
    fixtures: ["settings-machines"],
    variant: "machine-holds",
    open: async (page) => {
      const storefront = page.getByRole("region", { name: "storefront" });
      await storefront.scrollIntoViewIfNeeded();
      await storefront.getByRole("button", { name: "Machine caps in Administration" }).waitFor();
    },
  },
  // The two task profiles on Administration, with the fleet's model and effort behind each; and each project's medium
  // switch in Settings: storefront's off in settings-medium-off.
  {
    id: "admin.hub",
    route: "#/admin/hub",
    fixtures: ["settings-agents"],
    variant: "profiles",
    open: async (page) => {
      const profiles = page.getByRole("region", { name: "Task profiles" });
      await profiles.scrollIntoViewIfNeeded();
      await profiles.getByText("New agents run on claude-sonnet-5-5 at medium effort.").waitFor();
    },
  },
  {
    id: "settings.agents",
    route: "#/settings/agents",
    fixtures: ["settings-agents", "settings-medium-off"],
    variant: "medium",
    open: (page) => page.getByRole("region", { name: "storefront" }).getByRole("switch", { name: /Medium allowed/u }).waitFor(),
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
  // A project's own max goes back to the default: storefront's 12 to the fleet's 16, with Undo.
  {
    id: "settings.agents",
    route: "#/settings/agents",
    fixtures: ["settings-agents"],
    variant: "to-default",
    open: async (page) => {
      const storefront = page.getByRole("region", { name: "storefront" });
      await storefront.getByText("Set for this project. The default is 16.").waitFor();
      await storefront.getByRole("button", { name: "Use the default" }).click();
      await storefront.getByText("Max agents, the default: 16, was 12.").waitFor();
      await storefront.getByText("Follows the default: the whole fleet's cap.").waitFor();
    },
  },
  {
    id: "admin.hub",
    route: "#/admin/hub",
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
  // Memory: user.md with what the lead remembered, then one project's MEMORY.md and a topic.
  { id: "settings.memory", route: "#/settings/memory", fixtures: ["typical", "empty", "hub-unreachable"] },
  { id: "settings.memory", route: "#/settings/memory?for=devbox/dcffccea-c5a7-40a6-940d-7f70239ffa22", fixtures: ["typical", "long-text"], variant: "project" },
  // An entry being edited in its card, and a topic open as text.
  {
    id: "settings.memory",
    route: "#/settings/memory?for=devbox/dcffccea-c5a7-40a6-940d-7f70239ffa22",
    fixtures: ["typical"],
    variant: "editing",
    open: async (page) => {
      await page.getByRole("button", { name: "Edit “No npm here: use pnpm.”" }).click();
      await page.getByRole("textbox", { name: "Edit the entry in MEMORY.md" }).fill("No npm here: use pnpm, and pin its version.");
      await page.getByRole("region", { name: "deploys (deploys.md)" }).getByRole("button", { name: "Edit as text" }).click();
      await expect(page.getByRole("textbox", { name: "All of deploys.md" })).toBeVisible();
    },
  },
  // A deleted entry, gone from its file, with Undo in the toast.
  {
    id: "settings.memory",
    route: "#/settings/memory",
    fixtures: ["typical"],
    variant: "deleted",
    open: async (page) => {
      await page.getByRole("button", { name: "Delete “Never estimate time.”" }).click();
      await expect(page.getByRole("button", { name: "Undo" })).toBeVisible();
    },
  },
  // Automations: one project's schedule, webhook and paused automations, a run history with its orders, and the editor.
  { id: "settings.automations", route: "#/settings/automations", fixtures: ["empty", "hub-unreachable"] },
  { id: "settings.automations", route: "#/settings/automations?for=devbox/dcffccea-c5a7-40a6-940d-7f70239ffa22", fixtures: ["typical", "long-text"] },
  {
    id: "settings.automations",
    route: "#/settings/automations?for=devbox/dcffccea-c5a7-40a6-940d-7f70239ffa22",
    fixtures: ["typical"],
    variant: "runs",
    open: (page) => page.getByRole("region", { name: "Weekday dependency check" }).getByRole("button", { name: "Runs" }).click(),
  },
  {
    id: "settings.automations",
    route: "#/settings/automations?for=devbox/dcffccea-c5a7-40a6-940d-7f70239ffa22",
    fixtures: ["typical"],
    variant: "editor",
    open: (page) => page.getByRole("region", { name: "Weekday dependency check" }).getByRole("button", { name: "Edit" }).click(),
  },
  // Skills: the global ones (one installed and pinned), then storefront's: its repo's .agents/skills and
  // .claude/skills, its own (one outranked by the repo's of the same name) and the global ones; a hub skill open to
  // edit, a repo skill open to read, New and Install.
  { id: "settings.skills", route: "#/settings/skills", fixtures: ["typical", "empty", "hub-unreachable"] },
  { id: "settings.skills", route: "#/settings/skills?for=devbox/dcffccea-c5a7-40a6-940d-7f70239ffa22", fixtures: ["typical", "long-text"], variant: "project" },
  {
    id: "settings.skills",
    route: "#/settings/skills?for=devbox/dcffccea-c5a7-40a6-940d-7f70239ffa22",
    fixtures: ["typical"],
    variant: "edit",
    open: async (page) => {
      await page.getByRole("button", { name: /^checkout-qa/u }).click();
      await expect(page.getByRole("textbox", { name: "SKILL.md" })).toHaveValue(/name: checkout-qa/u);
    },
  },
  {
    id: "settings.skills",
    route: "#/settings/skills?for=devbox/dcffccea-c5a7-40a6-940d-7f70239ffa22",
    fixtures: ["typical"],
    variant: "repo",
    open: async (page) => {
      await page.getByRole("button", { name: /^triage/u }).click();
      await expect(page.getByRole("textbox", { name: "SKILL.md" })).toHaveValue(/name: triage/u);
    },
  },
  {
    id: "settings.skills",
    route: "#/settings/skills",
    fixtures: ["typical"],
    variant: "installed",
    open: async (page) => {
      await page.getByRole("button", { name: /^pr-review/u }).click();
      await expect(page.getByRole("button", { name: "Update" })).toBeVisible();
    },
  },
  {
    id: "settings.skills",
    route: "#/settings/skills?for=devbox/dcffccea-c5a7-40a6-940d-7f70239ffa22",
    fixtures: ["typical"],
    variant: "new",
    open: async (page) => {
      await page.getByRole("button", { name: "New skill" }).click();
      await page.getByRole("textbox", { name: "Name" }).fill("Release Notes");
    },
  },
  {
    id: "settings.skills",
    route: "#/settings/skills",
    fixtures: ["typical"],
    variant: "install",
    open: async (page) => {
      await page.getByRole("button", { name: "Install from a source…" }).click();
      await page.getByRole("textbox", { name: "Source" }).fill("acme/agent-skills");
      await page.getByRole("button", { name: "Install", exact: true }).click();
      await page.getByText(/^Installed pr-review, pinned/u).waitFor();
    },
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
  // F6: Status, one row per project: every state word, its work in groups, long titles, no projects, quiet sources,
  // the skeleton before the first answer, and the link down.
  {
    id: "status.fleet",
    route: "#/status",
    fixtures: ["typical", "status-rows", "long-text", "empty", "many-agents", "hub-unreachable", "status-stale", "status-skeleton"],
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
  // A finding's spans, then one span's transcript with its item marked (the selected fill, no coloured edge).
  {
    id: "time",
    route: "#/time/order/W8",
    fixtures: ["typical"],
    variant: "transcript",
    open: async (page) => {
      await page.getByRole("tab", { name: "Insights" }).click();
      await page.getByRole("button", { name: /^Show \d+ spans?$/u }).first().click();
      await page.getByRole("button", { name: "List them" }).click();
      await page.getByRole("dialog").getByRole("button", { disabled: false }).filter({ hasText: /\d/u }).first().click();
      await page.locator('li[aria-current="true"]').waitFor();
    },
  },
];

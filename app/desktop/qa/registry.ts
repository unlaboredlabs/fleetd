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
import { AGENT, AGENT_ROUTE, ELSEWHERE_IDLE_ROUTE } from "../fixtures/agents/route.ts";
import { STEER_WORDS } from "../fixtures/agents/steers.ts";
import { SESSION } from "../fixtures/sessions/ids.ts";
import { CHAT_SENDS } from "../fixtures/composer/sends.ts";
import { OFFLINE_SENDS } from "../fixtures/offline/sends.ts";
import { ADA, ADA_ROUTE, HOME_ROUTE, TAXES_ROUTE } from "../fixtures/no-repo/ids.ts";
import { notches, scrollMoves, watchScroll } from "./scroll.ts";

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

/** New screen's iPhone Duo, opened from the Agents tab's plus: its live view, closed, with its toolbar. */
const openDuo = async (page: Page) => {
  await page.getByRole("button", { name: "New screen", exact: true }).click();
  await page.getByRole("radio", { name: /^iPhone/u }).click();
  await page.getByRole("combobox", { name: "Model" }).click();
  await page.getByRole("option", { name: "iPhone Duo" }).click();
  await page.getByRole("button", { name: "Open screen" }).click();
  await expect(page.getByRole("toolbar", { name: "Device" }).getByRole("button", { name: "Closed" })).toBeVisible();
};

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
  // ...with storefront allowing only the default profile (fixtures/settings).
  "settings-default-profile-only",
  // A machine past its memory estimate, and a project set past its machine (fixtures/settings).
  "settings-machines",
  // ...and the fleet's second machine as the agents' Mac, ready: its Screens row has only its own screen (fixtures/settings).
  "settings-agents-mac",
  // Settings' Hub group (fixtures/admin): an owner's hub with three people and an invite waiting, as its owner, an admin and
  // a member.
  "admin-owner",
  "admin-admin",
  "admin-owner-here",
  "admin-member",
  // ...and a hub from before people, whose People and Invites ask for an update.
  "admin-old-hub",
  // ...and with several hubs: the Hub group names the one it manages, and switches among those Sam administers.
  "admin-hubs",
  // Teams step 8 (fixtures/admin): Bob on a hub that keeps its Claude API key for leads, with no subscription of his own.
  "admin-claude-member",
  "admin-google",
  // The Vault (fixtures/vault): the team's items with two of Sam's set aside, as a member, on a hub from before it, and empty.
  "vault-team",
  "vault-team-member",
  "vault-old-hub",
  "vault-empty",
  // Connections (fixtures/connections, D653): nothing connected, some, a failing Test, OAuth pending, a custom MCP on
  // the tailnet (Tailscale connected and not), and as a member.
  "connections-empty",
  "connections-some",
  "connections-failing",
  "connections-oauth",
  "connections-tailnet",
  "connections-tailnet-off",
  "connections-member",
  // Hub › Machines (fixtures/machines): Add machine's three ways in, a run at its install step, and one
  // stopped at the node's service with its output and Retry.
  "machines-add",
  "machines-running",
  "machines-failed",
  // ...any other machine's line with laptop's node online a moment later, and laptop's page: nothing about its checks
  // while they pass, a row for claude logged out, and one for a screen kind it can't host yet.
  "machines-joined",
  "machines-well",
  "machines-logged-out",
  "machines-warning",
  "machines-one",
  "machines-unwell",
  // ...the team's own hosted sandbox account in Machines' Sandboxes section: none yet, and connected with its key refused.
  "machines-sandboxes-off",
  "machines-sandboxes-on",
  // ...a hub that had Revyl connected before fleetd removed it: one line says so (D576).
  "machines-revyl-removed",
  // ...the team's tailnet for its hosted sandboxes (W722): none, waiting for the sign-in, connected, and failed.
  "machines-tailscale-off",
  "machines-tailscale-login",
  "machines-tailscale-on",
  "machines-tailscale-failed",
  // ...and one that had E2B and Daytona connected before fleetd removed them: a line each (D576).
  "machines-e2b-removed",
  // ...and the page as one model (W693): several machines with each one's state and load, both kinds of provider
  // connected or not.
  "machines-places",
  "machines-places-one",
  // ...and no machine of the team's, its hosted agents with no Claude account (W721).
  "machines-none",
  // ...and boat.dev's row's own states (W743): starting, ready with how many run, and refused for billing.
  "machines-hosted-starting",
  "machines-hosted-ready",
  "machines-hosted-refused",
  // F2: the lead chat's island with 0, 1, 3 and 20 agents at work, and with 1 or 20 while the lead's turn runs
  // (fixtures/live).
  "live-0",
  "live-1",
  "live-3",
  "live-20",
  "live-1-lead",
  "live-20-lead",
  // ...and with 1 beside the band's other capsule: the lead's question, waiting on you.
  "live-1-question",
  // W651: the island over the composer, quiet, crowded (a long red main), and with a file name too long for any band.
  "live-band-quiet",
  "live-band-starting",
  "live-band-crowded",
  "live-band-long",
  // W685: no agent at work, the lead writing, and the agents' DMs: the island's card holds the DMs alone.
  "live-band-dms",
  // F4: the chat composer's sends (fixtures/composer).
  "composer-sends",
  "composer-waiting",
  // The lead mid-turn: the line in the composer's band counts up and says what it does now and what the turn did; and
  // once it's over, its reply's stamp says how long it worked (fixtures/lead).
  "lead-planning",
  "lead-long",
  "lead-counting",
  "lead-worked",
  // With no agents at work, the line has a capsule of its own, over late pictures scrolled up (fixtures/lead).
  "lead-pictures",
  // W669: start, then a steer, nothing from the lead yet: Stop, and the lead's glyph alone in the island (fixtures/lead).
  "lead-steered",
  // The night's memory refresh line: its summary, opened to its changes (fixtures/lead).
  "lead-memory",
  // The nightly cleanup's line for the worktrees it kept: its summary, opened to each (fixtures/lead).
  "lead-worktrees",
  // The lead's setup changes, each a line with Open and Undo (fixtures/lead).
  "lead-setup",
  // Group fixtures (fixtures/<group>/index.ts), named <group>-<what>.
  "projects-cloning",
  "projects-dropped",
  "projects-new",
  // W100: the hub admin's setup, a design prototype (fixtures/setup).
  "setup-fresh",
  "setup-claude-logins",
  "setup-github",
  "setup-done",
  "setup-all",
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
  // fleetd cloud's Sign in, on a build that has it (fixtures/cloud): the two ways in, how a sign-in fails, Connect a
  // computer on a team with no machine, and the account in Settings.
  "cloud-first-screen",
  "cloud-sign-in-refused",
  "cloud-sign-in-timeout",
  "cloud-signed-in",
  "cloud-invited",
  "cloud-no-team",
  "cloud-connect",
  "cloud-connect-no-terminal",
  "cloud-hosted-stuck",
  "cloud-account",
  "cloud-account-signed-out",
  // ...and New workspace in the switcher, refused at the most one person may make.
  "cloud-workspace-cap",
  "cloud-account-delete",
  "cloud-account-delete-blocked",
  // ...and People on a team: its owner and an admin invite by email, a member sees no People page, and a team at its
  // limit refuses an invite.
  "cloud-people-owner",
  "cloud-people-admin",
  "cloud-people-member",
  "cloud-people-limit",
  "cloud-admin",
  // ...and the team's GitHub step with fleetd's one App: to install, installed, Connect GitHub first, not set up.
  "cloud-github-install",
  "cloud-github-installed",
  "cloud-github-connect-first",
  "cloud-github-not-set-up",
  // ...and Billing on a team: no plan, a plan with credits, a declined card, the cap reached, and the team not
  // answering; and before fleetd's computers are on for it, beside a self-hosted hub: no Billing at all.
  "cloud-billing-none",
  "cloud-billing-plan",
  "cloud-billing-failed",
  "cloud-billing-cap",
  "cloud-billing-off",
  "cloud-billing-unreachable",
  // ...and a spend warning at 80% of the cap; Sign-in set and empty; spend limits on People, on a bot, and a member's own.
  "cloud-billing-warned",
  "cloud-signin-set",
  "cloud-signin-empty",
  "cloud-people-limits",
  "cloud-limits-bot",
  "cloud-people-member-limit",
  // Hub › Machines on fleetd's computers: no machine of the team's own, one beside them, and a cloud before the pick.
  "cloud-fleetd-only",
  "cloud-fleetd-own",
  "cloud-fleetd-older",
  "projects-errors",
  // E3b's eight-project mix (all four words, stale, a ~120-character name).
  "status-rows",
  // status-rows with search blocked by a usage pause on buildbox: the reason with Resume, over the composer
  // (fixtures/topbar).
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
  // diff, agent cards, the lead asking, and messages from Shortcuts and the Share Sheet.
  // The tagged chat (fixtures/tags): Sam and Dana's, three orders open and one closed; one order open; the trial off.
  "tags-busy",
  "tags-one-order",
  "tags-off",
  "bubbles-casual",
  "bubbles-charts",
  "bubbles-pr",
  "bubbles-agent",
  "bubbles-ask",
  "bubbles-sources",
  "bubbles-preview",
  // F5 (A5): a chat with every state of the two inline items (fixtures/inline), with every answer failing, and with
  // two approvals the hub reopens after Approve.
  "inline-items",
  "inline-failures",
  "inline-reopened",
  // A project's integration cards (fixtures/inline/integrations.json).
  "inline-integrations",
  // A lead's proposals for a new project (fixtures/inline/propose.json).
  "inline-propose",
  // A project's approval checker at work (fixtures/inline/checker.json), and its approvals in its settings
  // (fixtures/integrations).
  "inline-checker",
  "integrations-approvals",
  // ...and a busy project's 400 of them, read in pages (W601).
  "integrations-approvals-long",
  // A project's servers that sign in with OAuth (fixtures/integrations).
  "integrations-signin",
  // A bot's Computer, one fixture an image state, and a bot with two repos (fixtures/computer, W705).
  "computer-ready",
  "computer-building",
  "computer-failed",
  "computer-new",
  "computer-nowhere",
  "computer-two",
  // Runs on, the bot's one pick of provider and size, and a pick whose provider went (fixtures/computer, W720).
  "computer-runs-on",
  "computer-runs-on-gone",
  // A project's secure input: a passport number to type (fixtures/inline/secure.json).
  "inline-secure",
  // A bot's sign-in forms: filled and saved, a code to enter, a sign-in waiting (fixtures/inline/sign-in.json).
  "inline-sign-in",
  // Approvals whose fields hide or reorder text (fixtures/inline/hidden.json).
  "inline-hidden",
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
  // Each project's bot in a color of its own (fixtures/sidebar).
  "sidebar-colors",
  // Three pinned: a long name, one that waits on you, one with a new reply (fixtures/sidebar).
  "sidebar-pins",
  // Your sections, Clients and Later, under two pinned and a chat in none; and the same beside another hub's.
  "sidebar-sections",
  "sidebar-sections-hubs",
  // Three hubs, nineteen bots, each with pins and sections: what each of the sidebar's layouts has to carry.
  "sidebar-many-hubs",
  // Several hubs: Personal and Acme in one sidebar, and Acme unreachable beside Personal.
  "sidebar-hubs",
  "sidebar-hubs-offline",
  "agents-work",
  // ...with its steers that ended otherwise: never replied to, withdrawn, failed (fixtures/agents).
  "agents-steers",
  // The panel's Checklist tab: a list the lead keeps, and none yet (fixtures/checklist).
  "checklist-listed",
  "checklist-empty",
  "artifacts-published",
  // The chat's search and pins (fixtures/find): searchable with nothing pinned, one pin, three pins.
  "find-search",
  "find-pin-one",
  "find-pins",
  "artifacts-none",
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
  // W533: agents' DMs to each other, on an agent's work, in Activity and in the lead chat's island (fixtures/dms).
  "dms-relays",
  // W46's design preview: storefront's browser sessions, one agent driving and one asking you to take over
  // (fixtures/sessions).
  "sessions-preview",
  // D305: the Screens page, across projects, one with no repo among them, and three machines (fixtures/sessions).
  "sessions-page",
  // W96: what there is to look at, two of the lead's nudges, with nothing waiting (fixtures/look).
  "look-two",
  "stream-reply",
  // UX [7]: no hub, and the last launch's disk cache on screen with a message queued; back online with that chat not
  // read again yet, and with that read failed (fixtures/offline).
  "offline-held",
  "offline-reread",
  "offline-reread-failed",
  // ...and a reconnect after a wake: quiet for its first seconds, then said without sending anyone to check the address.
  "offline-waking",
  "offline-waking-long",
  // ...and the inline items' chat from the cache, with no hub (fixtures/inline).
  "inline-offline",
  // The sequences that blanked the window (fixtures/resilience): a hub restart mid-chat, a burst of plan items with
  // a new reply streaming, and the link dropping mid-reply.
  "resilience-burst",
  "resilience-hub-restart",
  "resilience-reconnect-streaming",
  // ...and the bot on screen removed while its chat is open (W890).
  "resilience-bot-removed",
  // W733: a busy bot's long chat with pictures, read up through, and the link dropping while scrolled up (fixtures/scroll).
  "scroll-still",
  "scroll-drop",
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
  "updates-run-left-over",
  "updates-auto-on",
  "updates-auto-held",
  "updates-auto-current",
  // A hub on 0.9.3 with 0.9.4 ready (release.version-scheme): Update to 0.9.4 under your name.
  "updates-numbered",
  "updates-put-back",
  "updates-updated",
  // Projects with no repo (fixtures/no-repo): Ada and Home in the sidebar and Taxes archived, Ada asking to book a
  // table and following work it asked for.
  "no-repo-chats",
  // Ada's settings page (fixtures/no-repo).
  "no-repo-settings",
  // Ada's settings while storefront shares her repo, so its merge train (fixtures/no-repo, W845).
  "no-repo-shared-train",
  // Files both ways in a no-repo project's chat (fixtures/no-repo): a lease and a bank export in, a trip PDF and
  // receipts out.
  "no-repo-files",
  // Pictures both ways there (fixtures/no-repo): two screenshots in, a picture out.
  "no-repo-pictures",
  // fleetd.sh's showcase: one request played from send to merge, recorded by showcase.spec.ts (fixtures/showcase).
  "showcase-order",
  // The showcase with storefront, billing and Ada pinned: the sidebar's pinned grid (W565).
  "showcase-pins",
  // ...and with only billing pinned: a lone pin in the sidebar's middle (W574).
  "showcase-pin",
  // ...and with billing and Ada pinned: two side by side, a small gap between them (W577).
  "showcase-pins-two",
  // ...and with each bot in its own colour and body: the landing page's hero (W847).
  "showcase-hero",
  // The menu under your name (W607): Sam's hub with one thing off in each (fixtures/menu).
  "menu-setup",
  "menu-machine-offline",
  "menu-hosted-account",
  "menu-hosted-refused",
  "menu-offline",
  "menu-refused",
  "menu-updating",
  "menu-updated",
  "menu-update-failed",
  "menu-member-update-failed",
  "menu-member-no-machine",
  "menu-member-degraded",
  "menu-long-refused",
  "menu-long-offline",
  "menu-everything",
  "menu-app-update",
  // A cloud bot waking (W792): asleep at rest, its computer starting, slow, and a failed try (fixtures/wake).
  "wake-asleep",
  "wake-starting",
  "wake-slow",
  "wake-failed",
  "wake-stale",
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
  // A 14-inch laptop's screen in points (1512x993) under its 37 pt macOS menu bar: the landing page's hero shows the
  // app's window filling the rest.
  hero: { width: 1512, height: 956 },
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
  // Runs at every size and theme, once the view has settled and before its shot: what must hold in each (the band's
  // capsules as tall as each other).
  check?: (page: Page) => Promise<void>;
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
  // Shown in a frameless window of its own (the menu bar's popover), which has no traffic lights: the test's window
  // draws them, but nothing is held to their place.
  frameless?: true;
}

// The fixtures' storefront project, a real hub project from the sanitized recording, so its id is a UUID; it shows
// only in the route, never as text.
const CHAT = "#/project/devbox/dcffccea-c5a7-40a6-940d-7f70239ffa22";
/** A bot of another workspace (the person's screenshot, W890): no fixture's hub lists it. */
const STRAY_BOT = "#/project/hosted/9e95bb40-7023-4211-b29d-e790a41455c8";
/** One of storefront's browser sessions, open in the panel (fixtures/sessions). */
const SESSION_ROUTE = (id: string) => `${CHAT}/sessions/${id}`;

/** The chat at its narrowest: the narrow window with the sidebar and the panel open beside it. */
const narrowest = async (page: Page) => {
  await page.keyboard.press("ControlOrMeta+B");
  await page.getByRole("navigation", { name: "Sidebar" }).waitFor();
  const pill = page.locator('[data-opens="panel"]');
  if ((await pill.getAttribute("aria-pressed")) !== "true") await pill.click();
  await page.getByRole("complementary", { name: "Bot panel" }).waitFor();
};

/**
 * Hovers a bubble of bubbles-casual's, the lead's with the pointer on Reply (so its tooltip shows) or one of yours, and
 * measures its hover strip: beside the bubble's foot on its outer side, a gap off it, on none of it, inside the chat;
 * Reply's tooltip whole in the window.
 */
const hoverStrip = async (page: Page, side: "theirs" | "mine") => {
  const bubble = page.locator('[data-bubble="text"]').filter({ hasText: side === "theirs" ? "One flaky retry on checkout" : "how did the nightly go?" });
  const line = bubble.locator("..");
  const strip = line.locator('> [class*="aside"]');
  await bubble.hover();
  await expect(strip).toHaveCSS("opacity", "1");
  if (side === "theirs") {
    await strip.getByRole("button", { name: "Reply" }).hover();
    await page.locator("[data-side]").filter({ hasText: /^Reply$/u }).waitFor();
  }
  const [b, s, log] = await Promise.all([bubble.boundingBox(), strip.boundingBox(), page.getByLabel("Conversation with the lead").boundingBox()]);
  if (b === null || s === null || log === null) throw new Error("the bubble, its strip or the chat has no box");
  // Soft, so a size that fails is still shot for the contact sheet.
  expect.soft(Math.abs(s.y + s.height - (b.y + b.height)), "the strip's foot on the bubble's").toBeLessThanOrEqual(1);
  const gap = side === "theirs" ? s.x - (b.x + b.width) : b.x - (s.x + s.width);
  expect.soft(gap, "the strip beside the bubble, a 4 px gap off it").toBeCloseTo(4, 0);
  expect.soft(s.x, "the strip inside the chat").toBeGreaterThanOrEqual(log.x);
  expect.soft(s.x + s.width, "the strip inside the chat").toBeLessThanOrEqual(log.x + log.width);
  if (side === "theirs") {
    const tip = await page.locator("[data-side]").filter({ hasText: /^Reply$/u }).boundingBox();
    // An Electron page has no viewport size of Playwright's.
    const width = await page.evaluate(() => window.innerWidth);
    if (tip === null) throw new Error("Reply's tooltip has no box");
    expect.soft(tip.y, "Reply's tooltip whole in the window").toBeGreaterThanOrEqual(0);
    expect.soft(tip.x + tip.width, "Reply's tooltip whole in the window").toBeLessThanOrEqual(width);
  }
};

/** Makes a part throw while rendering, in the QA build (src/renderer/src/Boundary.tsx), so its error card shows. */
const crash = (part: string) => async (page: Page) => {
  await page.evaluate((p) => window.dispatchEvent(new CustomEvent("fleetd:qa-crash", { detail: p })), part);
};

/**
 * The window stops being the one in front, as when you switch to another app: nothing in it counts as looked at from
 * here on. A test's window otherwise has the focus (on Linux's offscreen display too), so what changes after a
 * moment's look changes under a run slow enough.
 */
const inBackground = async (page: Page) => {
  await page.evaluate(() => {
    document.hasFocus = () => false;
    window.dispatchEvent(new Event("blur"));
  });
};

/** Hub › Machines › Updates, as the palette's "Check for updates" opens it (the app menu runs the same command). */
const openUpdates = async (page: Page) => {
  await page.keyboard.press("ControlOrMeta+K");
  await page.getByRole("combobox", { name: "Search" }).fill("Check for updates");
  await page.keyboard.press("Enter");
};

// storefront's PRs in the panel beside its chat (fixtures/prs): the list, and #11 (its review asked for changes),
// #10 (checks failed), #8 (merged), #14 (a person's, review asked for) and #13 (240 files) open.
const PRS = `${CHAT}/prs`;
const PR = (n: number) => `${PRS}/acme/storefront/${String(n)}`;
/** A PR's changes, by the switch on its top line. */
const openChanges = async (page: Page) => {
  const changes = page.locator("button[data-changes]");
  await changes.click();
  await expect(changes).toHaveAttribute("aria-pressed", "true");
};
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

/**
 * The band over the chat's composer reads as one row: its capsules (the island, what needs you) are as tall as the
 * tokens say (--island-capsule-h) with the same rounding, their tops and bottoms on one line in a band of its own
 * height (--island-band-h), their words one size on one baseline, and their icons (the ×) on one centre.
 */
const bandIsOneRow =
  (...capsules: ReadonlyArray<"island" | "say">) =>
  async (page: Page) => {
    const band = await page.locator("[data-band]").evaluate((el) => {
      const token = (name: string) => parseFloat(getComputedStyle(el).getPropertyValue(name));
      const draw = document.createElement("canvas").getContext("2d");
      const capsules = [...el.querySelectorAll("[data-island] > :first-child, [data-say]")].filter((c) => c.getClientRects().length > 0);
      const words: Array<{ text: string; size: string; baseline: number }> = [];
      const icons: Array<{ icon: string; middle: number }> = [];
      for (const capsule of capsules) {
        const walker = document.createTreeWalker(capsule, NodeFilter.SHOW_TEXT);
        for (let n = walker.nextNode(); n; n = walker.nextNode()) {
          const at = n.parentElement;
          const text = n.textContent?.trim() ?? "";
          if (at === null || draw === null || text === "") continue;
          const range = document.createRange();
          range.selectNodeContents(n);
          const run = range.getClientRects()[0];
          // Words for a screen reader only have no place in the row.
          if (run === undefined || run.width <= 1 || at.getBoundingClientRect().width <= 1) continue;
          // A run's rect starts its font's ascent above its baseline.
          const style = getComputedStyle(at);
          draw.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
          words.push({ text, size: style.fontSize, baseline: run.top + draw.measureText(text).fontBoundingBoxAscent });
        }
        for (const svg of capsule.querySelectorAll("svg.lucide")) {
          const r = svg.getBoundingClientRect();
          icons.push({ icon: svg.getAttribute("class") ?? "", middle: (r.top + r.bottom) / 2 });
        }
      }
      return {
        height: el.getBoundingClientRect().height,
        bandH: token("--island-band-h"),
        capsuleH: token("--island-capsule-h"),
        capsules: capsules.map((c) => {
          const r = c.getBoundingClientRect();
          const round = getComputedStyle(c).borderTopLeftRadius;
          return { name: c.matches("[data-say]") ? "say" : "island", top: r.top, bottom: r.bottom, height: r.height, round };
        }),
        words,
        icons,
      };
    });
    const seen = JSON.stringify(band, null, 1);
    expect(band.capsules.map((c) => c.name), `the band's capsules: ${seen}`).toEqual(capsules);
    expect(band.height, `the band keeps its own height: ${seen}`).toBe(band.bandH);
    const [first] = band.capsules;
    for (const c of band.capsules) {
      expect(c, `capsules of one height on one line: ${seen}`).toEqual({ ...c, height: band.capsuleH, top: first?.top, bottom: first?.bottom, round: first?.round });
    }
    expect([...new Set(band.words.map((w) => w.size))], `the words are one size: ${seen}`).toHaveLength(1);
    const spread = (ys: readonly number[]) => Math.max(...ys) - Math.min(...ys);
    expect(spread(band.words.map((w) => w.baseline)), `the words sit on one baseline: ${seen}`).toBeLessThanOrEqual(0.5);
    expect(spread(band.icons.map((i) => i.middle)), `the icons sit on one centre: ${seen}`).toBeLessThanOrEqual(0.5);
  };

/**
 * The island over the composer (W651; the human's report on the strip before it: "the dms part outflows"): centred
 * over the composer's pill and inside it, as tall as the band's capsules, everything in it inside its glass with room
 * to spare, and a file name too long for the room cut once in the middle, its start and end kept, never at the
 * capsule's edge. At the end, the last message ends above the band.
 */
const islandHolds = async (page: Page) => {
  const seen = await page.locator("[data-band]").evaluate((band) => {
    const box = (r: DOMRect) => ({ left: r.left, right: r.right, top: r.top, height: r.height });
    const island = band.querySelector("[data-island] > :first-child");
    const pill = document.querySelector("[data-composer] > div");
    const leaves = [...(island?.querySelectorAll("*") ?? [])]
      .filter((e) => e.children.length === 0 && getComputedStyle(e).visibility !== "hidden" && e.getBoundingClientRect().width > 0)
      .map((e) => ({ text: e.textContent, ...box(e.getBoundingClientRect()) }));
    const names = [...(island?.querySelectorAll("code") ?? [])];
    const list = document.querySelector('[aria-label="Conversation with the lead"]');
    const last = [...(list?.querySelectorAll("[data-index]") ?? [])].at(-1);
    const end = list === null ? undefined : list.scrollHeight - list.scrollTop - list.clientHeight;
    return {
      island: island ? box(island.getBoundingClientRect()) : undefined,
      pill: pill ? box(pill.getBoundingClientRect()) : undefined,
      band: box(band.getBoundingClientRect()),
      capsuleH: parseFloat(getComputedStyle(band).getPropertyValue("--island-capsule-h")),
      leaves,
      // The whole name (unseen, holding its width) and the copy shown, and whether the shown one overflows its box.
      name: names.length === 2 ? { whole: names[0]?.textContent ?? "", shown: names[1]?.textContent ?? "", over: (names[1]?.scrollWidth ?? 0) > (names[1]?.clientWidth ?? 0) + 1 } : undefined,
      lastBottom: last === undefined ? undefined : Math.max(...[...last.querySelectorAll("*")].map((k) => k.getBoundingClientRect().bottom)),
      atEnd: end !== undefined && end <= 1,
    };
  });
  const said = JSON.stringify(seen, null, 1);
  const { island, pill } = seen;
  if (island === undefined || pill === undefined) throw new Error(`no island over the composer: ${said}`);
  expect(island.height, `as tall as the band's capsules: ${said}`).toBe(seen.capsuleH);
  expect(island.left, `inside the pill's left edge: ${said}`).toBeGreaterThanOrEqual(pill.left - 0.5);
  expect(island.right, `inside the pill's right edge: ${said}`).toBeLessThanOrEqual(pill.left + (pill.right - pill.left) + 0.5);
  expect(Math.abs(island.left - pill.left - (pill.right - island.right)), `centred over the pill: ${said}`).toBeLessThanOrEqual(1);
  for (const leaf of seen.leaves) {
    expect(leaf.left, `"${leaf.text}" keeps room from the island's left edge: ${said}`).toBeGreaterThanOrEqual(island.left + 8);
    expect(leaf.right, `"${leaf.text}" keeps room from the island's right edge: ${said}`).toBeLessThanOrEqual(island.right - 8);
  }
  if (seen.name !== undefined) {
    const { whole, shown, over } = seen.name;
    expect(over, `the name shown fits its box: ${said}`).toBe(false);
    if (shown !== whole) {
      const [head = "", tail = ""] = shown.split("…");
      expect(shown.split("…"), `cut once, in the middle: ${said}`).toHaveLength(2);
      expect(whole.startsWith(head) && whole.endsWith(tail), `its start and end kept: ${said}`).toBe(true);
      expect(Math.abs(head.length - tail.length), `as much of each: ${said}`).toBeLessThanOrEqual(1);
    }
  }
  if (seen.atEnd) expect(seen.lastBottom, `at the end, the last message ends above the band: ${said}`).toBeLessThan(island.top);
};

/**
 * The chat has landed at its end (its rows measured, its pictures loaded): before then "Latest ↓" shares the band and
 * pushes the island off the pill's centre.
 */
const atTheEnd = async (page: Page) => {
  const list = page.locator('[aria-label="Conversation with the lead"]');
  await expect.poll(() => list.evaluate((l) => l.scrollHeight - l.scrollTop - l.clientHeight <= 1), { timeout: 15_000 }).toBe(true);
};

/** The island says the lead works by its glyph alone (W669): no words, nothing to open. */
const leadGlyphAlone = async (page: Page) => {
  const island = page.locator("[data-band] > [data-island]");
  await expect(island).toBeVisible();
  await expect(island.locator("[data-state='working'], [data-state='thinking']")).toHaveCount(1);
  await expect(island).toHaveText("");
  await expect(island.locator("button")).toHaveCount(0);
};

/**
 * History's filter while it names a kind (the human's report, W621: a 24 px icon over the button's top edge with "DMs"
 * pushed under it): its icon at the button's 14 px and its label lie inside its box on one centre line, the icon
 * before the label, and the button is as tall as the picker under it and ends where it ends.
 */
const filterIsOneLine = async (page: Page) => {
  const seen = await page.locator("[data-filter]").evaluate((button) => {
    const box = (r: DOMRect | undefined) => (r === undefined ? undefined : { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height });
    const label = button.querySelector("span");
    const words = document.createRange();
    if (label !== null) words.selectNodeContents(label);
    return {
      button: box(button.getBoundingClientRect()),
      icon: box(button.querySelector("svg")?.getBoundingClientRect()),
      words: box(label === null ? undefined : words.getBoundingClientRect()),
      picker: box(document.querySelector('[aria-label="Whose DMs"]')?.getBoundingClientRect()),
    };
  });
  const said = JSON.stringify(seen, null, 1);
  const { button, icon, words, picker } = seen;
  if (button === undefined || icon === undefined || words === undefined || picker === undefined) throw new Error(`the filter, its icon, its label or the picker has no box: ${said}`);
  expect([icon.width, icon.height], `the icon's size: ${said}`).toEqual([14, 14]);
  for (const part of [icon, words]) {
    expect(part.top, `inside the button: ${said}`).toBeGreaterThanOrEqual(button.top);
    expect(part.bottom, `inside the button: ${said}`).toBeLessThanOrEqual(button.bottom);
    expect(part.left, `inside the button: ${said}`).toBeGreaterThanOrEqual(button.left);
    expect(part.right, `inside the button: ${said}`).toBeLessThanOrEqual(button.right);
    expect(Math.abs((part.top + part.bottom) / 2 - (button.top + button.bottom) / 2), `on the button's centre line: ${said}`).toBeLessThanOrEqual(1);
  }
  expect(icon.right, `the icon before the label: ${said}`).toBeLessThanOrEqual(words.left);
  expect(button.height, `as tall as the picker: ${said}`).toBe(picker.height);
  expect(Math.abs(button.right - picker.right), `ends where the picker ends: ${said}`).toBeLessThanOrEqual(0.5);
  expect(button.bottom, `over the picker: ${said}`).toBeLessThanOrEqual(picker.top);
};

/** An entry's name in test titles, shot files and the contact sheet. */
/** New bot's +: a repo typed into its field and added with Enter. */
/** Set up this Mac for agents: Allow each permission as its row asks (the screen capture one comes once Screen
 * Recording is on), until the Mac is ready. */
const allowAll = async (page: Page) => {
  const ready = page.getByRole("heading", { name: "This Mac is ready" });
  for (const end = Date.now() + 30_000; Date.now() < end; ) {
    if (await ready.isVisible()) return;
    const allow = page.getByRole("button", { name: "Allow", exact: true }).first();
    // The rows read the node every second: a button re-rendered mid-click is clicked again on the next pass.
    if (await allow.isVisible()) await allow.click({ timeout: 2000 }).catch(() => undefined);
    await page.waitForTimeout(300);
  }
  await ready.waitFor({ timeout: 1000 });
};

const addRepo = async (page: Page, text: string) => {
  await page.getByRole("button", { name: "Add a repo" }).click();
  await page.getByRole("combobox", { name: "Repo to add" }).fill(text);
  await page.keyboard.press("Enter");
  await expect(page.getByRole("combobox", { name: "Repo to add" })).toHaveCount(0);
};

export const label = (s: Pick<Screen, "id" | "variant">) => (s.variant === undefined ? s.id : `${s.id}~${s.variant}`);

export const screens: readonly Screen[] = [
  // F2 (A4), W651: the island, a small glass capsule centred just over the composer: what the lead does now when it
  // says more than its avatar does, a glyph per agent and how many, a red dot for a red main. live-0 and live-1 (the
  // lead idle or only working) draw it with the agents alone; live-band-long's file name is cut in the middle.
  {
    id: "chat",
    route: CHAT,
    fixtures: ["live-1", "live-3", "live-20", "live-1-lead", "live-20-lead", "live-band-quiet", "live-band-starting", "live-band-crowded", "live-band-long", "live-band-dms"],
    sizes: [...defaultSizes, "narrow"],
    variant: "island",
    check: islandHolds,
  },
  // W792: a cloud bot waking. Asleep at rest (in the sidebar and the title), then the bot in the reply's place while its
  // computer starts, past 30 s still waking with the time so far, and a failed try's reason with Try again; nothing
  // over the composer says it again.
  {
    id: "chat",
    route: CHAT,
    fixtures: ["wake-asleep", "wake-starting", "wake-slow", "wake-failed", "wake-stale"],
    sizes: [...defaultSizes, "narrow"],
    variant: "wake",
  },
  // ...and with no agent, no step worth saying and main green: nothing over the composer.
  {
    id: "chat",
    route: CHAT,
    fixtures: ["live-0"],
    variant: "island-none",
    open: async (page) => {
      await page.locator('[data-screen="chat"]').waitFor({ timeout: 30_000 });
      await expect(page.locator("[data-island]")).toHaveCount(0);
    },
  },
  // W533: the agents' DMs to each other, in the lead chat: their count in the island's card, a way to Activity's log.
  {
    id: "chat",
    route: CHAT,
    fixtures: ["dms-relays"],
    variant: "dm-count",
    open: async (page) => {
      await page.locator("[data-island] > button").click();
      await expect(page.getByRole("link", { name: "5 DMs between agents" })).toBeVisible();
    },
  },
  // W581: the band's two capsules, the island and the lead's question waiting on you (Show, ×), read as one row.
  {
    id: "chat",
    route: CHAT,
    fixtures: ["live-1-question"],
    sizes: [...defaultSizes, "narrow"],
    variant: "band",
    open: (page) => expect(page.locator("[data-say]").getByRole("button", { name: "Show" })).toBeVisible(),
    check: bandIsOneRow("island", "say"),
  },
  // ...and the × hides the question's capsule: neither the band nor the composer moves.
  {
    id: "chat",
    route: CHAT,
    fixtures: ["live-1-question"],
    variant: "band-hidden",
    open: async (page) => {
      const band = page.locator("[data-band]");
      const box = page.getByRole("textbox", { name: "Message the lead" });
      const before = [await band.boundingBox(), await box.boundingBox()];
      await page.locator("[data-say]").getByRole("button", { name: /^Hide until/u }).click();
      await expect(page.locator("[data-say]")).toBeHidden();
      expect([await band.boundingBox(), await box.boundingBox()]).toEqual(before);
    },
    check: bandIsOneRow("island"),
  },
  // A click on the island opens its card above it: main's reason in full, a row per agent, the agents' DMs.
  {
    id: "chat",
    route: CHAT,
    fixtures: ["live-3", "live-20", "live-band-crowded"],
    sizes: [...defaultSizes, "narrow"],
    variant: "island-open",
    open: async (page) => {
      await page.locator("[data-island] > button").click();
      await expect(page.getByRole("list", { name: "Agents at work" })).toBeVisible();
    },
  },
  // W685: ...and with no agent and no red main, the DMs alone: a capsule like the island, centred over it, as far above
  // it as it is above the composer, not a card as wide as the composer around one line.
  {
    id: "chat",
    route: CHAT,
    fixtures: ["live-band-dms"],
    sizes: [...defaultSizes, "narrow"],
    variant: "island-dms",
    open: async (page) => {
      await page.locator("[data-island] > button").click();
      await expect(page.getByRole("link", { name: "1,071 DMs between agents" })).toBeVisible();
    },
    check: async (page) => {
      const seen = await page.locator("[data-band]").evaluate((band) => {
        const box = (e: Element | Range | null) => {
          const r = e?.getBoundingClientRect();
          return r === undefined ? undefined : { left: r.left, right: r.right, top: r.top, bottom: r.bottom, height: r.height };
        };
        const words = document.createRange();
        words.selectNodeContents(band.querySelector("[data-island-card] a") ?? band);
        return {
          words: box(words),
          card: box(band.querySelector("[data-island-card]")),
          island: box(band.querySelector("[data-island] > :first-child")),
          pill: box(document.querySelector("[data-composer] > div")),
          capsuleH: parseFloat(getComputedStyle(band).getPropertyValue("--island-capsule-h")),
        };
      });
      const said = JSON.stringify(seen, null, 1);
      const { card, island, pill, words } = seen;
      if (card === undefined || island === undefined || pill === undefined || words === undefined) throw new Error(`no DMs capsule over the island: ${said}`);
      expect(card.height, `as tall as the island: ${said}`).toBe(seen.capsuleH);
      expect(Math.abs(words.top - card.top - (card.bottom - words.bottom)), `its words in its middle: ${said}`).toBeLessThanOrEqual(1);
      expect(Math.abs(card.left - pill.left - (pill.right - card.right)), `centred over the pill: ${said}`).toBeLessThanOrEqual(1);
      expect(Math.abs(island.top - card.bottom - (pill.top - island.bottom)), `the island's gap over the composer: ${said}`).toBeLessThanOrEqual(0.5);
    },
  },
  // F4 (A3): the composer under storefront's chat while the lead works. Sent from the box: refused (Resend, Edit,
  // Dismiss), cut off by the link, unanswered (Resend, Dismiss), and one still sending; then a message that found no
  // hub, queued to go when the link is back, and a file attached beside it. composer-waiting: the hub stored the
  // message, but the lead can't take it yet: the bot in the reply's place says why (W852).
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
      // The receipts at rest: off the bubbles, whose hover strip would show beside them.
      await page.mouse.move(0, 0);
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
      await expect(page.locator("[data-wake='held']")).toHaveText("devbox is offline; it starts when devbox is back.");
      await expect(page.locator("[data-wake] [data-typing]")).toHaveCount(0);
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
      // The pill has no line of hints: Send's says how.
      await page.getByRole("button", { name: "Send" }).hover();
      await expect(page.getByRole("tooltip").getByText(/stops its step and sends now/)).toBeVisible();
      await page.mouse.move(0, 0);
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
  // The lead at work: in the island over the composer, what it is doing now (lead-long: a file name cut in the middle);
  // lead-counting only works, so the island has its glyph alone; lead-worked: the turn is over, and its reply wears how
  // long it took.
  { id: "chat", route: CHAT, fixtures: ["lead-planning", "lead-long", "lead-counting"], variant: "activity", check: islandHolds },
  { id: "chat", route: CHAT, fixtures: ["lead-worked"], variant: "activity" },
  // The lead thinking with no agents at work, after a reply ending in two pictures that load late: the island has its
  // glyph alone, no words, at the end and scrolled up over the pictures.
  {
    id: "chat",
    route: CHAT,
    fixtures: ["lead-pictures"],
    variant: "turn-alone",
    open: async (page) => {
      await page.locator('[data-screen="chat"]').waitFor({ timeout: 30_000 });
      await atTheEnd(page);
      await leadGlyphAlone(page);
    },
    check: islandHolds,
  },
  // The human's screenshot (W669): "start", then "1-16" as a steer, nothing from the lead yet. The composer shows Stop
  // and says the lead reads it at its next step; the bot stands in the reply's place with its typing dots (W852), so
  // the island doesn't show the lead's glyph again.
  {
    id: "chat",
    route: CHAT,
    fixtures: ["lead-steered"],
    variant: "steered",
    open: async (page) => {
      await page.locator('[data-screen="chat"]').waitFor({ timeout: 30_000 });
      await expect(page.getByRole("button", { name: "Stop the lead and its agents" })).toBeVisible();
      await expect(page.getByRole("textbox", { name: "Message the lead" })).toHaveAttribute("placeholder", /It reads this at its next step/u);
      await atTheEnd(page);
      await expect(page.locator("[data-wake] [data-typing]")).toBeVisible();
      await expect(page.locator("[data-band] > [data-island]")).toHaveCount(0);
    },
  },
  {
    id: "chat",
    route: CHAT,
    fixtures: ["lead-pictures"],
    variant: "turn-alone-scrolled",
    open: async (page) => {
      await page.locator('[data-screen="chat"]').waitFor({ timeout: 30_000 });
      await expect(page.locator('[data-block="image"] img')).toHaveCount(2, { timeout: 10_000 });
      await page.getByRole("list", { name: "Conversation with the lead" }).hover();
      await page.mouse.wheel(0, -200);
      await expect(page.getByRole("button", { name: /Latest/u })).toBeVisible();
      await leadGlyphAlone(page);
    },
  },
  // The night's memory refresh: one summary line with Undo all, and opened, a row per change, one of them opened to
  // what it was.
  { id: "chat", route: CHAT, fixtures: ["lead-memory"], variant: "memory-refreshed" },
  {
    id: "chat",
    route: CHAT,
    fixtures: ["lead-memory"],
    variant: "memory-refreshed-open",
    open: async (page) => {
      await page.locator('[data-screen="chat"]').waitFor({ timeout: 30_000 });
      await page.getByRole("button", { name: "Memory tidied: 3 added, 1 updated, 2 removed" }).click();
      const changes = page.getByRole("list", { name: "Memory changes" });
      await changes.getByRole("button", { name: /^PR screenshots live/u }).click();
      await expect(changes.getByText(/^Was: /u)).toBeVisible();
    },
  },
  // The nightly cleanup's kept worktrees: one summary line, and opened, each with what is unsaved and its path.
  { id: "chat", route: CHAT, fixtures: ["lead-worktrees"], variant: "worktrees-kept" },
  {
    id: "chat",
    route: CHAT,
    fixtures: ["lead-worktrees"],
    variant: "worktrees-kept-open",
    open: async (page) => {
      await page.locator('[data-screen="chat"]').waitFor({ timeout: 30_000 });
      await page.getByRole("button", { name: "Cleanup kept 6 worktrees with unsaved work" }).click();
      await expect(page.getByRole("list", { name: "Worktrees kept" }).getByRole("listitem")).toHaveCount(6);
    },
  },
  // A lead's setup changes: one quiet line each with Open and Undo, an undone one saying so.
  {
    id: "chat",
    route: CHAT,
    fixtures: ["lead-setup"],
    variant: "setup-changed",
    open: async (page) => {
      await page.locator('[data-screen="chat"]').waitFor({ timeout: 30_000 });
      await expect(page.getByRole("button", { name: "Undo" })).toHaveCount(2);
      await expect(page.getByRole("button", { name: "Open" })).toHaveCount(3);
    },
    // Beside a line that fills the row, Undone stays one word on one line, never "Undo" over "ne".
    check: async (page) => {
      const word = await page.getByText("Undone", { exact: true }).boundingBox();
      expect(word?.height, "Undone's height: one line").toBeLessThanOrEqual(18);
    },
  },
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
    check: bandIsOneRow("island", "say"),
  },
  // A red main is the island's red dot, not a block, and its card says it in the hub's words (checkout's
  // `ios sessions`).
  {
    id: "chat",
    route: "#/project/devbox/6e8e753c-fe9a-4b79-aec3-5812d498c197",
    fixtures: ["sidebar-reasons"],
    variant: "red-main",
    open: async (page) => {
      await page.locator('[data-screen="chat"]').waitFor({ timeout: 30_000 });
      const island = page.locator("[data-island]");
      await island.getByRole("button", { name: "main is red" }).click();
      await expect(island.locator("[data-island-card]")).toHaveText("ios sessions is red on main, fix in progress");
    },
  },
  // A project blocked by its machine's usage pause: the reason over the composer, with Resume (search, on buildbox).
  {
    id: "chat",
    route: "#/project/buildbox/558dc655-fbca-48f0-abf1-6977a0709ea9",
    fixtures: ["topbar-paused"],
    variant: "usage-paused",
    open: async (page) => {
      const line = page.locator("[data-say]").locator('[data-attention="blocked"]');
      await expect(line).toContainText("Blocked: paused until Sun 23:40 UTC");
      await expect(line.getByRole("button", { name: /^Resume/u })).toBeVisible();
    },
    check: bandIsOneRow("say"),
  },
  // An empty chat's starter fills the box (never sends) and gives it the cursor. The bot has no repo, so its
  // starters ask nothing of code or CI.
  {
    id: "chat",
    route: CHAT,
    fixtures: ["chat-empty"],
    variant: "starter",
    open: async (page) => {
      await page.locator('[data-screen="chat"]').waitFor({ timeout: 30_000 });
      await expect(page.getByRole("button", { name: "Find what’s failing in CI and fix it." })).toHaveCount(0);
      await page.getByRole("button", { name: "Research something and write it up for me." }).click();
      const box = page.getByRole("textbox", { name: "Message the lead" });
      await expect(box).toHaveValue("Research something and write it up for me.");
      await expect(box).toBeFocused();
    },
  },
  // UX [7]: offline, the chat and the project list from the disk cache, marked offline as of the cache's time, with
  // the banner's Retry now; then a message typed offline joins the one already queued, each with Edit and Dismiss.
  { id: "chat", route: CHAT, fixtures: ["offline-held"], variant: "offline" },
  // What there is to look at, in a window in the background. In one in front, a flagged message is seen once it has
  // been in view for a second (screens/chat/looked.ts), and the line leaves: at 1920×1200 this whole conversation is in
  // view, as are the flagged two at every size while a shot walks the list. Linux is through each in under a second;
  // a macOS runner isn't, so its large dark shot had lost the line.
  {
    id: "chat",
    route: CHAT,
    fixtures: ["look-two"],
    variant: "look",
    open: async (page) => {
      await expect(page.locator("[data-say]").getByRole("button", { name: "Show" })).toBeVisible();
      await inBackground(page);
    },
    check: bandIsOneRow("island", "say"),
  },
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
      await expect(page.locator("[data-say]").getByText(/^Offline, as of/u)).toBeVisible();
    },
  },
  // W654: the computer woke and the link is dialled again. For its first seconds: no banner, the chat as it was (no
  // offline chip), and no line saying Stop waits for the hub.
  {
    id: "chat",
    route: CHAT,
    fixtures: ["offline-waking"],
    variant: "waking",
    sizes: ["small", "large"],
    open: async (page) => {
      await page.locator('[data-screen="chat"]').waitFor({ timeout: 30_000 });
      // The wake comes once the chat is up (fixtures/offline): reconnecting is quiet, so the hub switcher is unmarked and
      // its menu has no line under the hub.
      const switcher = page.locator("[data-opens='hubs']");
      await expect(switcher).not.toHaveAttribute("data-mark", /./u, { timeout: 15_000 });
      await switcher.click();
      await expect(page.getByRole("menu")).not.toContainText("Can't reach");
      await page.keyboard.press("Escape");
      await expect(page.locator('[data-banner="reconnecting"]')).toHaveCount(0);
      await expect(page.locator("[data-say]").getByText(/^Offline/u)).toHaveCount(0);
      await expect(page.getByText("Offline: stop the lead and its agents once the workspace is back.")).toHaveCount(0);
    },
  },
  // ...and a minute on: offline as of the wake, why, and that it reconnects by itself; never the address or update advice.
  {
    id: "chat",
    route: CHAT,
    fixtures: ["offline-waking-long"],
    variant: "waking-long",
    open: async (page) => {
      await page.locator('[data-screen="chat"]').waitFor({ timeout: 30_000 });
      const banner = page.locator('[data-banner="reconnecting"]');
      await expect(banner).toContainText("didn't answer in time", { timeout: 15_000 });
      await expect(banner).toContainText("reconnects by itself");
      await expect(banner).not.toContainText("fleetd update");
      await expect(banner).not.toContainText("address");
      await expect(page.locator("[data-say]").getByText(/^Offline, as of/u)).toBeVisible();
      await expect(page.getByText("Offline: stop the lead and its agents once the workspace is back.")).toBeVisible();
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
      await expect(page.locator("[data-say]").getByText(/^Last known, as of/u)).toBeVisible();
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
      await expect(page.locator("[data-say]").getByText(/^Last known, as of/u)).toBeVisible();
    },
  },
  // An agent in the island's card opens in the panel's agents, where its work is (the chat doesn't draw it itself):
  // the panel is closed first, so the shot shows the island's card opening it.
  {
    id: "chat",
    route: CHAT,
    fixtures: ["live-3", "live-20"],
    variant: "island-to-panel",
    open: async (page) => {
      const panel = page.getByRole("complementary", { name: "Bot panel" });
      await page.locator('[data-opens="panel"]').click();
      await panel.waitFor({ state: "detached" });
      const island = page.locator("[data-island]");
      await island.locator("> button").click();
      await island.getByRole("list", { name: "Agents at work" }).getByRole("link").first().click();
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
      await page.getByRole("complementary", { name: "Bot panel" }).locator('[data-screen^="prs.detail"]').waitFor();
      await expect(page).toHaveURL(/\/prs\/(acme\/storefront\/)?10$/u);
    },
  },
  // The lead chat (lead-chat-spec.md).
  // UX-1 [5]: a row that wants you (reply, approve, secret, blocked) ends in the warning's dot, and docs' reply that arrives
  // after the app opened is bold.
  { id: "shell", route: "#/", fixtures: ["sidebar-reasons"], variant: "sidebar" },
  // Each bot in the color and shape picked for it (W573, W774): every color of the vibrant palette and all five shapes,
  // mobile a grey Pebble, the defaults the hub names by none.
  {
    id: "shell",
    route: "#/",
    fixtures: ["sidebar-colors"],
    variant: "bot-colors",
    open: async (page) => {
      const bots = page.getByRole("navigation", { name: "Sidebar" }).locator("[data-bot][data-color]");
      await expect(bots.first()).toBeVisible();
      const colors = await bots.evaluateAll((els) => els.map((el) => el.getAttribute("data-color")));
      for (const c of ["mono", "brown", "red", "orange", "amber", "green", "teal", "blue", "purple", "pink", "grey"]) expect(colors).toContain(c);
      const shapes = await bots.evaluateAll((els) => els.map((el) => el.getAttribute("data-shape")));
      for (const s of ["pebble", "ghost", "kitty", "bunny", "toast"]) expect(shapes).toContain(s);
    },
  },
  // The hub switcher: the owner's hub marked while setup steps are left; a member's never is.
  { id: "shell", route: "#/", fixtures: ["admin-owner", "admin-member"], variant: "settings-entry" },
  // Several hubs: one at a time, the switcher marked while Acme is offline, which waits on its own while Personal
  // works on.
  { id: "shell", route: "#/", fixtures: ["sidebar-hubs", "sidebar-hubs-offline"], variant: "hubs" },
  // W772: two fingers across the sidebar switch hubs (screens/shell/hubSwipe.ts), as wheel events with a horizontal
  // delta. A scroll up and down the list never does; a swipe left goes to the next hub, once however far it goes, and
  // the marks at the foot follow. QA runs with reduced motion, so the hub switches without the slide. The screen goes
  // with it (W794): Acme's own chat, never Personal's left open beside Acme's list.
  {
    id: "shell",
    route: "#/",
    fixtures: ["sidebar-hubs", "sidebar-many-hubs"],
    variant: "hub-swipe",
    open: async (page) => {
      const box = await page.getByRole("navigation", { name: "Sidebar" }).boundingBox();
      if (box === null) throw new Error("no sidebar");
      const on = page.locator("[role='group'][aria-label='Workspaces'] button[aria-current]");
      await expect(on).toHaveAttribute("aria-label", "Personal");
      await page.mouse.move(box.x + box.width / 2, box.y + 160);
      for (const dy of [12, 24, 30, 24, 12]) await page.mouse.wheel(dy / 4, dy);
      await page.waitForTimeout(250);
      await expect(on).toHaveAttribute("aria-label", "Personal");
      // One long event, a gesture on its own however slow the runner is between two.
      await page.mouse.wheel(90, 0);
      await expect(on).toHaveAttribute("aria-label", "Acme");
      await expect(page.locator("[data-opens='hubs']")).toContainText("Acme");
      await expect.poll(() => page.evaluate(() => window.location.hash)).toMatch(/^#\/project\/.*\?at=h2$/);
      await page.mouse.move(600, 400);
    },
  },
  // The hub row's switcher, which carries a dot while another hub has a bot that wants you; its menu lists them all,
  // the one on show ticked, each other with its own dot, and Connect a self-hosted workspace (a build with no cloud).
  {
    id: "shell",
    route: "#/",
    fixtures: ["sidebar-hubs"],
    variant: "hub-switcher",
    open: async (page) => {
      await page.getByRole("button", { name: "Personal, another workspace needs you" }).click();
      await expect(page.getByRole("menuitem")).toHaveText(["PPersonal", "AAcme", "Connect a self-hosted workspace…"]);
    },
  },
  // A fleetd account's switcher ends with New workspace, then Connect a self-hosted workspace.
  {
    id: "shell",
    route: "#/",
    fixtures: ["cloud-workspace-cap"],
    variant: "workspace-switcher",
    open: async (page) => {
      await page.locator("[data-opens='hubs']").click();
      await expect(page.getByRole("menuitem")).toHaveText(["Aacme", "New workspace…", "Connect a self-hosted workspace…"]);
    },
  },
  // New workspace asks for a name; the cloud's refusal (the most one person may make) says what to do.
  {
    id: "shell",
    route: "#/",
    fixtures: ["cloud-workspace-cap"],
    variant: "new-workspace-refused",
    open: async (page) => {
      await page.locator("[data-opens='hubs']").click();
      await page.getByRole("menuitem", { name: "New workspace…" }).click();
      await page.getByLabel("Name").fill("Side project");
      await page.getByRole("button", { name: "Create" }).click();
      await expect(page.getByRole("alert")).toContainText("Delete one you don't use");
    },
  },
  {
    id: "chat",
    route: "#/project/buildbox/558dc655-fbca-48f0-abf1-6977a0709ea9?at=h2",
    fixtures: ["sidebar-hubs"],
    variant: "other-hub",
  },
  // One hub's page on the owner's hub: it lists your devices under the hub (`typical` has no answer for them).
  { id: "settings.hubs", route: "#/settings/hubs", fixtures: ["sidebar-hubs", "sidebar-hubs-offline", "admin-owner"] },
  // Restart hub, on the row of a hub the person administers: its confirm says what a restart does.
  {
    id: "settings.hubs",
    route: "#/settings/hubs",
    fixtures: ["admin-owner"],
    variant: "restart",
    open: async (page) => {
      // In the hub row's "…".
      await page.getByRole("button", { name: /: more$/u }).first().click();
      await page.getByRole("menuitem", { name: "Restart workspace…" }).click();
      await expect(page.getByRole("dialog", { name: "Restart the workspace?" })).toBeVisible();
    },
  },
  { id: "onboarding", route: "#/onboarding?add", fixtures: ["sidebar-hubs"], variant: "add-hub" },
  // Hidden with ⌘B in a wide window (it has no toggle icon): the top row runs the full width, after the traffic lights.
  {
    id: "shell",
    route: "#/",
    fixtures: ["chat-waiting"],
    variant: "sidebar-hidden",
    open: async (page) => {
      await page.keyboard.press("ControlOrMeta+B");
      await page.getByRole("navigation", { name: "Sidebar" }).waitFor({ state: "detached" });
    },
  },
  // The panel beside the chat, open on a first launch on its Agents tab, and closed with the chat's pill.
  {
    id: "shell",
    route: "#/",
    fixtures: ["chat-waiting", "agents-work"],
    variant: "panel",
    open: async (page) => {
      await page.getByRole("complementary", { name: "Bot panel" }).waitFor();
    },
  },
  {
    id: "shell",
    route: "#/",
    fixtures: ["chat-waiting"],
    variant: "panel-closed",
    open: async (page) => {
      await page.locator('[data-opens="panel"]').click();
      await page.getByRole("complementary", { name: "Bot panel" }).waitFor({ state: "detached" });
    },
  },
  // The chat's search (W773): ⌘F opens a glass field at the top row's end with the filters to pick; words find hits,
  // newest first with the words marked and a count; words that find nothing say so.
  {
    id: "chat",
    route: CHAT,
    fixtures: ["find-search"],
    variant: "find-open",
    open: async (page) => {
      await page.locator('[data-screen="chat"]').waitFor({ timeout: 30_000 });
      await page.keyboard.press("ControlOrMeta+F");
      const field = page.getByRole("combobox", { name: "Search this chat" });
      await expect(field).toBeFocused();
      await expect(page.getByRole("listbox", { name: "Filters" }).getByRole("option", { name: "From the lead" })).toBeVisible();
    },
  },
  {
    id: "chat",
    route: CHAT,
    fixtures: ["find-search"],
    variant: "find-hits",
    open: async (page) => {
      await page.locator('[data-screen="chat"]').waitFor({ timeout: 30_000 });
      await page.keyboard.press("ControlOrMeta+F");
      await page.getByRole("combobox", { name: "Search this chat" }).fill("deploy");
      const results = page.getByRole("listbox", { name: "Results" });
      await expect(results.getByRole("option").first()).toContainText("deploy");
      await expect(page.locator("[data-find]")).toContainText("4");
    },
  },
  // A filter alone, no words: its hits, not the filters left to pick.
  {
    id: "chat",
    route: CHAT,
    fixtures: ["find-search"],
    variant: "find-filter",
    open: async (page) => {
      await page.locator('[data-screen="chat"]').waitFor({ timeout: 30_000 });
      await page.keyboard.press("ControlOrMeta+F");
      await page.getByRole("listbox", { name: "Filters" }).getByRole("option", { name: "From the lead" }).click();
      await expect(page.getByRole("listbox", { name: "Results" }).getByRole("option").first()).toContainText("deploy");
      await expect(page.locator("[data-find]")).toContainText("From the lead");
    },
  },
  {
    id: "chat",
    route: CHAT,
    fixtures: ["find-search"],
    variant: "find-none",
    open: async (page) => {
      await page.locator('[data-screen="chat"]').waitFor({ timeout: 30_000 });
      await page.keyboard.press("ControlOrMeta+F");
      await page.getByRole("combobox", { name: "Search this chat" }).fill("kiwi");
      await expect(page.locator("[data-find]")).toContainText("No results");
    },
  },
  // Pins: the capsule under the chat's pill with the newest pin's first line; with several, its count, and a click
  // opens the panel's Pinned list.
  {
    id: "chat",
    route: CHAT,
    fixtures: ["find-pin-one"],
    variant: "pins-one",
    open: async (page) => {
      await expect(page.locator("[data-pins]")).toContainText("Three things before launch");
    },
  },
  {
    id: "chat",
    route: CHAT,
    fixtures: ["find-pins"],
    variant: "pins-several",
    open: async (page) => {
      await expect(page.locator('[data-pins="3"]')).toContainText("3");
    },
  },
  {
    id: "shell",
    route: CHAT,
    fixtures: ["find-pins"],
    variant: "panel-pinned",
    open: async (page) => {
      await page.locator('[data-pins="3"]').click();
      const panel = page.getByRole("complementary", { name: "Bot panel" });
      await expect(panel.locator('[data-pane="pinned"]').getByRole("listitem")).toHaveCount(3);
    },
  },
  // The panel's Artifacts (W367): the reports published in the chat, newest first; a Markdown one at an older version
  // a card opened, with its version picker; an HTML one in its sandboxed frame, drawn by its own script; and none yet.
  {
    id: "shell",
    route: `${CHAT}/artifacts`,
    fixtures: ["artifacts-published"],
    variant: "panel-artifacts",
    open: async (page) => {
      await page.getByRole("complementary", { name: "Bot panel" }).locator('[data-screen="artifacts"]').waitFor();
    },
  },
  {
    id: "shell",
    route: `${CHAT}/artifacts/dependency-sweep`,
    fixtures: ["artifacts-published"],
    variant: "panel-artifact-md",
    open: async (page) => {
      await page.getByRole("complementary", { name: "Bot panel" }).locator('[data-screen="artifact"]').waitFor();
    },
  },
  {
    id: "shell",
    route: `${CHAT}/artifacts/dependency-sweep/1`,
    fixtures: ["artifacts-published"],
    variant: "panel-artifact-older",
    open: async (page) => {
      const panel = page.getByRole("complementary", { name: "Bot panel" });
      await expect(panel.getByRole("button", { name: "Show the newest" })).toBeVisible();
    },
  },
  {
    id: "shell",
    route: `${CHAT}/artifacts/build-times`,
    fixtures: ["artifacts-published"],
    variant: "panel-artifact-html",
    open: async (page) => {
      await expect(page.frameLocator('iframe[sandbox="allow-scripts"]').locator("rect.bar")).toHaveCount(6);
    },
  },
  {
    id: "shell",
    route: `${CHAT}/artifacts`,
    fixtures: ["artifacts-none"],
    variant: "panel-artifacts-empty",
    open: async (page) => {
      await page.getByRole("complementary", { name: "Bot panel" }).locator('[data-screen="artifacts.empty"]').waitFor();
    },
  },
  // The panel's Plan: how far along, doing and to do, done folded; done unfolded; and none set yet.
  {
    id: "shell",
    route: `${CHAT}/checklist`,
    fixtures: ["checklist-listed"],
    variant: "panel-checklist",
    open: async (page) => {
      await page.getByRole("complementary", { name: "Bot panel" }).locator('[data-screen="checklist"]').waitFor();
      await expect(page.getByRole("progressbar", { name: "Checklist progress" })).toHaveAttribute("aria-valuenow", "2");
    },
  },
  {
    id: "shell",
    route: `${CHAT}/checklist`,
    fixtures: ["checklist-listed"],
    variant: "panel-checklist-done",
    open: async (page) => {
      const panel = page.getByRole("complementary", { name: "Bot panel" });
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
      const panel = page.getByRole("complementary", { name: "Bot panel" });
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
      const panel = page.getByRole("complementary", { name: "Bot panel" });
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
      await page.getByRole("complementary", { name: "Bot panel" }).getByText("No plan yet").waitFor();
    },
  },
  // Shipping at its merge line (a link to the train): a PR in CI as a card with its checks among the PRs, the ones that
  // need a look above it and the line behind it, what landed folded; a batch of three in CI; the shared fixtures' train
  // (fixtures/prs's PRs); nothing on it; on its way (the PRs listed, the card still to come); and failing.
  { id: "train", route: `${CHAT}/train`, fixtures: ["train-full", "train-batch", "train-empty", "typical", "long-text"] },
  // The PRs are listed while the train's read retries; the alert over them comes once it has given up.
  {
    id: "train",
    route: `${CHAT}/train`,
    fixtures: ["train-error"],
    expect: "error",
    open: (page) => page.locator('[data-screen="train.error"]').waitFor({ timeout: 15_000 }),
  },
  {
    id: "train",
    route: CHAT,
    fixtures: ["train-loading"],
    variant: "loading",
    open: whileLoading(async (page) => {
      await page.evaluate((r) => {
        window.location.hash = r;
      }, `${CHAT}/train`);
    }, (page) => page.locator('[data-screen="train.loading"]')),
  },
  // History: storefront's feed under the way to its decisions; nothing yet; failing; a hub without events_list; and on
  // its way.
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
  // W533: Activity's DMs log, as the island's card opens it, with a DM to three and the guard's refused wake opened;
  // and All, where a pair's DMs of an hour fold into one row and the refused wake has its own line. The filter names
  // DMs there: one line in its box at every size, the panel 320 px wide in the small window and 420 in the medium.
  {
    id: "activity",
    route: `${CHAT}/activity/dms`,
    fixtures: ["dms-relays"],
    variant: "dms",
    open: async (page) => {
      for (const id of ["M5", "M1"]) await page.locator(`[data-dm="${id}"] > button`).click();
      await expect(page.getByRole("definition").filter({ hasText: "wasn’t woken" })).toBeVisible();
    },
    check: filterIsOneLine,
  },
  {
    id: "activity",
    route: `${CHAT}/activity`,
    fixtures: ["dms-relays"],
    variant: "dms-all",
    open: async (page) => {
      await page.getByRole("button", { name: /3 DMs/u }).click();
      await expect(page.getByRole("button", { name: /3 DMs/u })).toHaveAttribute("aria-expanded", "true");
    },
  },
  // History's decisions, a row away from it: what the lead and you settled; none yet; failing; and on its way.
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
  // Projects with no repo (fixtures/no-repo): Ada and Home in the one Projects list, Taxes archived and out of it;
  // Ada's chat with its booking to approve, beside the work it asked other projects for (under its plan).
  {
    id: "chat",
    route: `${ADA_ROUTE}/asked`,
    fixtures: ["no-repo-chats"],
    variant: "no-repo",
    open: async (page) => {
      const panel = page.getByRole("complementary", { name: "Bot panel" });
      await panel.locator('[data-screen="asked"]').waitFor();
      await expect(page.getByRole("textbox", { name: "Message the lead" })).toBeVisible();
      await expect(page.getByRole("navigation", { name: "Sidebar" })).not.toContainText("Taxes");
    },
  },
  // Asked work opened: a long ask the person's words were relayed in, and the follow-up folded into its order.
  {
    id: "chat",
    route: `${ADA_ROUTE}/asked`,
    fixtures: ["no-repo-chats"],
    variant: "asked-open",
    open: async (page) => {
      const panel = page.getByRole("complementary", { name: "Bot panel" });
      await panel.locator('[data-screen="asked"]').waitFor();
      for (const ask of ["N7", "N8"]) {
        const row = panel.locator(`[data-ask="${ask}"] > button`);
        await row.click();
        await expect(row).toHaveAttribute("aria-expanded", "true");
      }
    },
  },
  // One of a project's skills (skills/SkillsPane), with no tab of its own (the list is Settings › Agents › Skills):
  // rendered, in the wide panel; its history, the newest version open to its diff.
  {
    id: "chat",
    route: `${ADA_ROUTE}/skills/weekly-invoices`,
    fixtures: ["no-repo-chats"],
    variant: "skill",
    open: async (page) => {
      await page.getByRole("complementary", { name: "Bot panel" }).locator('[data-screen="skill"]').waitFor();
    },
  },
  {
    id: "chat",
    route: `${ADA_ROUTE}/skills/weekly-invoices`,
    fixtures: ["no-repo-chats"],
    variant: "skill-history",
    open: async (page) => {
      const panel = page.getByRole("complementary", { name: "Bot panel" });
      await panel.getByRole("button", { name: /^History/u }).click();
      await panel.getByRole("region", { name: "Version 2 to 3" }).waitFor();
    },
  },
  // Files both ways: the person's .docx and .csv, and the PDF and CSV the lead made, each a card with Open and Save.
  {
    id: "chat",
    route: HOME_ROUTE,
    fixtures: ["no-repo-files"],
    variant: "files",
    open: async (page) => {
      await expect(page.getByRole("button", { name: "Save lisbon-itinerary.pdf" })).toBeVisible();
      await expect(page.getByText("Word document · 47 KB")).toBeVisible();
    },
  },
  // A picture under the pointer: its download button in its corner, which saves it to Downloads in one click.
  {
    id: "chat",
    route: HOME_ROUTE,
    fixtures: ["no-repo-pictures"],
    variant: "picture-save",
    open: async (page) => {
      await expect(page.getByRole("button", { name: "Open The checkout with the code applied" })).toBeVisible();
      // ...and one on each picture the person sent.
      await expect(page.getByRole("button", { name: "Save lamp.jpg" })).toBeAttached();
      await expect(page.getByRole("button", { name: "Save checkout.jpg" })).toBeAttached();
    },
    // The pointer goes back on the picture at each size (the window's resize moved the picture from under it): the
    // button shows, 32 px round and 8 px in from the picture's top right corner (the 4/8 grid, W694), and the
    // picture stays where it was.
    check: async (page) => {
      const picture = page.getByRole("img", { name: "The checkout with the code applied" });
      const save = page.getByRole("button", { name: "Save checkout-with-code.jpg" });
      await picture.scrollIntoViewIfNeeded();
      await page.mouse.move(2, 2);
      await expect(save).toHaveCSS("opacity", "0");
      const before = await picture.boundingBox();
      await picture.hover();
      await expect(save).toHaveCSS("opacity", "1");
      const [at, button] = [await picture.boundingBox(), await save.boundingBox()];
      if (before === null || at === null || button === null) throw new Error("the picture or its download button has no box");
      expect(at, "the picture moved as its download button showed").toEqual(before);
      expect([button.width, button.height]).toEqual([32, 32]);
      expect(button.y - at.y).toBe(8);
      expect(at.x + at.width - (button.x + button.width)).toBeCloseTo(8, 0);
    },
  },
  // The same picture opened large: the viewer's download button beside its X.
  {
    id: "chat",
    route: HOME_ROUTE,
    fixtures: ["no-repo-pictures"],
    variant: "picture-viewer",
    open: async (page) => {
      await page.getByRole("button", { name: "Open The checkout with the code applied" }).click();
      await expect(page.getByRole("dialog").getByRole("button", { name: "Save checkout-with-code.jpg" })).toBeVisible();
    },
  },
  // An archived project still open: the palette offers every project's views, its Checklist too.
  {
    id: "palette",
    route: TAXES_ROUTE,
    fixtures: ["no-repo-chats"],
    variant: "archived",
    open: async (page) => {
      await page.keyboard.press("ControlOrMeta+K");
      await page.getByRole("combobox", { name: "Search" }).fill("Checklist");
      await expect(page.getByRole("option", { name: /Checklist/u }).first()).toBeVisible();
    },
  },
  // A bot's settings: Archive and Delete at the very bottom, the only place Delete is.
  {
    id: "settings.projects",
    variant: "archive",
    route: `#/settings/projects?for=${ADA.machineId}/${ADA.projectId}`,
    fixtures: ["no-repo-settings"],
    open: async (page) => {
      await page.getByRole("region", { name: "Archive", exact: true }).scrollIntoViewIfNeeded();
      await page.getByRole("region", { name: "Delete bot" }).waitFor();
    },
  },
  // A bot whose people merge its PRs: Who merges on You, with its risk rules open.
  {
    id: "settings.projects",
    variant: "who-merges",
    route: `#/settings/projects?for=${ADA.machineId}/${ADA.projectId}`,
    fixtures: ["no-repo-settings"],
    open: async (page) => {
      const row = page.getByRole("region", { name: "Who merges", exact: true });
      await row.getByRole("button", { name: "Rules" }).click();
      await row.getByRole("textbox", { name: "Merges itself" }).waitFor();
      await row.scrollIntoViewIfNeeded();
    },
  },
  // Its PRs merge, then verify, on a main that requires branches up to date: the line says so, with Turn off.
  {
    id: "settings.projects",
    variant: "merge-mode",
    route: `#/settings/projects?for=${ADA.machineId}/${ADA.projectId}`,
    fixtures: ["no-repo-settings"],
    open: async (page) => {
      const row = page.getByRole("region", { name: "How it merges", exact: true });
      await row.getByRole("button", { name: "Turn off" }).waitFor();
      await row.scrollIntoViewIfNeeded();
    },
  },
  // W845: storefront shares Ada's repo, so its merge train: How it merges shows that train's mode and says so.
  {
    id: "settings.projects",
    variant: "shared-train",
    route: `#/settings/projects?for=${ADA.machineId}/${ADA.projectId}`,
    fixtures: ["no-repo-shared-train"],
    open: async (page) => {
      const row = page.getByRole("region", { name: "How it merges", exact: true });
      await row.getByText(/Shared with storefront/u).waitFor();
      await row.scrollIntoViewIfNeeded();
    },
  },
  // Settings › Bots: Taxes archived, in its own group under the others, with Bring back.
  {
    id: "settings.projects",
    variant: "archived",
    route: "#/settings/projects",
    fixtures: ["no-repo-chats"],
    open: async (page) => {
      await page.getByRole("list", { name: "Archived" }).getByRole("button", { name: "Bring back" }).waitFor();
    },
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
  // The sidebar resized from its edge with the keyboard: at its narrowest (rows, times and dots still fit) and at its
  // widest, with long names.
  {
    id: "shell",
    route: "#/",
    fixtures: ["typical", "long-text"],
    variant: "sidebar-narrowest",
    open: async (page) => {
      const edge = page.getByRole("separator", { name: "Resize the sidebar" });
      await edge.focus();
      await edge.press("Home");
      await expect(edge).toHaveAttribute("aria-valuenow", "200");
    },
  },
  {
    id: "shell",
    route: "#/",
    fixtures: ["typical", "long-text"],
    variant: "sidebar-widest",
    open: async (page) => {
      const edge = page.getByRole("separator", { name: "Resize the sidebar" });
      await edge.focus();
      await edge.press("End");
      await expect(edge).toHaveAttribute("aria-valuenow", (await edge.getAttribute("aria-valuemax")) ?? "");
    },
  },
  // W565: the flush sidebar with its pinned chats, two to a row as on the phone (big round pictures, the name under,
  // a dot when new, no bubble while the lead works, but storefront's own picture has the working glyph beside its
  // name; no line before the list; one open and one hovered, the shade a capsule around each one's name, W580), and
  // the top bar's one pill, at rest with its chevron towards the panel; then the pill opening the panel, pressed, its
  // chevron turned back.
  {
    id: "shell",
    route: CHAT,
    fixtures: ["showcase-pins"],
    variant: "pins",
    open: async (page) => {
      const pill = page.locator('[data-opens="panel"]');
      if ((await pill.getAttribute("aria-pressed")) === "true") {
        await pill.click();
        await page.getByRole("complementary", { name: "Bot panel" }).waitFor({ state: "detached" });
      }
      const grid = page.getByRole("navigation", { name: "Sidebar" }).locator('[class*="pins"] > [data-reorder-row]');
      await expect(grid).toHaveCount(3);
      await expect(pill).toHaveAttribute("aria-pressed", "false");
      // W572: storefront's open, so its highlight shows; billing's hovered beside it, the same compact shape, quieter.
      await expect(grid.nth(0).getByRole("button")).toHaveAttribute("aria-current", "page");
      await grid.nth(1).getByRole("button").hover();
    },
  },
  // W580, W714: the list's sizes. The pinned names are 12/18 in the text's colour, each in an 18 px capsule, the dot
  // inside the capsule for inventory, which waits on you, and docs, with its new reply. The rows are 46 px rounded
  // boxes, never pills (W584), their names 13.5/18 semibold, each 32 px picture 7 px in from the row's top and 8 px
  // from its start. "Rewrite the pricing…" is cut short under its picture:
  // under the pointer its capsule takes the shade, and its tooltip has the name whole.
  {
    id: "shell",
    route: "#/",
    fixtures: ["sidebar-pins"],
    variant: "pin-names",
    open: async (page) => {
      const nav = page.getByRole("navigation", { name: "Sidebar" });
      const pins = nav.locator('[class*="pins"] > [data-reorder-row]').getByRole("button");
      await expect(pins).toHaveCount(3);
      const type = (at: Locator) =>
        at.evaluate((el) => {
          const { fontSize, fontWeight, lineHeight, color } = getComputedStyle(el);
          return { fontSize, fontWeight, lineHeight, color };
        });
      const text = await nav.evaluate((el) => getComputedStyle(el).color);
      const names = pins.locator('[class*="pinTitle"]');
      expect(await type(names.nth(0))).toEqual({ fontSize: "12px", fontWeight: "600", lineHeight: "18px", color: text });
      // docs' reply arrives once the app is open.
      await expect(pins.nth(2)).toHaveAttribute("data-unread", "true");
      for (const i of [1, 2]) {
        expect(await type(names.nth(i))).toEqual({ fontSize: "12px", fontWeight: "600", lineHeight: "18px", color: text });
        const dot = await pins.nth(i).locator('[class*="dot"]').boundingBox();
        const capsule = await pins.nth(i).locator('[class*="pinName"]').boundingBox();
        if (dot === null || capsule === null) throw new Error("the pin's dot isn't on screen");
        expect(dot.x).toBeGreaterThan(capsule.x);
      }
      for (const capsule of await pins.locator('[class*="pinName"]').all()) expect((await capsule.boundingBox())?.height).toBe(18);
      const row = nav.locator('[class*="rows"] > [data-reorder-row]').first().getByRole("button");
      const box = await row.boundingBox();
      const picture = await row.locator('[class*="avatar"]').first().boundingBox();
      if (box === null || picture === null) throw new Error("the first row isn't on screen");
      expect(box.height).toBe(46);
      expect(await row.evaluate((el) => getComputedStyle(el).borderRadius)).toBe("6px");
      expect([picture.width, picture.height]).toEqual([32, 32]);
      // 7 px from the row's top and bottom, 8 px from its start (W714: the slimmer sidebar's rows).
      expect([picture.x - box.x, picture.y - box.y]).toEqual([8, 7]);
      expect(await type(row.locator('[class*="name"]').first())).toEqual({ fontSize: "13.5px", fontWeight: "600", lineHeight: "18px", color: text });
      expect(await type(row.locator('[class*="line"]').first())).toMatchObject({ fontSize: "12.5px", lineHeight: "17px" });
      await pins.nth(0).hover();
      await expect(page.getByRole("tooltip")).toHaveText(/^Rewrite the pricing .+ both variants$/u);
      // A name that fits has no tooltip. The pointer travels there as a hand moves it: the tooltip is over its way.
      const fits = await pins.nth(2).boundingBox();
      if (fits === null) throw new Error("no third pin");
      await page.mouse.move(fits.x + fits.width / 2, fits.y + fits.height / 2, { steps: 12 });
      await expect(page.getByRole("tooltip")).toHaveCount(0);
      await pins.nth(0).hover();
      await page.getByRole("tooltip").waitFor();
    },
  },
  // W577, W580, W694: the pins are a compact group, centred in the sidebar at every width: 36 px pictures, a step over
  // a row's, their places touching, a share of the row each, a lone pin (W574) in the middle. One, two and three pins,
  // at the sidebar's narrowest and at its widest.
  ...(["showcase-pin", "showcase-pins-two", "showcase-pins"] as const).flatMap((fixture) =>
    (["Home", "End"] as const).map(
      (end): Screen => ({
        id: "shell",
        route: CHAT,
        fixtures: [fixture],
        variant: `pins-${{ "showcase-pin": "one", "showcase-pins-two": "two", "showcase-pins": "three" }[fixture]}-${end === "Home" ? "narrowest" : "widest"}`,
        open: async (page) => {
          const edge = page.getByRole("separator", { name: "Resize the sidebar" });
          await edge.focus();
          await edge.press(end);
          await expect(edge).toHaveAttribute("aria-valuenow", (await edge.getAttribute(end === "Home" ? "aria-valuemin" : "aria-valuemax")) ?? "");
          const grid = page.getByRole("navigation", { name: "Sidebar" }).locator('[class*="pins"]').first();
          const slots = grid.locator("> [data-reorder-row]");
          await expect(slots).toHaveCount({ "showcase-pin": 1, "showcase-pins-two": 2, "showcase-pins": 3 }[fixture]);
          await expect(async () => {
            const g = await grid.boundingBox();
            // A lone pin's place is the whole row: its own middle is the one to check.
            const lone = (await slots.count()) === 1;
            const boxes = await Promise.all((await slots.all()).map((slot) => (lone ? slot.getByRole("button") : slot).boundingBox()));
            if (g === null || boxes.some((b) => b === null)) throw new Error("the pins aren't on screen");
            const cells = boxes.flatMap((b) => (b === null ? [] : [b]));
            // The group's middle is the sidebar's, whatever its width.
            const left = Math.min(...cells.map((b) => b.x));
            const right = Math.max(...cells.map((b) => b.x + b.width));
            expect(Math.abs((left + right) / 2 - (g.x + g.width / 2))).toBeLessThan(1);
            // Two to a row, their places touching, never each in half of a wide sidebar; and their pictures 16 px apart.
            const [a, b] = cells;
            if (a !== undefined && b !== undefined) expect(Math.abs(b.x - (a.x + a.width))).toBeLessThan(0.5);
            const pictures = await Promise.all((await slots.all()).map((slot) => slot.locator('[class*="pinCell"] > :first-child').boundingBox()));
            const [p, q] = pictures;
            if (p == null) throw new Error("the pins' pictures aren't on screen");
            for (const picture of pictures) expect([picture?.width, picture?.height]).toEqual([36, 36]);
            // Each in its share of the row (three across): apart, never touching.
            if (q != null) expect(q.x - (p.x + p.width)).toBeGreaterThanOrEqual(8);
            // The list has nowhere to go sideways, a bot's picture (drawn on a canvas wider than itself) in the right
            // place or not.
            const list = page.getByRole("navigation", { name: "Sidebar" }).locator('[class*="list"]').first();
            expect(await list.evaluate((el) => [el.scrollWidth, el.scrollLeft])).toEqual([await list.evaluate((el) => el.clientWidth), 0]);
          }).toPass();
        },
      }),
    ),
  ),
  // W574: Ada dragged up from the list beside billing's lone pin joins the pins after it, the two to a row; then billing
  // dragged down out of the pins leaves them, and Ada's pin sits alone in the middle; Ada out too, and back through the
  // first pin's place, which shows while a chat is dragged with nothing pinned.
  {
    id: "shell",
    route: CHAT,
    fixtures: ["showcase-pin"],
    variant: "pin-drag",
    open: async (page) => {
      const nav = page.getByRole("navigation", { name: "Sidebar" });
      const grid = nav.locator('[class*="pins"]').first();
      const pins = grid.locator("> [data-reorder-row]");
      const drag = async (from: { x: number; y: number }, to: { x: number; y: number }) => {
        await page.mouse.move(from.x, from.y);
        await page.mouse.down();
        await page.mouse.move(to.x, to.y, { steps: 12 });
        await page.mouse.up();
      };
      const middle = async (at: Locator) => {
        const box = await at.boundingBox();
        if (box === null) throw new Error("not on screen");
        return { x: box.x + box.width / 2, y: box.y + box.height / 2, box };
      };
      const ada = await middle(nav.locator("[data-reorder-row]").filter({ hasText: "Ada" }).first());
      const billing = await middle(pins.first());
      await drag(ada, { x: billing.box.x + billing.box.width - 8, y: billing.y });
      await expect(pins).toHaveText([/billing/u, /Ada/u]);
      const left = await middle(pins.first());
      await drag(left, { x: left.x, y: ada.y + 60 });
      await expect(pins).toHaveText([/Ada/u]);
      // Ada out too: no pins. Picked up again, the first pin's place shows above the list, and Ada dropped there is
      // pinned.
      const lone = await middle(pins.first());
      await drag(lone, { x: lone.x, y: ada.y + 60 });
      await expect(pins).toHaveCount(0);
      // Scrolled down past the hub's name (the list made long enough to): the place showing above the list doesn't
      // scroll it, so the chat stays under the pointer.
      const list = nav.locator('[class*="_list_"]').first();
      await list.evaluate((el) => {
        el.style.paddingBottom = "800px";
        el.scrollTop = 48;
      });
      await expect.poll(() => list.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
      const row = await middle(nav.locator("[data-reorder-row]").filter({ hasText: "Ada" }).first());
      await page.mouse.move(row.x, row.y);
      await page.mouse.down();
      await page.mouse.move(row.x, row.y + 40, { steps: 6 });
      const zone = nav.locator('[class*="pinZone"]');
      await expect(zone).toHaveText("Drop here to pin");
      const lifted = await middle(nav.locator("[data-lifted]"));
      expect(Math.abs(lifted.y - (row.y + 40))).toBeLessThan(2);
      const place = await middle(zone);
      await page.mouse.move(place.x, place.y, { steps: 12 });
      await expect(zone).toHaveAttribute("data-pinning", "true");
      await page.mouse.up();
      await expect(pins).toHaveText([/Ada/u]);
      await expect(zone).toHaveCount(0);
      await list.evaluate((el) => {
        el.style.paddingBottom = "";
        el.scrollTop = 0;
      });
    },
  },
  // W577: the same drags in the widest sidebar, where the pins' group sits in its middle: Ada let go just right of
  // billing's lone pin joins after it, Ada dropped on billing's place swaps the two, and billing dragged down out of
  // the pins leaves Ada alone.
  {
    id: "shell",
    route: CHAT,
    fixtures: ["showcase-pin"],
    variant: "pin-drag-widest",
    open: async (page) => {
      const edge = page.getByRole("separator", { name: "Resize the sidebar" });
      await edge.focus();
      await edge.press("End");
      await expect(edge).toHaveAttribute("aria-valuenow", (await edge.getAttribute("aria-valuemax")) ?? "");
      const nav = page.getByRole("navigation", { name: "Sidebar" });
      const pins = nav.locator('[class*="pins"]').first().locator("> [data-reorder-row]");
      const drag = async (from: { x: number; y: number }, to: { x: number; y: number }) => {
        await page.mouse.move(from.x, from.y);
        await page.mouse.down();
        await page.mouse.move(to.x, to.y, { steps: 12 });
        await page.mouse.up();
      };
      const middle = async (at: Locator) => {
        const box = await at.boundingBox();
        if (box === null) throw new Error("not on screen");
        return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
      };
      const ada = await middle(nav.locator("[data-reorder-row]").filter({ hasText: "Ada" }).first());
      const billing = await middle(pins.first().getByRole("button"));
      await drag(ada, { x: billing.x + 40, y: billing.y });
      await expect(pins).toHaveText([/billing/u, /Ada/u]);
      await drag(await middle(pins.nth(1)), await middle(pins.first()));
      await expect(pins).toHaveText([/Ada/u, /billing/u]);
      const right = await middle(pins.nth(1));
      await drag(right, { x: right.x, y: ada.y + 60 });
      await expect(pins).toHaveText([/Ada/u]);
    },
  },
  // W580: your own sections. Under the pins (billing is one of Clients' too, and shows among the pins only) and the chat
  // in no section, Clients and Later under their labels: 12/16 regular in the quiet colour, in line with the
  // pictures, 12 px under the row before and 2 px over the next, no line and no count. Their chats are in the order
  // of their latest activity.
  {
    id: "shell",
    route: "#/",
    fixtures: ["sidebar-sections"],
    variant: "sections",
    open: async (page) => {
      const nav = page.getByRole("navigation", { name: "Sidebar" });
      await expect(nav.locator('[class*="pins"] > [data-reorder-row]')).toHaveText([/storefront/u, /billing/u]);
      const lines = nav.locator('[class*="rows"] > [data-reorder-row]');
      await expect(lines).toHaveText(["Bots", /^Rewrite the pricing/u, "Clients", /^checkout/u, /^inventory/u, /^mobile/u, "Later", /^docs/u, /^search/u]);
      const label = nav.getByRole("button", { name: "Clients", exact: true });
      const name = label.locator('[class*="sectionName"]');
      const quiet = await lines.nth(1).locator('[class*="line"]').first().evaluate((el) => getComputedStyle(el).color);
      expect(
        await name.evaluate((el) => {
          const { fontSize, fontWeight, lineHeight, color } = getComputedStyle(el);
          return { fontSize, fontWeight, lineHeight, color };
        }),
      ).toEqual({ fontSize: "12px", fontWeight: "400", lineHeight: "16px", color: quiet });
      const [before, at, text, after, picture] = await Promise.all([lines.nth(1), label, name, lines.nth(3), lines.nth(3).locator('[class*="avatar"]').first()].map((l) => l.boundingBox()));
      if (before == null || at == null || text == null || after == null || picture == null) throw new Error("the label isn't on screen");
      expect(at.y - (before.y + before.height)).toBeCloseTo(12, 0);
      expect(after.y - (at.y + at.height)).toBeCloseTo(2, 0);
      expect(text.x).toBeCloseTo(picture.x, 0);
    },
  },
  // W798: Later folded by a click on its label: one line with its name, how many chats in the quieter colour, and the dot
  // (search waits on you) in line with the rows' dots; no chevron at rest. The fold is kept on this device.
  {
    id: "shell",
    route: "#/",
    fixtures: ["sidebar-sections"],
    variant: "section-folded",
    open: async (page) => {
      const nav = page.getByRole("navigation", { name: "Sidebar" });
      // A fold takes the rows under it up on the spring, and on macOS the sidebar under them is the window's own
      // material (data-vibrancy), which no tone of the page's matches: none of them paints one on its way (W585: each
      // was a dark box until it landed). Clients' fold moves Later's label, docs and search, read here while they glide.
      await page.emulateMedia({ reducedMotion: "no-preference" });
      const rising = await page.evaluate(async () => {
        const root = document.documentElement;
        const mac = "vibrancy" in root.dataset;
        root.dataset["vibrancy"] = "";
        document.querySelector<HTMLElement>('nav[aria-label="Sidebar"] [data-section="s1"] button')?.click();
        await new Promise((rendered) => setTimeout(rendered, 0));
        const glides = document.getAnimations().filter((a) => a.effect instanceof KeyframeEffect && a.effect.target?.matches("[data-reorder-row]") === true);
        const fills = [...document.querySelectorAll('nav[aria-label="Sidebar"] [data-gliding="up"]')].map((el) => getComputedStyle(el).backgroundColor);
        if (!mac) delete root.dataset["vibrancy"];
        return { fills, ms: glides.map((a) => a.effect?.getTiming().duration) };
      });
      await page.emulateMedia({ reducedMotion: "reduce" });
      expect(rising.fills).toEqual(["rgba(0, 0, 0, 0)", "rgba(0, 0, 0, 0)", "rgba(0, 0, 0, 0)"]);
      // The sidebar's spring (Sidebar.tsx SPRING).
      expect(rising.ms).toEqual([360, 360, 360]);
      await nav.getByRole("button", { name: "Clients", expanded: false }).click();
      // The unfold puts Clients' rows back where Later's label and rows are, which glide down to make room. Each new
      // row shows only down to their upper edge, from the glide's first frame to its last, where it shows whole: none
      // is drawn under them (W585: Later's rows were drawn on Clients' for the glide's first 150 ms).
      await nav.getByRole("button", { name: "Clients", expanded: true }).click();
      await page.emulateMedia({ reducedMotion: "no-preference" });
      const unfold = await page.evaluate(async () => {
        document.querySelector<HTMLElement>('nav[aria-label="Sidebar"] [data-section="s1"] button')?.click();
        await new Promise((rendered) => setTimeout(rendered, 0));
        const glides = document.getAnimations().filter((a) => a.effect instanceof KeyframeEffect && a.effect.target?.matches("[data-reorder-row]") === true);
        const at = (time: number) => {
          for (const a of glides) {
            a.pause();
            a.currentTime = time;
          }
          const fresh = [...document.querySelectorAll('nav[aria-label="Sidebar"] [data-section="s1"]:not([class*="sectionSlot"])')];
          return {
            // How far down the page each new row shows: its clip's lower edge, an inset from the row's own.
            shown: fresh.map((el) => el.getBoundingClientRect().bottom - parseFloat(/^inset\(\S+ \S+ (\S+)\)$/u.exec(getComputedStyle(el).clipPath)?.[1] ?? "")),
            ends: fresh.map((el) => el.getBoundingClientRect().bottom),
            // The first row making room: Later's label.
            cover: document.querySelector('nav[aria-label="Sidebar"] [data-gliding="down"]')?.getBoundingClientRect().top ?? Number.NaN,
          };
        };
        return { start: at(0), end: at(360) };
      });
      await page.emulateMedia({ reducedMotion: "reduce" });
      expect(unfold.start.shown).toHaveLength(3);
      expect(unfold.end.cover - unfold.start.cover).toBeGreaterThan(80);
      for (const y of unfold.start.shown) expect(y).toBeLessThanOrEqual(unfold.start.cover);
      unfold.end.shown.forEach((y, i) => {
        expect(y).toBeLessThanOrEqual(unfold.end.cover);
        expect(y).toBeGreaterThanOrEqual(unfold.end.ends[i] ?? Number.NaN);
      });
      await nav.getByRole("button", { name: "Later", expanded: true }).click();
      const folded = nav.getByRole("button", { name: "Later", expanded: false });
      await expect(folded).toHaveAccessibleDescription("2 chats, one waits on you");
      await expect(nav.locator('[class*="rows"] > [data-reorder-row]')).toHaveText(["Bots", /^Rewrite the pricing/u, "Clients", /^checkout/u, /^inventory/u, /^mobile/u, "Later2"]);
      expect(await page.evaluate(() => window.localStorage.getItem("fleetd.foldedSections"))).toContain("/s2");
      // The pointer is off the label, as it is at rest: no chevron shows.
      await page.mouse.move(600, 400);
      await expect(folded.locator('[class*="sectionHint"]')).toHaveCSS("opacity", "0");
      const box = async (at: Locator) => {
        const b = await at.boundingBox();
        if (b === null) throw new Error("not on screen");
        return b;
      };
      const [dot, rowDot, count, name] = await Promise.all([folded.locator('[class*="dot"]'), nav.locator('[class*="rows"] [class*="mark"] [class*="dot"]').first(), folded.locator('[class*="sectionCount"]'), folded.locator('[class*="sectionName"]')].map(box));
      if (dot === undefined || rowDot === undefined || count === undefined || name === undefined) throw new Error("not on screen");
      // The dot's centre in line with a row's; the count 4 px after the name.
      expect(dot.x + dot.width / 2).toBeCloseTo(rowDot.x + rowDot.width / 2, 0);
      expect(count.x - (name.x + name.width)).toBeCloseTo(4, 0);
    },
  },
  // ...beside another hub, in Hubs: the hub on show's pins, its chats in no section, then its own sections; another
  // picked at the top brings its own.
  {
    id: "shell",
    route: "#/",
    fixtures: ["sidebar-sections-hubs"],
    variant: "sections-hubs",
    open: async (page) => {
      const nav = page.getByRole("navigation", { name: "Sidebar" });
      const groups = nav.locator('[class*="rows"]');
      await expect(groups).toHaveCount(1);
      await expect(groups.locator("> [data-reorder-row]")).toHaveText(["Bots", /^recipes/u, "Home", /^garden-sensors/u]);
      await expect(nav.locator('[class*="pins"] > [data-reorder-row]')).toHaveText([/blog/u]);
      await page.locator('[data-opens="hubs"]').click();
      await page.getByRole("menuitem", { name: /Acme/u }).click();
      await expect(groups.locator("> [data-reorder-row]")).toHaveText(["Bots", /^Rewrite the pricing/u, "Clients", /^checkout/u, /^inventory/u, /^mobile/u, "Later", /^docs/u, /^search/u]);
      await expect(nav.locator('[class*="pins"] > [data-reorder-row]')).toHaveText([/storefront/u, /billing/u]);
      await page.mouse.move(600, 400);
    },
  },
  // W714: the sidebar's ⋯, open: Sort by (Recent, Name, Needs you first), Compact rows and Archived bots; and the list
  // drawn compact, one line a bot, on one hub with a few bots and on three hubs with sections and nineteen bots.
  {
    id: "shell",
    route: "#/",
    fixtures: ["typical", "sidebar-many-hubs"],
    variant: "view-menu",
    open: async (page) => {
      await page.locator('[data-opens="list-menu"]').click();
      await expect(page.getByRole("menuitemradio")).toHaveText(["Recent", "Name", "Needs you first"]);
      await expect(page.getByRole("menuitemradio", { name: "Recent" })).toBeChecked();
      await expect(page.getByRole("menuitemcheckbox", { name: "Compact rows" })).not.toBeChecked();
    },
  },
  {
    id: "shell",
    route: "#/",
    fixtures: ["typical", "sidebar-many-hubs"],
    variant: "compact",
    open: async (page) => {
      await page.locator('[data-opens="list-menu"]').click();
      await page.getByRole("menuitemcheckbox", { name: "Compact rows" }).click();
      await page.keyboard.press("Escape");
      const nav = page.getByRole("navigation", { name: "Sidebar" });
      await expect(nav).toHaveAttribute("data-compact");
      await page.mouse.move(600, 400);
    },
  },
  // A bot's own menu (right-click its row): Open, pins and sections, Rename, its settings, Copy path, then Archive,
  // which shows an Undo; Delete is only in its settings.
  {
    id: "shell",
    route: "#/",
    fixtures: ["sidebar-sections"],
    variant: "bot-menu",
    open: async (page) => {
      const nav = page.getByRole("navigation", { name: "Sidebar" });
      await nav.locator('[class*="rows"] > [data-reorder-row]').filter({ hasText: "inventory" }).getByRole("button").click({ button: "right" });
      await page.getByRole("menuitem", { name: "Archive" }).waitFor();
    },
  },
  // ...a chat's Move to section: your sections with a tick on its own, No section, New section….
  {
    id: "shell",
    route: "#/",
    fixtures: ["sidebar-sections"],
    variant: "section-move-menu",
    open: async (page) => {
      const nav = page.getByRole("navigation", { name: "Sidebar" });
      await nav.locator('[class*="rows"] > [data-reorder-row]').filter({ hasText: "inventory" }).getByRole("button").click({ button: "right" });
      await page.getByRole("menuitem", { name: "Move to section" }).hover();
      await expect(page.getByRole("menuitemradio")).toHaveText(["Clients", "Later", "No section"]);
      await expect(page.getByRole("menuitemradio", { name: "Clients" })).toBeChecked();
      await expect(page.getByRole("menuitem", { name: "New section…" })).toBeVisible();
    },
  },
  // ...a label's menu: Rename…, the ways it can move (Later, the last, only up), Remove section.
  {
    id: "shell",
    route: "#/",
    fixtures: ["sidebar-sections"],
    variant: "section-label-menu",
    open: async (page) => {
      await page.getByRole("navigation", { name: "Sidebar" }).getByRole("button", { name: "Later", exact: true }).click({ button: "right" });
      await expect(page.getByRole("menuitem")).toHaveText(["Rename…", "Move up", "Remove section"]);
    },
  },
  // ...and a drag into a section. "Rewrite the pricing…" held over Clients' label covers it, so the lifted row says
  // where it would go, where its time was; let go, it is one of Clients'. docs held over checkout, a chat of Clients',
  // shades Clients' label; let go, it joins too, and Later keeps search.
  {
    id: "shell",
    route: "#/",
    fixtures: ["sidebar-sections"],
    variant: "section-drag",
    open: async (page) => {
      const nav = page.getByRole("navigation", { name: "Sidebar" });
      const lines = nav.locator('[class*="rows"] > [data-reorder-row]');
      const middle = async (at: Locator) => {
        const box = await at.boundingBox();
        if (box === null) throw new Error("not on screen");
        return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
      };
      const hold = async (from: { x: number; y: number }, to: { x: number; y: number }) => {
        await page.mouse.move(from.x, from.y);
        await page.mouse.down();
        await page.mouse.move(to.x, to.y, { steps: 12 });
      };
      const label = nav.getByRole("button", { name: "Clients", exact: true });
      await hold(await middle(lines.filter({ hasText: "Rewrite the pricing" })), await middle(label));
      await expect(label).toHaveAttribute("data-taking", "true");
      await expect(nav.locator('[data-lifted] [class*="into"]')).toHaveText("Clients");
      await page.mouse.up();
      await expect(lines.nth(0)).toHaveText("Clients");
      await expect(lines.filter({ hasText: "Rewrite the pricing" })).toHaveAttribute("data-section", "s1");
      await hold(await middle(lines.filter({ hasText: "docs" })), await middle(lines.filter({ hasText: "checkout" })));
      await expect(label).toHaveAttribute("data-taking", "true");
      await page.mouse.up();
      await expect(lines.filter({ hasText: "docs" })).toHaveAttribute("data-section", "s1");
      await expect(lines.last()).toHaveText(/^search/u);
      await expect(nav.getByRole("button", { name: "Later", exact: true })).toBeVisible();
    },
  },
  // ...and a drag out of one: checkout, of Clients', held over "Rewrite the pricing…", a chat in none, says No section
  // where its time was, and no label takes it; let go, it is in none, on top, and Clients keeps the rest.
  {
    id: "shell",
    route: "#/",
    fixtures: ["sidebar-sections"],
    variant: "section-drag-out",
    open: async (page) => {
      const nav = page.getByRole("navigation", { name: "Sidebar" });
      const lines = nav.locator('[class*="rows"] > [data-reorder-row]');
      const middle = async (at: Locator) => {
        const box = await at.boundingBox();
        if (box === null) throw new Error("not on screen");
        return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
      };
      const from = await middle(lines.filter({ hasText: "checkout" }));
      await page.mouse.move(from.x, from.y);
      await page.mouse.down();
      const to = await middle(lines.filter({ hasText: "Rewrite the pricing" }));
      await page.mouse.move(to.x, to.y, { steps: 12 });
      await expect(nav.locator('[data-lifted] [class*="into"]')).toHaveText("No section");
      await expect(nav.locator("[data-taking]")).toHaveCount(0);
      await page.mouse.up();
      await expect(lines.filter({ hasText: "checkout" })).not.toHaveAttribute("data-section");
      await expect(lines.nth(3)).toHaveText("Clients");
      await expect(lines.filter({ hasText: "inventory" })).toHaveAttribute("data-section", "s1");
    },
  },
  // ...and a label's Rename…: the dialog opens with the focus in the name's box, so the name can be typed right away.
  {
    id: "shell",
    route: "#/",
    fixtures: ["sidebar-sections"],
    variant: "section-rename",
    open: async (page) => {
      await page.getByRole("navigation", { name: "Sidebar" }).getByRole("button", { name: "Later", exact: true }).click({ button: "right" });
      await page.getByRole("menuitem", { name: "Rename…" }).click();
      const name = page.getByRole("dialog", { name: "Rename Later" }).getByRole("textbox", { name: "Name" });
      await expect(name).toBeFocused();
      await page.keyboard.type(" on");
      await expect(name).toHaveValue("Later on");
    },
  },
  {
    id: "shell",
    route: CHAT,
    fixtures: ["showcase-pins"],
    variant: "pill-open",
    open: async (page) => {
      const pill = page.locator('[data-opens="panel"]');
      if ((await pill.getAttribute("aria-pressed")) !== "true") await pill.click();
      await page.getByRole("complementary", { name: "Bot panel" }).waitFor();
      await expect(pill).toHaveAttribute("aria-pressed", "true");
    },
  },
  // ...and in the smallest window, where it had hidden itself, shown with the chat's pill.
  {
    id: "shell",
    route: "#/",
    fixtures: ["chat-waiting"],
    variant: "panel-narrow",
    sizes: ["narrow"],
    open: async (page) => {
      await page.locator('[data-opens="panel"]').click();
      await page.getByRole("complementary", { name: "Bot panel" }).waitFor();
    },
  },
  // The smallest window: the sidebar has hidden itself, and the chat's title starts after the traffic lights.
  { id: "shell", route: "#/", fixtures: ["chat-waiting", "long-text"], variant: "narrow", sizes: ["narrow"] },
  // ...and shown again with ⌘B at that width, the chat beside it.
  {
    id: "shell",
    route: "#/",
    fixtures: ["chat-waiting", "long-text"],
    variant: "narrow-open",
    sizes: ["narrow"],
    open: async (page) => {
      await page.keyboard.press("ControlOrMeta+B");
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
      // The last page lands with the start line rendered but already out of view: the list keeps the place below it,
      // and drops that line on its next frame. Back at the top, the start and the past orders under it stay.
      await log.evaluate((el) => el.scrollTo({ top: 0 }));
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
  { id: "chat", route: CHAT, fixtures: ["bubbles-casual", "bubbles-charts", "bubbles-pr", "bubbles-agent", "bubbles-ask", "bubbles-sources", "bubbles-preview"], variant: "bubbles" },
  // The tagged chat (a project's trial): a quiet line over each run names its order and, over the lead's, whom it is
  // for; the closed order's messages stay as bubbles where they were. With one order open no tag names it; with the
  // trial off the chat is today's.
  { id: "chat", route: CHAT, fixtures: ["tags-busy", "tags-one-order", "tags-off"], variant: "tags", open: (page) => expect(page.locator("[data-entry=message]").first()).toBeVisible() },
  // ...a lens on one order, from its tag: only its messages (of the one about two orders, only its bubble), its
  // capsule by the chat's pill, and the box sending about it.
  {
    id: "chat",
    route: CHAT,
    fixtures: ["tags-busy"],
    variant: "tags-lens",
    open: async (page) => {
      await page.getByRole("button", { name: "Only Search speed" }).first().click();
      await expect(page.getByRole("button", { name: "Show the whole chat" })).toBeVisible();
      await expect(page.getByRole("textbox", { name: "Message the lead" })).toHaveAttribute("placeholder", /about Search speed/u);
      await expect(page.getByText("On it: two writers")).toBeHidden();
      await expect(page.getByText("Search is slow because")).toBeVisible();
      // Off the bubbles, so no hover shows in the shot.
      await page.mouse.move(0, 0);
    },
  },
  // ...and closed: the whole chat again, the lens's capsule gone.
  {
    id: "chat",
    route: CHAT,
    fixtures: ["tags-busy"],
    variant: "tags-lens-closed",
    open: async (page) => {
      await page.getByRole("button", { name: "Only Search speed" }).first().click();
      await page.getByRole("button", { name: "Show the whole chat" }).click();
      await expect(page.getByRole("button", { name: "Show the whole chat" })).toBeHidden();
      await expect(page.getByText("On it: two writers")).toBeVisible();
    },
  },
  // A bubble's menu, About…: the open orders, a check on its own, and Nothing.
  {
    id: "chat",
    route: CHAT,
    fixtures: ["tags-busy"],
    variant: "tags-about",
    open: async (page) => {
      await page.locator('[data-bubble="text"]').filter({ hasText: "Looking: an agent is timing" }).click({ button: "right" });
      await page.getByRole("menuitem", { name: "About…" }).hover();
      await expect(page.getByRole("menuitem", { name: "Nothing" })).toBeVisible();
    },
  },
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
  // W803 (F1179): a bubble's hover strip (tapback, Reply, the time) at every chat width: the window's widths, and the
  // narrow one with the sidebar and the panel open, the chat at its narrowest. The lead's wrapped bubble with Reply's
  // tooltip, and one of yours: each strip beside its bubble's foot, on its outer side, on none of its words.
  ...(["theirs", "mine"] as const).flatMap((side): Screen[] => [
    { id: "chat", route: CHAT, fixtures: ["bubbles-casual"], variant: `hover-${side}`, check: (page) => hoverStrip(page, side) },
    { id: "chat", route: CHAT, fixtures: ["bubbles-casual"], variant: `hover-${side}-narrow`, sizes: ["narrow"], open: narrowest, check: (page) => hoverStrip(page, side) },
  ]),
  // ...and a table, which keeps the whole column there: its strip under its foot, from its left edge, never on it.
  {
    id: "chat",
    route: CHAT,
    fixtures: ["bubbles-charts"],
    variant: "hover-wide-narrow",
    sizes: ["narrow"],
    open: narrowest,
    check: async (page) => {
      const table = page.locator('[data-bubble="table"]');
      const strip = table.locator("..").locator('> [class*="aside"]');
      await table.hover();
      await expect(strip).toHaveCSS("opacity", "1");
      const [b, s] = await Promise.all([table.boundingBox(), strip.boundingBox()]);
      if (b === null || s === null) throw new Error("the table or its strip has no box");
      expect.soft(s.y, "the strip under the table").toBeGreaterThanOrEqual(b.y + b.height);
      expect.soft(Math.abs(s.x - b.x), "the strip from the table's left edge").toBeLessThanOrEqual(1);
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
  // W890: the bot on screen removed while open says so in workspace words, with Back to bots. The fixture's first run
  // has removed it before the route opens (a bot the hub doesn't list goes home), so the page loads again on its chat
  // and the timeline removes it while it is open.
  {
    id: "chat",
    route: CHAT,
    fixtures: ["resilience-bot-removed"],
    variant: "removed",
    expect: "error",
    open: async (page) => {
      await page.evaluate((hash) => window.history.replaceState(null, "", hash), CHAT);
      await page.reload();
      await page.locator('[data-screen="chat.missing"]').waitFor({ timeout: 10_000 });
    },
  },
  // W733: the conversation moves only by the wheel. Read up through a history of pictures and image blocks, each
  // loading as it comes near: what is on screen never jumps (a picture growing above it, or in view).
  {
    id: "chat",
    route: CHAT,
    fixtures: ["scroll-still"],
    variant: "read-up",
    sizes: ["large"],
    realClock: true,
    open: async (page) => {
      await page.getByLabel("Conversation with the lead").waitFor({ timeout: 30_000 });
      await watchScroll(page);
      await notches(page, -40);
      await page.waitForTimeout(1500);
      expect(await scrollMoves(page)).toEqual([]);
    },
  },
  // ...and a fold the reader opens in a row the view's top cuts through (a long diff's Show all) opens under what they
  // read: the lines shown before stay where they were on screen, the lines opened below them.
  {
    id: "chat",
    route: CHAT,
    fixtures: ["scroll-still"],
    variant: "fold",
    sizes: ["large"],
    realClock: true,
    open: async (page) => {
      await page.getByLabel("Conversation with the lead").waitFor({ timeout: 30_000 });
      await notches(page, -9);
      const more = page.getByRole("button", { name: /^Show all \d+ lines$/u });
      await more.waitFor({ timeout: 10_000 });
      // Scrolled up by the wheel so the button sits a third down the view, the diff's first lines and its message's top
      // above it, away from the end (where the list follows the end as rows grow).
      const by = await more.evaluate((b) => {
        const list = b.closest("[role=list]");
        return list === null ? 0 : b.getBoundingClientRect().top - list.getBoundingClientRect().top - list.clientHeight / 3;
      });
      const log = await page.getByLabel("Conversation with the lead").boundingBox();
      if (!log) throw new Error("no conversation");
      await page.mouse.move(log.x + log.width / 2, log.y + log.height / 2);
      await page.mouse.wheel(0, by);
      await page.waitForTimeout(500);
      // A line of the diff shown before, by its words (syntax colour splits a line into pieces).
      const lineTop = (n: number) =>
        page.evaluate((words) => {
          const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
          for (let t = walk.nextNode(); t !== null; t = walk.nextNode()) {
            if (t.textContent?.trim() === words) {
              const range = document.createRange();
              range.selectNodeContents(t);
              return range.getBoundingClientRect().top;
            }
          }
          return null;
        }, `line${String(n)}`);
      const was = await lineTop(20);
      expect(was).not.toBeNull();
      await more.click();
      await expect.poll(() => lineTop(120)).not.toBeNull();
      await page.waitForTimeout(500);
      expect(await lineTop(20)).toBe(was);
    },
  },
  // ...and something growing at the top of the row the view's top cuts through (a picture loading there), with a scroll
  // landing in the same frame, as one does nearly every frame while the reader scrolls, and without: what sits under
  // the view's middle moves by the scroll alone.
  {
    id: "chat",
    route: CHAT,
    fixtures: ["scroll-still"],
    variant: "grow-at-top",
    sizes: ["large"],
    realClock: true,
    open: async (page) => {
      await page.getByLabel("Conversation with the lead").waitFor({ timeout: 30_000 });
      await notches(page, -6);
      // A block at the top of the row the view's top cuts through, empty until it grows.
      const placed = await page.evaluate(() => {
        const list = document.querySelector<HTMLElement>('[aria-label="Conversation with the lead"]');
        const top = list?.getBoundingClientRect().top ?? 0;
        const row = [...(list?.querySelectorAll<HTMLElement>("[data-index]") ?? [])].find((r) => r.getBoundingClientRect().top < top && r.getBoundingClientRect().bottom > top + 1);
        if (!row) return false;
        const grow = document.createElement("div");
        grow.id = "qa-grow";
        row.prepend(grow);
        return true;
      });
      expect(placed).toBe(true);
      await page.waitForTimeout(300);
      // How far what sits under the view's middle moved, two frames after the block grows by 200 px and the list is
      // scrolled by `by` px in the same task.
      const grow = (by: number) =>
        page.evaluate(async (by) => {
          const list = document.querySelector<HTMLElement>('[aria-label="Conversation with the lead"]');
          const block = document.getElementById("qa-grow");
          if (!list || !block) return Number.NaN;
          const r = list.getBoundingClientRect();
          const under = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
          const was = under?.getBoundingClientRect().top ?? Number.NaN;
          block.style.height = `${String(block.offsetHeight + 200)}px`;
          if (by !== 0) list.scrollTop += by;
          await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
          return (under?.getBoundingClientRect().top ?? Number.NaN) - was;
        }, by);
      // Scrolled up a pixel in that frame: the rows come down that pixel, no more.
      expect(Math.abs((await grow(-1)) - 1)).toBeLessThan(2);
      await page.waitForTimeout(300);
      expect(Math.abs(await grow(0))).toBeLessThan(2);
    },
  },
  // ...and scrolled up, the link drops and comes back unable to resume: the offline banner floats over the chat rather
  // than push it down, and the pictures on screen stay (their bytes outlast the reconnect).
  {
    id: "chat",
    route: CHAT,
    fixtures: ["scroll-drop"],
    variant: "drop",
    sizes: ["large"],
    realClock: true,
    open: async (page) => {
      await page.getByLabel("Conversation with the lead").waitFor({ timeout: 30_000 });
      await notches(page, -12);
      await page.waitForTimeout(1000);
      await watchScroll(page);
      const banner = page.locator('[data-banner="reconnecting"]');
      await expect(banner).toBeVisible({ timeout: 20_000 });
      await expect(banner).toHaveCount(0, { timeout: 20_000 });
      await page.waitForTimeout(1500);
      expect(await scrollMoves(page)).toEqual([]);
    },
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
  // A link to a bot the hub doesn't have (here, a hub with none) goes to its home (W890; chat~removed has a bot removed
  // while open, which says so).
  { id: "home.empty", route: CHAT, fixtures: ["empty"], variant: "missing" },
  // A5 (F5): the two inline items, every state: the masked secret field, the exact command with Approve / Deny, open
  // again after the node was offline; answered ones folded to one line (saved, not needed, ran, ran with an error,
  // not run, denied, running).
  // ...and a project's integration cards: a send, a delete, an answered send; and approvals whose hidden characters show
  // as marks.
  { id: "chat", route: CHAT, fixtures: ["inline-items", "inline-integrations", "inline-checker", "inline-secure", "inline-hidden", "inline-propose", "inline-sign-in"], variant: "inline" },
  // The same chat offline from the disk cache: an open item says it can't be answered now, and a secret never claims
  // the hub doesn't know its machine.
  {
    id: "chat",
    route: CHAT,
    fixtures: ["inline-offline"],
    variant: "inline-offline",
    open: async (page) => {
      await page.locator('[data-screen="chat"]').waitFor({ timeout: 30_000 });
      await expect(page.getByText("Offline: approve once the workspace is back.").first()).toBeAttached();
      await expect(page.getByText("Offline: save it once the workspace is back.").first()).toBeAttached();
      await expect(page.getByText(/doesn't know the machine/u)).toHaveCount(0);
    },
  },
  // A sign-in card's form, opened: the fields, the password shown, Save to Vault ticked, Submit.
  {
    id: "chat",
    route: CHAT,
    fixtures: ["inline-sign-in"],
    variant: "sign-in-form",
    open: async (page) => {
      const card = page.getByRole("region", { name: "Sign in to Devbox Analytics" });
      await card.getByRole("button", { name: "Open", exact: true }).click();
      const form = page.getByRole("dialog", { name: "Sign in to Devbox Analytics" });
      await form.getByLabel("Email or username").fill("ada@devbox.example");
      await form.getByLabel("Password", { exact: true }).fill("correct horse battery");
      await form.getByRole("button", { name: "Show password" }).click();
      await expect(form.getByRole("checkbox", { name: "Securely save to Vault" })).toBeChecked();
      await expect(form.getByRole("button", { name: "Submit" })).toBeEnabled();
    },
  },
  // The code its site sent, asked in a form of its own: no vault box.
  {
    id: "chat",
    route: CHAT,
    fixtures: ["inline-sign-in"],
    variant: "sign-in-code",
    open: async (page) => {
      const card = page.getByRole("region", { name: "Code for Devbox Store" });
      await card.getByRole("button", { name: "Open", exact: true }).click();
      const form = page.getByRole("dialog", { name: "Code for Devbox Store" });
      await expect(form.getByLabel("Code")).toBeFocused();
      await expect(form.getByRole("checkbox")).toHaveCount(0);
      await expect(form.getByRole("button", { name: "Submit" })).toBeDisabled();
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
  // A command's card opens with the command hidden; Show command opens it: a multi-line script on its lines with no
  // mark, one whose carriage return is marked under the warning, and words that hide or reorder text.
  {
    id: "chat",
    route: CHAT,
    fixtures: ["inline-hidden"],
    variant: "inline-command",
    open: async (page) => {
      const card = (text: string) => page.getByRole("region", { name: "Command to approve" }).filter({ hasText: text });
      for (const text of ["Clear the build cache", "Tag and push the 2.4.0 release", "Clean the build cache"]) {
        const c = card(text);
        await expect(c.locator("pre")).toHaveCount(0);
        await c.getByRole("button", { name: "Show command" }).click();
        await c.getByRole("button", { name: "Hide command" }).waitFor();
      }
      await expect(card("Tag and push the 2.4.0 release").getByText("Contains hidden characters")).toHaveCount(0);
      await expect(card("Clean the build cache").getByText("⟨U+000D⟩")).toBeVisible();
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
  // The gear at the end of the panel's row opens the project's settings (its Max agents is a tab from there, under
  // settings.agents; the panel's list carries no count line).
  {
    id: "settings.projects",
    route: `${ADA_ROUTE}/agents`,
    fixtures: ["no-repo-settings"],
    variant: "from-panel",
    open: async (page) => {
      await page.getByRole("complementary", { name: "Bot panel" }).getByRole("button", { name: "Bot settings" }).click();
      await expect(page.getByRole("link", { name: /^Max agents/u })).toHaveCount(0);
    },
  },
  // W89 and W550: one header row. The panel runs from the window's top, its tabs beside the chat's floating title: the
  // two rows share a top and a height (the chat's row has no bar or line; the panel's tabs keep theirs), and the row
  // carries no state word and no Max agents. The chat's pill stays at the row's start as the panel comes and goes, so
  // the click that closed the panel opens it again in the same place.
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
        const box = (el: Element) => ({ top: el.getBoundingClientRect().top, height: el.getBoundingClientRect().height });
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
  // C1, W38, W521 and W603: updates. The word under your name for each state that has one; and Hub › Machines' Updates as the
  // palette's "Check for updates" opens it, its one status for every state of this app (not checked yet, checking, a
  // build that doesn't update, up to date, found, downloading to restart, ready, the deb's command, a failed check, a
  // failed download), of the hub and its machines (up to date, version unknown, a newer build on the channel, older
  // than this app, machines behind), of an Update run already going when it opens (the hub restarting, the machines),
  // and of one that ended before it opened (the hub's own automatic update: a machine that didn't update, and
  // everything updated a few minutes ago).
  {
    id: "shell",
    route: "#/",
    fixtures: ["updates-available", "updates-downloading", "updates-ready", "updates-hub-behind", "updates-run-hub"],
    variant: "updates",
  },
  // The hub switcher's menu, open (W607, W714): each hub, the one on show ticked, and under it what is off with it with
  // the one thing to do: a setup step left, a machine offline, hosted agents with no Claude account, the hub out of reach, a second hub out of reach or
  // refusing this app's key, an update to take, going on, just in, or one that didn't go in (a member is told who to
  // ask, as when no machine is online or every one is degraded), everything at once, and hubs and a machine with
  // 40-character names, where only the name is cut short. One size: the menu is as wide in every window.
  {
    id: "shell",
    route: "#/",
    fixtures: [
      "admin-owner",
      "admin-member",
      "menu-setup",
      "menu-machine-offline",
      "menu-hosted-account",
      "menu-hosted-refused",
      "menu-offline",
      "menu-refused",
      "sidebar-hubs-offline",
      "updates-hub-ready",
      "menu-updating",
      "menu-updated",
      "menu-update-failed",
      "menu-member-update-failed",
      "menu-member-no-machine",
      "menu-member-degraded",
      "menu-long-refused",
      "menu-long-offline",
      "menu-everything",
    ],
    variant: "hub-menu",
    sizes: ["small"],
    open: async (page) => {
      await page.locator("[data-opens='hubs']").click();
      const menu = page.getByRole("menu");
      await menu.getByRole("menuitem").first().waitFor();
      // Never a table, an address or a build's name.
      await expect(menu).not.toContainText(/https?:|:4790|edge|Protocol|\bv\d/iu);
      // Nothing but a name gives way (the part with its full name on hover): no other part of a line is cut short,
      // and no line runs past its width, so what is wrong and its action show whole.
      const cut = await menu
        .locator("[data-line], [data-line] span:not([title])")
        .evaluateAll((parts) => parts.filter((p) => p.scrollWidth > p.clientWidth + 1).map((p) => p.textContent));
      expect(cut).toEqual([]);
    },
  },
  // The menu under your name, open (W714): who you are, then Settings, Appearance, Keyboard shortcuts and Help, each
  // shortcut at its row's end, and no hub; this app's own update a row of its own when there is one. Appearance opens
  // its three beside it.
  {
    id: "shell",
    route: "#/",
    fixtures: ["admin-owner", "admin-member", "updates-ready", "menu-app-update", "updates-numbered"],
    variant: "you-menu",
    sizes: ["small"],
    open: async (page) => {
      await page.locator("[data-opens='you']").click();
      const menu = page.locator("[role='menu'][aria-label='You']");
      await menu.getByRole("menuitem", { name: /^Settings/u }).waitFor();
      await expect(menu.locator("[data-line='hub']")).toHaveCount(0);
      await menu.getByRole("menuitem", { name: /^Appearance/u }).hover();
      await expect(page.getByRole("menuitemradio")).toHaveText(["Match system", "Light", "Dark"]);
    },
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
      "updates-auto-on",
      "updates-auto-held",
      "updates-put-back",
      "updates-updated",
    ],
    open: openUpdates,
  },
  // W38: the one Update button, pressed: how it ended (all updated and this app last; the hub's download refused by
  // its checksum; the hub back on its old build; machines that didn't update or were offline), and a key the hub
  // refuses.
  {
    id: "updates",
    route: "#/",
    fixtures: ["updates-run-done", "updates-run-hub-failed", "updates-run-hub-rolled-back", "updates-run-nodes-mixed", "updates-hub-ready", "updates-refused"],
    variant: "pressed",
    open: async (page) => {
      await openUpdates(page);
      await page.getByRole("button", { name: "Update", exact: true }).click();
      await page.locator('[data-update-status]:not([data-update-status="available"])').first().waitFor();
    },
  },
  // W112: a run nothing in the hub drives any more, followed when Hub › Machines › Updates opens: The update stopped, Start over.
  {
    id: "updates",
    route: "#/",
    fixtures: ["updates-run-left-over"],
    variant: "left-over",
    open: async (page) => {
      await openUpdates(page);
      await page.getByRole("button", { name: "Start over", exact: true }).waitFor();
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
  // ...its PRs too: the hub's home, no panel of a bot it doesn't have (W890).
  { id: "home.empty", route: PRS, fixtures: ["empty"], variant: "missing-prs" },
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
  // W890: an address kept from another workspace or account, naming a bot this one doesn't have, never opens it: an
  // empty workspace lands on its own home (Get started, or Where agents run on a new cloud team), one with bots on its
  // home bot, never "This bot was removed".
  { id: "home.empty", route: STRAY_BOT, fixtures: ["empty"], variant: "stray" },
  { id: "setup.machine", route: STRAY_BOT, fixtures: ["cloud-connect"], variant: "stray" },
  { id: "chat", route: STRAY_BOT, fixtures: ["typical"], variant: "stray" },
  // Settings opened from the sidebar opens as a sheet over it; closing it returns focus to the control that opened it.
  {
    id: "shell",
    route: "#/",
    fixtures: ["typical"],
    variant: "settings-back",
    open: async (page) => {
      await page.locator("[data-opens='you']").click();
      await page.locator("[role='menu'][aria-label='You']").getByRole("menuitem", { name: /^Settings/u }).click();
      await page.getByRole("searchbox", { name: "Search settings" }).waitFor();
      await page.getByRole("button", { name: "Close settings" }).click();
      await expect(page.locator("[data-opens='you']")).toBeFocused();
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
  // fleetd cloud (fixtures/cloud), on a build given its two values: the first screen's two ways in; the wait for the
  // browser after Sign in; a sign-in that came back refused or ran out; and Use your own hub, the form as it always
  // was with a way back. Every onboarding fixture above has no `cloud` section, so it is today's screen exactly.
  { id: "onboarding", route: "#/onboarding", fixtures: ["cloud-first-screen"], variant: "ways" },
  {
    id: "onboarding",
    route: "#/onboarding",
    fixtures: ["cloud-first-screen"],
    variant: "signing-in",
    open: async (page) => {
      await page.getByRole("button", { name: "Sign in", exact: true }).click();
      await page.getByText("Finish signing in in your browser").waitFor({ timeout: 10_000 });
    },
  },
  {
    id: "onboarding",
    route: "#/onboarding",
    fixtures: ["cloud-sign-in-refused", "cloud-sign-in-timeout"],
    variant: "sign-in-failed",
    open: async (page) => {
      await page.getByRole("button", { name: "Sign in", exact: true }).click();
      await page.getByRole("button", { name: "Sign in again" }).waitFor({ timeout: 10_000 });
    },
  },
  // Back from the browser: the account named first ("Signed in as", Not you? Sign out), then each invitation asked
  // about, Join or Not now, before anything connects.
  {
    id: "onboarding",
    route: "#/onboarding",
    fixtures: ["cloud-signed-in", "cloud-invited"],
    variant: "signed-in",
    open: async (page) => {
      await page.getByRole("button", { name: "Sign in", exact: true }).click();
      await page.getByText("Signed in as sam@example.com").waitFor({ timeout: 10_000 });
    },
  },
  {
    id: "onboarding",
    route: "#/onboarding",
    fixtures: ["cloud-invited"],
    variant: "invited",
    open: async (page) => {
      await page.getByRole("button", { name: "Sign in", exact: true }).click();
      await page.getByRole("button", { name: "Continue" }).click();
      await page.getByText("eve@example.com invited you to security").waitFor({ timeout: 10_000 });
    },
  },
  // In no team of their own (they came by an invitation): Not now on it leaves No team yet, with Make a team.
  {
    id: "onboarding",
    route: "#/onboarding",
    fixtures: ["cloud-no-team"],
    variant: "no-team",
    open: async (page) => {
      await page.getByRole("button", { name: "Sign in", exact: true }).click();
      await page.getByRole("button", { name: "Continue" }).click();
      await page.getByRole("button", { name: "Not now" }).click();
      await page.getByText("No workspace yet").waitFor({ timeout: 10_000 });
    },
  },
  // ...and its Delete account: what goes, then the email typed back (a removed person signing in again lands here).
  {
    id: "onboarding",
    route: "#/onboarding",
    fixtures: ["cloud-no-team"],
    variant: "no-team-delete",
    open: async (page) => {
      await page.getByRole("button", { name: "Sign in", exact: true }).click();
      await page.getByRole("button", { name: "Continue" }).click();
      await page.getByRole("button", { name: "Not now" }).click();
      await page.getByRole("button", { name: "Delete account…" }).click();
      await page.getByRole("dialog", { name: "Delete your fleetd account?" }).getByText("Your sign-in and its history are erased.", { exact: false }).waitFor({ timeout: 10_000 });
    },
  },
  {
    id: "onboarding",
    route: "#/onboarding",
    fixtures: ["cloud-first-screen"],
    variant: "own-hub",
    open: async (page) => {
      await page.getByRole("button", { name: /^Use your own workspace/u }).click();
      await page.getByRole("textbox", { name: "Workspace address" }).waitFor({ timeout: 10_000 });
    },
  },
  // Where agents run: a team of fleetd cloud with nothing to run agents on, as its owner. A computer: Connect this
  // computer opens a terminal, or, where none opens, points at the line. Or hosted sandboxes: the team's providers.
  { id: "setup.machine", route: "#/", fixtures: ["cloud-connect"] },
  // ...hosted sandboxes connected that never get ready: past the wait, why, the fix and Try again (W743).
  // On the real clock: the wait is a timer of the screen's own.
  { id: "setup.machine.hosted.not-ready", route: "#/", fixtures: ["cloud-hosted-stuck"], realClock: true },
  {
    id: "setup.machine",
    route: "#/",
    fixtures: ["cloud-connect"],
    variant: "hosted",
    open: async (page) => {
      await page.getByRole("button", { name: "Hosted sandboxes" }).click();
      await page.locator("[data-sandbox]").first().waitFor({ timeout: 10_000 });
    },
  },
  {
    id: "setup.machine",
    route: "#/",
    fixtures: ["cloud-connect", "cloud-connect-no-terminal"],
    variant: "this-computer",
    open: async (page) => {
      await page.getByRole("button", { name: "Connect this computer" }).click();
      await page.getByText(/^Connecting this computer|^Couldn't open a terminal/u).waitFor({ timeout: 10_000 });
    },
  },
  // Get started (screens/start), fleetd cloud's first run in the web app, on its sample views (the page itself reads the
  // team's state, which the dom tests cover): a new team's steps (where agents run, its own machine free beside
  // fleetd's computers with Tailscale under them, Claude with its key and endpoint or a computer's login, GitHub, a
  // bot), and a teammate's (the team's bots, their own GitHub). Shot at the narrow size too: a browser can be any width.
  ...Object.entries({
    computer: "computer",
    "computer-tailscale-signin": "computer",
    "computer-tailscale-done": "computer",
    "computer-own": "computer",
    unusable: "computer",
    offline: "computer",
    "hosted-failed": "computer",
    "computers-held": "computer",
    "claude-key": "claude",
    claude: "claude",
    "claude-code": "claude",
    "claude-blocked": "claude",
    github: "github",
    "github-waiting": "github",
    "github-failed": "github",
    project: "project",
    "project-skipped": "project",
    "project-none": "project",
    "project-truncated": "project",
    "project-adding": "project",
    teammate: "project",
    "teammate-open": "project",
  }).map(([sample, step]): Screen => ({ id: `start.${step}`, route: `#/start?sample=${sample}`, fixtures: ["cloud-connect"], variant: sample, sizes: [...defaultSizes, "narrow"] })),
  // Where agents run on fleetd's computers, one click over from the team's own machine: Pick a plan.
  {
    id: "start.computer",
    route: "#/start?sample=computer",
    fixtures: ["cloud-connect"],
    variant: "computer-fleetd",
    sizes: [...defaultSizes, "narrow"],
    open: async (page) => {
      await page.getByRole("radio", { name: /^fleetd's computers/u }).click();
      await page.getByRole("button", { name: "Pick a plan" }).waitFor();
    },
  },
  // Claude's endpoint on the tailnet while Tailscale is off: the line beside it, with Connect Tailscale.
  {
    id: "start.claude",
    route: "#/start?sample=claude-tailnet",
    fixtures: ["cloud-connect"],
    variant: "claude-tailnet",
    sizes: [...defaultSizes, "narrow"],
    open: async (page) => {
      await page.getByLabel("Endpoint").fill("http://100.101.102.103:8317");
      await page.locator("[data-tailnet-hint]").waitFor();
    },
  },
  { id: "settings.hubs", route: "#/settings/hubs", fixtures: ["cloud-account", "cloud-account-signed-out"], variant: "fleetd-account" },
  // Delete account: what goes as the cloud reads it (a workspace left, one deleted with its plan stopping), the email
  // to type back; and held back, the only owner of a workspace with others in it, with no field to type in.
  {
    id: "settings.hubs",
    route: "#/settings/hubs",
    fixtures: ["cloud-account-delete", "cloud-account-delete-blocked"],
    variant: "delete-account",
    open: async (page) => {
      await page.getByRole("button", { name: "Delete account…" }).click();
      await page.getByRole("dialog").getByText("Your sign-in and its history are erased.", { exact: false }).or(page.getByRole("dialog").getByText("You're the only owner", { exact: false })).first().waitFor({ timeout: 10_000 });
    },
  },
  // Sign in from Settings: who signed in, then the invitation, each in a dialog before anything connects.
  {
    id: "settings.hubs",
    route: "#/settings/hubs",
    fixtures: ["cloud-account-signed-out"],
    variant: "signed-in",
    open: async (page) => {
      await page.getByRole("button", { name: "Sign in", exact: true }).click();
      await page.getByRole("dialog").getByText("Signed in as sam@example.com").waitFor({ timeout: 10_000 });
    },
  },
  {
    id: "settings.hubs",
    route: "#/settings/hubs",
    fixtures: ["cloud-account-signed-out"],
    variant: "invited",
    open: async (page) => {
      await page.getByRole("button", { name: "Sign in", exact: true }).click();
      await page.getByRole("dialog").getByRole("button", { name: "Continue" }).click();
      await page.getByRole("dialog").getByText("eve@example.com invited you to security").waitFor({ timeout: 10_000 });
    },
  },
  // A team's owner on fleetd cloud, whose hub_info leaves out the hub's own controls: no Restart hub on its row; Hub ›
  // Machines with one line where Updates was; Add machine's ways in without SSH, saying how machines join; Setup with
  // only the team's accounts.
  { id: "settings.hubs", route: "#/settings/hubs", fixtures: ["cloud-admin"], variant: "cloud-admin" },
  { id: "settings.hub.machines", route: "#/settings/hub/machines", fixtures: ["cloud-admin"], variant: "cloud" },
  // Once fleetd's computers are on for the team: no provider row; Linux machine reads fleetd's computers, or picks
  // between them and the team's own machine; Mac machine says Macs are the team's own; then fleetd's computers, each
  // bot asleep or awake with its size, how many at once of the plan's and this period's computer time. And the pick
  // open, its three choices.
  { id: "settings.hub.machines", route: "#/settings/hub/machines", fixtures: ["cloud-fleetd-only", "cloud-fleetd-own", "cloud-fleetd-older"], variant: "fleetd" },
  {
    id: "settings.hub.machines",
    route: "#/settings/hub/machines",
    fixtures: ["cloud-fleetd-own"],
    variant: "fleetd-pick",
    sizes: ["medium"],
    open: async (page) => {
      await page.getByRole("combobox", { name: "Where agents and their Linux screens run" }).click();
      await page.getByRole("option", { name: "fleetd's computers only" }).waitFor();
    },
  },
  {
    id: "settings.hub.machines",
    route: "#/settings/hub/machines",
    fixtures: ["cloud-admin"],
    variant: "cloud-add",
    open: async (page) => {
      await page.getByRole("button", { name: "Add machine" }).click();
      await page.getByRole("button", { name: "Get the line…" }).waitFor();
      await expect(page.getByRole("button", { name: "Choose…" })).toHaveCount(0);
    },
  },
  { id: "settings.hub.setup", route: "#/settings/hub/setup", fixtures: ["cloud-admin"], variant: "cloud" },
  // Its GitHub step: fleetd's one App, with no Create; Install asks the team for GitHub's page, a 409 swaps it for
  // Connect GitHub, and a service without the App says so.
  {
    id: "settings.hub.setup.step",
    route: "#/settings/hub/setup",
    fixtures: ["cloud-github-install", "cloud-github-installed", "cloud-github-not-set-up"],
    variant: "cloud-github",
    open: async (page) => {
      await page.getByRole("list", { name: "Steps" }).getByRole("button", { name: "GitHub" }).click();
      await page.locator('[data-screen="settings.hub.setup.step"]').waitFor();
      await expect(page.getByRole("button", { name: "Create GitHub App" })).toHaveCount(0);
    },
  },
  {
    id: "settings.hub.setup.step",
    route: "#/settings/hub/setup",
    fixtures: ["cloud-github-connect-first"],
    variant: "cloud-github-connect-first",
    open: async (page) => {
      await page.getByRole("list", { name: "Steps" }).getByRole("button", { name: "GitHub" }).click();
      await page.getByRole("button", { name: "Install it on repositories" }).click();
      await page.getByRole("button", { name: "Connect GitHub" }).waitFor();
    },
  },
  // UX-1 [22]: a code typed in lower case with no dash shows as ABCD-2345, and pressing Connect moves nothing above
  // the hub's answer: the field and the button stay where they were.
  {
    id: "onboarding",
    route: "#/onboarding",
    fixtures: ["onboarding-code-refused"],
    variant: "refused",
    open: async (page) => {
      await page.getByRole("textbox", { name: "Workspace address" }).fill("http://buildbox:4790");
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
  // The agents' Mac's menu bar popover, on a computer that isn't the agents' Mac: it says so, with Set up. Its states on
  // a Mac joined already (FLEETD_FIXTURE_MAC, macSetupFixture.ts) are main's to open, so its DOM test covers them.
  { id: "menu-bar", route: "#/menubar", fixtures: ["typical"], sizes: ["narrow"], realClock: true, frameless: true },
  // Set up this Mac for agents (D309), its own window: a Mac under the fixture (src/main/macSetupFixture.ts), on the
  // real clock, as main's steps take their time. Each step the window goes through, as a variant.
  { id: "mac-setup", route: "#/mac-setup", fixtures: ["typical"], sizes: ["narrow"], realClock: true },
  {
    id: "mac-setup",
    route: "#/mac-setup",
    fixtures: ["typical"],
    sizes: ["narrow"],
    realClock: true,
    variant: "wrong-code",
    open: async (page) => {
      await page.getByRole("textbox").first().fill("000000");
      await page.getByText("That code isn't open on this workspace.").waitFor({ timeout: 10_000 });
    },
  },
  {
    id: "mac-setup",
    route: "#/mac-setup",
    fixtures: ["typical"],
    sizes: ["narrow"],
    realClock: true,
    variant: "joining",
    open: async (page) => {
      await page.getByRole("textbox").first().fill("482913");
      await page.getByRole("heading", { name: "Joining devbox" }).waitFor({ timeout: 10_000 });
    },
  },
  {
    id: "mac-setup",
    route: "#/mac-setup",
    fixtures: ["typical"],
    sizes: ["narrow"],
    realClock: true,
    variant: "grants",
    open: async (page) => {
      await page.getByRole("textbox").first().fill("482913");
      await page.getByRole("heading", { name: "Setting up mac" }).waitFor({ timeout: 20_000 });
    },
  },
  {
    id: "mac-setup",
    route: "#/mac-setup",
    fixtures: ["typical"],
    sizes: ["narrow"],
    realClock: true,
    variant: "one-allowed",
    open: async (page) => {
      await page.getByRole("textbox").first().fill("482913");
      await page.getByRole("heading", { name: "Setting up mac" }).waitFor({ timeout: 20_000 });
      await page.getByRole("button", { name: "Allow", exact: true }).first().click();
      await page.getByText("Allowed", { exact: true }).first().waitFor({ timeout: 20_000 });
    },
  },
  {
    id: "mac-setup",
    route: "#/mac-setup",
    fixtures: ["typical"],
    sizes: ["narrow"],
    realClock: true,
    variant: "ready",
    open: async (page) => {
      await page.getByRole("textbox").first().fill("482913");
      await page.getByRole("heading", { name: "Setting up mac" }).waitFor({ timeout: 20_000 });
      await allowAll(page);
    },
  },
  // A version difference, one plain line each: a hub newer than this app (222222), and an Edge hub the edge release
  // moved on past (111111), which this app is signed in to as an admin, so Update for the hub is right there.
  {
    id: "mac-setup",
    route: "#/mac-setup",
    fixtures: ["typical"],
    sizes: ["narrow"],
    realClock: true,
    variant: "app-older",
    open: async (page) => {
      await page.getByRole("textbox").first().fill("222222");
      await page.getByText("This app is older than your workspace").waitFor({ timeout: 10_000 });
    },
  },
  {
    id: "mac-setup",
    route: "#/mac-setup",
    fixtures: ["typical"],
    sizes: ["narrow"],
    realClock: true,
    variant: "hub-behind",
    open: async (page) => {
      await page.getByRole("textbox").first().fill("111111");
      await page.getByRole("heading", { name: "Setting up mac" }).waitFor({ timeout: 20_000 });
      await allowAll(page);
      await page.getByRole("button", { name: "Update the workspace" }).waitFor({ timeout: 10_000 });
    },
  },
  // A Mac with no Xcode yet (the fixture's code 333333): setup still ends, its Xcode check amber with the App
  // Store's button, and only the simulator check waiting for it.
  {
    id: "mac-setup",
    route: "#/mac-setup",
    fixtures: ["typical"],
    sizes: ["narrow"],
    realClock: true,
    variant: "no-xcode",
    open: async (page) => {
      await page.getByRole("textbox").first().fill("333333");
      await page.getByRole("heading", { name: "Setting up mac" }).waitFor({ timeout: 20_000 });
      await allowAll(page);
      await page.getByRole("button", { name: "Open the App Store" }).waitFor({ timeout: 5_000 });
    },
  },
  // Its Xcode under another name, not selected (444444): the one command that selects it.
  {
    id: "mac-setup",
    route: "#/mac-setup",
    fixtures: ["typical"],
    sizes: ["narrow"],
    realClock: true,
    variant: "xcode-beta",
    open: async (page) => {
      await page.getByRole("textbox").first().fill("444444");
      await page.getByRole("heading", { name: "Setting up mac" }).waitFor({ timeout: 20_000 });
      await allowAll(page);
      await page.getByText(/^Xcode-beta\.app is in \/Applications/u).waitFor({ timeout: 5_000 });
    },
  },
  // A node that never reports its checks (555555): once it's had its time, its row says so with Restart. The page's
  // clock runs on from the join, then jumps past the wait.
  {
    id: "mac-setup",
    route: "#/mac-setup",
    fixtures: ["typical"],
    sizes: ["narrow"],
    realClock: true,
    variant: "no-checks",
    open: async (page) => {
      await page.clock.install();
      await page.reload();
      await page.getByRole("textbox").first().fill("555555");
      await page.getByRole("heading", { name: "Setting up mac" }).waitFor({ timeout: 20_000 });
      await page.clock.fastForward(21_000);
      await page.getByText("The node hasn't started.").waitFor({ timeout: 10_000 });
      await page.getByRole("button", { name: "Restart the node" }).waitFor({ timeout: 10_000 });
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
  // W100: the hub admin's setup: the welcome, a step open beside the list
  // (Claude to do with its key and endpoint, the GitHub App), and the end.
  { id: "setup.welcome", route: "#/setup/welcome", fixtures: ["setup-fresh"] },
  // The first run's Claude step holds the key and its endpoint: one on the tailnet says Tailscale isn't connected.
  {
    id: "setup",
    route: "#/setup/claude",
    fixtures: ["setup-fresh"],
    variant: "claude-tailnet",
    open: async (page) => {
      await page.getByLabel("Endpoint").fill("http://100.101.102.103:8317");
      await page.locator("[data-tailnet-hint]").waitFor();
    },
  },
  { id: "setup", route: "#/setup/claude", fixtures: ["setup-fresh", "setup-claude-logins", "setup-github"], variant: "claude" },
  { id: "setup", route: "#/setup/github", fixtures: ["setup-github"], variant: "github" },
  // A link to the cloud step, which is gone: it opens the first step left to do, Claude.
  {
    id: "setup",
    route: "#/setup/cloud",
    fixtures: ["setup-fresh"],
    variant: "old-cloud-link",
    open: async (page) => {
      await page.locator("article[data-step='claude']").waitFor();
    },
  },
  // The optional Mac step: from the account at the Mac's screen, with a user of its own last and optional (D309).
  { id: "setup", route: "#/setup/mac", fixtures: ["setup-fresh"], variant: "mac" },
  { id: "setup.done", route: "#/setup/done", fixtures: ["setup-done"] },
  // F8: New bot, a dialog over the chat: a name and no repo yet; a hub with nothing found, a machine whose node is too
  // old to make a bot's folder (it says to update it, or add a folder that's there), and no hub.
  { id: "projects.add", route: "#/projects/add", fixtures: ["typical", "empty", "long-text", "node-too-old", "hub-unreachable"] },
  // Its repos: one cloned from GitHub and a folder on the machine, then + again with what the hub found for "che".
  {
    id: "projects.add.pick",
    route: "#/projects/add",
    fixtures: ["typical", "long-text"],
    open: async (page) => {
      await page.getByRole("textbox", { name: "Name" }).fill("Checkout");
      await addRepo(page, "acme/checkout-v2");
      await addRepo(page, "/home/dev/src/pricing");
      await page.getByRole("button", { name: "Add a repo" }).click();
      await page.getByRole("combobox", { name: "Repo to add" }).fill("che");
      await expect(page.getByRole("listbox", { name: "Found" }).getByRole("option").first()).toBeVisible();
    },
  },
  // With two hubs: a name typed, then Acme picked in Adds to. The dialog stays where it was, over Personal's chat, with
  // the name and Acme's machine; nothing in it was made again (the flash, W754).
  {
    id: "projects.add",
    route: "#/projects/add",
    fixtures: ["sidebar-hubs"],
    variant: "hub-switch",
    open: async (page) => {
      await page.getByRole("textbox", { name: "Name" }).fill("Garden notes");
      await page.locator("[data-screen='projects.add']").evaluate((el) => el.setAttribute("data-qa-first", ""));
      await page.getByRole("combobox", { name: "Workspace" }).click();
      await page.getByRole("option", { name: "Acme" }).click();
      await expect(page.getByRole("combobox", { name: "Workspace" })).toHaveText("Acme");
      await expect(page.locator("[data-screen='projects.add'][data-qa-first]")).toBeVisible();
      await expect(page.getByRole("textbox", { name: "Name" })).toHaveValue("Garden notes");
      await expect(page.getByRole("combobox", { name: "Workspace" })).toBeFocused();
    },
  },
  // On a machine whose node is too old to make a bot's folder: Create says why and the fix.
  {
    id: "projects.add",
    route: "#/projects/add",
    fixtures: ["node-too-old"],
    variant: "too-old",
    open: async (page) => {
      await page.getByRole("textbox", { name: "Name" }).fill("Field notes");
      await page.getByRole("combobox", { name: "Machine" }).click();
      await page.getByRole("option", { name: "buildbox", exact: true }).click();
      await page.getByText(/buildbox needs a fleetd update/u).waitFor();
    },
  },
  // Made: the bot's chat opens behind, and the dialog shows each repo coming in: a clone at git's 42%, and one whose
  // folder already holds that repo, offering to use that copy or make a separate one.
  {
    id: "projects.add.cloning",
    route: "#/projects/add",
    fixtures: ["projects-cloning"],
    open: async (page) => {
      await page.getByRole("textbox", { name: "Name" }).fill("Checkout");
      await addRepo(page, "acme/checkout-v2");
      await addRepo(page, "acme/ledger-ui");
      await page.getByRole("button", { name: "Create", exact: true }).click();
      await page.getByRole("button", { name: "Use the same copy" }).waitFor();
      // The fixture's progress events are timed; shoot once the bar shows git's 42%.
      await page.locator('[role="progressbar"][aria-valuenow="42"]').waitFor();
    },
  },
  // The bot wasn't made: its folder holds files, or the link dropped before the hub answered. Back keeps the form.
  {
    id: "projects.add.error",
    route: "#/projects/add",
    fixtures: ["typical"],
    variant: "new",
    expect: "error",
    open: async (page) => {
      await page.getByRole("textbox", { name: "Name" }).fill("Old notes");
      await page.keyboard.press("Enter");
    },
  },
  {
    id: "projects.add.error",
    route: "#/projects/add",
    fixtures: ["projects-dropped"],
    variant: "dropped",
    expect: "error",
    open: async (page) => {
      await page.getByRole("textbox", { name: "Name" }).fill("Checkout");
      await page.keyboard.press("Enter");
      await page.getByText("Lost the connection to the workspace before it answered.").waitFor();
    },
  },
  // A folder that isn't on the machine: the hub refuses the bot, and says so.
  {
    id: "projects.add.error",
    route: "#/projects/add",
    fixtures: ["projects-errors"],
    expect: "error",
    open: async (page) => {
      await addRepo(page, "/home/dev/src/missing");
      await page.getByRole("button", { name: "Create", exact: true }).click();
    },
  },
  // Made with no repo: the bot opens at once, and a toast says so; Settings › Bots says it has none.
  {
    id: "chat",
    variant: "new-project",
    route: "#/projects/add",
    fixtures: ["projects-new"],
    open: async (page) => {
      await page.getByRole("textbox", { name: "Name" }).fill("Field notes");
      await page.keyboard.press("Enter");
      await page.getByText("Field notes is ready").first().waitFor();
    },
  },
  {
    id: "settings.projects",
    variant: "plain-folder",
    route: "#/projects/add",
    fixtures: ["projects-new"],
    open: async (page) => {
      await page.getByRole("textbox", { name: "Name" }).fill("Field notes");
      await page.keyboard.press("Enter");
      await page.getByText("Field notes is ready").first().waitFor();
      await page.evaluate(() => (window.location.hash = "#/settings/projects?for=devbox/field-notes"));
      await page.getByText("No repo, a plain folder.").waitFor({ timeout: 15_000 });
    },
  },
  // W845: Add repo on a GitHub repo whose folder already holds it, no bot using it: two plain choices, the hub's own
  // words nowhere.
  {
    id: "settings.projects",
    variant: "repo-copy",
    route: "#/projects/add",
    fixtures: ["projects-new"],
    open: async (page) => {
      await page.getByRole("textbox", { name: "Name" }).fill("Field notes");
      await page.keyboard.press("Enter");
      await page.getByText("Field notes is ready").first().waitFor();
      await page.evaluate(() => (window.location.hash = "#/settings/projects?for=devbox/field-notes"));
      await page.getByText("No repo, a plain folder.").waitFor({ timeout: 15_000 });
      await page.getByRole("button", { name: "Add a repo" }).click();
      await page.getByRole("textbox", { name: "Repo to add" }).fill("acme/ledger-ui");
      await page.getByRole("button", { name: "Add repo" }).click();
      await page.getByRole("button", { name: "Use the same copy" }).waitFor();
      await expect(page.getByText(/useExisting|\(dest\)/u)).toHaveCount(0);
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
  // W46: the Agents list's screens from a hub that serves them (fixtures/sessions), under its agents; one
  // live (the page the full width, no Steps beside it), one asking you to take over, one taken over (the page yours),
  // handed back with ⌘⇧↩; recorded ones replayed the full width, their steps closed, then opened with Steps, with a
  // video and without, a step's page snapshot open; one being saved, one lost and one expired.
  { id: "sessions", route: `${CHAT}/sessions`, fixtures: ["sessions-preview"] },
  // ...and a hub that doesn't serve them (every other fixture's): the link opens Agents, with no screens under them.
  {
    id: "agents",
    route: `${CHAT}/sessions`,
    fixtures: ["typical"],
    variant: "no-sessions",
    open: async (page) => {
      await expect(page.locator('[data-screen="agents"]')).toBeVisible();
      await expect(page.getByRole("complementary", { name: "Bot panel" }).getByRole("button", { name: "New screen", exact: true })).toHaveCount(0);
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
  // W266, D652, W859: an iPhone of your own on the Mac, the phone as its device the panel's full height under one line,
  // its toolbar at the right edge: icons only, what the Mac says works there (no postures on a plain iPhone), and 3D.
  // A runner with a graphics card (macOS) shows it in 3D, where the model takes the clicks; one without, flat, where the
  // page does: either way one element takes your clicks and keys.
  {
    id: "sessions",
    route: SESSION_ROUTE(SESSION.phone),
    fixtures: ["sessions-preview"],
    variant: "ios",
    open: async (page) => {
      await expect(page.getByRole("application", { name: /your clicks and keys go to it/u })).toBeVisible();
      await expect(page.getByRole("button", { name: "End", exact: true })).toBeVisible();
      const strip = page.getByRole("toolbar", { name: "Device" });
      await expect(strip.getByRole("button")).toHaveCount(6);
      await expect(strip.getByRole("button", { name: "Closed" })).toHaveCount(0);
    },
  },
  // ...turned from its toolbar: its frame comes on its side, and the phone turns there, its island along the left.
  {
    id: "sessions",
    route: SESSION_ROUTE(SESSION.phone),
    fixtures: ["sessions-preview"],
    variant: "ios-landscape",
    open: async (page) => {
      await page.getByRole("toolbar", { name: "Device" }).getByRole("button", { name: "Rotate", exact: true }).click();
      await expect(page.locator('[data-kind="phone"][data-roll="90"]')).toBeVisible();
    },
  },
  // ...an Android of your own: its toolbar is an Android's (home, rotate, screenshot; rotate right and back under More).
  {
    id: "sessions",
    route: SESSION_ROUTE(SESSION.android),
    fixtures: ["sessions-preview"],
    variant: "android-strip",
    open: async (page) => {
      const strip = page.getByRole("toolbar", { name: "Device" });
      await expect(strip.getByRole("button")).toHaveCount(5);
      await strip.getByRole("button", { name: "More" }).click();
      await expect(page.getByRole("menuitem", { name: "Back" })).toBeVisible();
    },
  },
  // D305: the Screens page, the wall: needs you on top with Take over, the live ones as pictures with their kind, machine
  // and latest step, then the recent ones. A hub that serves no screens: the page says how they come.
  {
    id: "screens",
    route: "#/screens",
    fixtures: ["sessions-page"],
    open: async (page) => {
      await expect(page.getByRole("button", { name: "Take over" })).toBeVisible();
      await expect(page.getByText("Android · buildbox")).toBeVisible();
      await expect(page.getByText("Tapped “Add to cart”")).toBeVisible();
      await expect(page.locator('section[aria-label="Live"] img')).toHaveCount(5);
    },
  },
  { id: "screens", route: "#/screens", fixtures: ["typical"] },
  // ...New screen, the same picker as a bot's Screens tab, its first pick the bot.
  {
    id: "screens",
    route: "#/screens",
    fixtures: ["sessions-page"],
    variant: "new",
    open: async (page) => {
      await page.getByRole("button", { name: "New screen", exact: true }).click();
      await expect(page.locator('[data-screen="sessions.new"]')).toBeVisible();
      await expect(page.getByRole("combobox", { name: "Bot" })).toBeVisible();
    },
  },
  // ...and one open: D278's view takes the page, with a way back to the wall.
  {
    id: "screens",
    route: `#/screens/devbox/dcffccea-c5a7-40a6-940d-7f70239ffa22/B7c1e5a9d3f7b1c5e9a3d7f1b5c9e3a7d`,
    fixtures: ["sessions-page"],
    variant: "view",
  },
  // D239: New screen, the plus beside Screens in the Agents list, as it opens: the title, the kind as four tiles (no
  // iOS, D298) with Browser picked, the machine and Open, and no explaining lines under the title (W796).
  {
    id: "sessions",
    route: `${CHAT}/sessions`,
    fixtures: ["sessions-preview"],
    variant: "new-screen-browser",
    open: async (page) => {
      await page.getByRole("button", { name: "New screen", exact: true }).click();
      await expect(page.getByRole("radio", { name: /^Browser/u })).toHaveAttribute("aria-checked", "true");
    },
  },
  // D652: an iPhone, picked: the Mac, one of its two simulators booted, then the model and the OS side by side, the
  // OS the model's newest; the iPhone Duo runs only its own.
  {
    id: "sessions",
    route: `${CHAT}/sessions`,
    fixtures: ["sessions-preview"],
    variant: "new-screen-iphone",
    open: async (page) => {
      await page.getByRole("button", { name: "New screen", exact: true }).click();
      await page.getByRole("radio", { name: /^iPhone/u }).click();
      await expect(page.getByRole("combobox", { name: "Model" })).toHaveText("iPhone 17");
      await expect(page.getByRole("combobox", { name: "OS" })).toHaveText("iOS 27.2");
      await expect(page.getByText("1 of 2 in use")).toBeVisible();
    },
  },
  // ...the Duo picked and opened: its live view, yours, closed, with its strip and the fold among it.
  {
    id: "sessions",
    route: `${CHAT}/sessions`,
    fixtures: ["sessions-preview"],
    variant: "new-screen-duo",
    open: async (page) => {
      await openDuo(page);
    },
  },
  // ...and opened: the inner panel, wide, the phone growing to it.
  {
    id: "sessions",
    route: `${CHAT}/sessions`,
    fixtures: ["sessions-preview"],
    variant: "duo-open",
    open: async (page) => {
      await openDuo(page);
      await page.getByRole("toolbar", { name: "Device" }).getByRole("button", { name: "Open", exact: true }).click();
      await expect(page.locator('[data-kind="duo"][data-panel="inner"]')).toBeVisible();
    },
  },
  // W859: the Duo in 3D from its toolbar, half open as a book, turned by a drag off its display: a model of the real
  // device, the picture its display.
  {
    id: "sessions",
    route: `${CHAT}/sessions`,
    fixtures: ["sessions-preview"],
    variant: "duo-3d",
    open: async (page) => {
      await openDuo(page);
      const toolbar = page.getByRole("toolbar", { name: "Device" });
      await toolbar.getByRole("button", { name: "Open", exact: true }).click();
      await expect(page.locator('[data-kind="duo"][data-panel="inner"]')).toBeVisible();
      // A runner with a graphics card (macOS) starts in 3D; one drawing WebGL on the CPU (Linux) starts flat until asked.
      if ((await page.locator('[data-mode="3d"]').count()) === 0) await toolbar.getByRole("button", { name: "Show it in 3D" }).click();
      const model = page.locator('[data-mode="3d"] > [role="application"]');
      await expect(model).toBeVisible();
      const at = await model.boundingBox();
      if (at === null) throw new Error("the 3D device has no box");
      await page.mouse.move(at.x + 8, at.y + 8);
      await page.mouse.down();
      await page.mouse.move(at.x + 68, at.y + 28, { steps: 6 });
      await page.mouse.up();
      await expect(toolbar.getByRole("button", { name: "Face front" })).toBeVisible();
    },
  },
  // ...the machines that can host it with their slots; the agents' Mac, its one screen in use, offers to wait, and the
  // wait shows in the list until cancelled.
  {
    id: "sessions",
    route: `${CHAT}/sessions`,
    fixtures: ["sessions-preview"],
    variant: "new-screen",
    open: async (page) => {
      await page.getByRole("button", { name: "New screen", exact: true }).click();
      await expect(page.locator('[data-screen="sessions.new"]')).toBeVisible();
      await page.getByRole("radio", { name: /^Agents’ Mac/u }).click();
      await expect(page.getByRole("button", { name: "Wait for a slot" })).toBeVisible();
    },
  },
  {
    id: "sessions",
    route: `${CHAT}/sessions`,
    fixtures: ["sessions-preview"],
    variant: "new-screen-waiting",
    open: async (page) => {
      await page.getByRole("button", { name: "New screen", exact: true }).click();
      await page.getByRole("radio", { name: /^Agents’ Mac/u }).click();
      await page.getByRole("button", { name: "Wait for a slot" }).click();
      await expect(page.getByText("waiting for a free slot · next in line")).toBeVisible();
    },
  },
  // ...a Linux desktop: devbox, with room.
  {
    id: "sessions",
    route: `${CHAT}/sessions`,
    fixtures: ["sessions-preview"],
    variant: "new-screen-linux",
    open: async (page) => {
      await page.getByRole("button", { name: "New screen", exact: true }).click();
      await page.getByRole("radio", { name: /^Linux desktop/u }).click();
      await expect(page.getByRole("radio", { name: /^Linux desktop/u })).toHaveAttribute("aria-checked", "true");
    },
  },
  // An Android screen on devbox takes an open PR's build: picked from storefront's open PRs, said in one line.
  {
    id: "sessions",
    route: `${CHAT}/sessions`,
    fixtures: ["sessions-preview"],
    variant: "new-screen-pr",
    open: async (page) => {
      await page.getByRole("button", { name: "New screen", exact: true }).click();
      await page.getByRole("radio", { name: /^Android/u }).click();
      await page.getByRole("combobox", { name: "PR build" }).click();
      await page.getByRole("option", { name: "#14 Checkout keeps the cart after sign-in" }).click();
      await expect(page.getByRole("combobox", { name: "PR build" })).toHaveText("#14 Checkout keeps the cart after sign-in");
    },
  },
  // ...opened: it goes on in the hub, and the picker follows it (here, the build going in) until the screen is yours.
  {
    id: "sessions",
    route: `${CHAT}/sessions`,
    fixtures: ["sessions-preview"],
    variant: "new-screen-pr-opening",
    open: async (page) => {
      await page.getByRole("button", { name: "New screen", exact: true }).click();
      await page.getByRole("radio", { name: /^Android/u }).click();
      await page.getByRole("combobox", { name: "PR build" }).click();
      await page.getByRole("option", { name: "#14 Checkout keeps the cart after sign-in" }).click();
      await page.getByRole("button", { name: "Open screen" }).click();
      await expect(page.getByText("Installing #14’s build on devbox…")).toBeVisible();
    },
  },
  // ...and a browser of your own on devbox: its live view, yours from the start, with End and no Hand back.
  {
    id: "sessions",
    route: `${CHAT}/sessions`,
    fixtures: ["sessions-preview"],
    variant: "new-screen-yours",
    open: async (page) => {
      await page.getByRole("button", { name: "New screen", exact: true }).click();
      await page.getByRole("button", { name: "Open screen" }).click();
      await expect(page.getByRole("button", { name: "End", exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: /^Hand back/u })).toHaveCount(0);
    },
  },
  {
    id: "sessions",
    route: SESSION_ROUTE(SESSION.payouts),
    fixtures: ["sessions-preview"],
    variant: "yours",
    open: async (page, app) => {
      // The screen's own Take over, in the panel: the chat's card of it and the strip over the composer have one too.
      await page.getByRole("tabpanel", { name: "Agents" }).getByRole("button", { name: "Take over", exact: true }).click();
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
      // The screen's own Take over, in the panel: the chat's card of it and the strip over the composer have one too.
      await page.getByRole("tabpanel", { name: "Agents" }).getByRole("button", { name: "Take over", exact: true }).click();
      await page.getByRole("application").focus();
      await page.keyboard.press("ControlOrMeta+Shift+Enter");
      await expect(page.getByRole("tabpanel", { name: "Agents" }).getByText("handed back", { exact: true })).toBeVisible();
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
  // ...an iPhone Duo's, recorded by the node's own stream: drawn by the screen player into one canvas, the frame the
  // picture's own shape (no letterbox), every seek landing on its picture with the canvas never blank between.
  {
    id: "sessions",
    route: SESSION_ROUTE(SESSION.duoReplay),
    fixtures: ["sessions-preview"],
    variant: "duo-replay",
    open: async (page) => {
      // The player's canvas; a runner with a graphics card (macOS) also has the 3D stage's, which draws it.
      const canvas = page.locator("[data-screen='sessions.replay'] canvas:not([data-stage])");
      await expect(canvas).toHaveCount(1);
      await expect(page.locator("video")).toHaveCount(0);
      // The first picture, at its own size: the open inner panel, landscape.
      await expect.poll(() => canvas.evaluate((c: HTMLCanvasElement) => c.width)).toBe(900);
      const shape = await canvas.evaluate((c: HTMLCanvasElement) => {
        const box = c.getBoundingClientRect();
        return { drawn: c.width / c.height, shown: box.width / box.height };
      });
      expect(Math.abs(shape.drawn - shape.shown)).toBeLessThan(0.02);
      await page.getByRole("slider", { name: "Where in the recording" }).fill("6000");
      await expect(page.getByText(/^0:06 \/ /u)).toBeVisible();
      await expect.poll(() => canvas.evaluate((c: HTMLCanvasElement) => c.width)).toBe(900);
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
      await expect(page.getByText("No agents are working.")).toBeVisible();
      await page.getByRole("button", { name: /^Also on this repo/u }).click();
      await expect(page.getByText("storefront’s agent · running")).toBeVisible();
    },
  },
  // ...and Other projects, the fold under them when another project has agents at work, opened: each project's agents
  // under its name, checkout's first as one waits on you.
  {
    id: "agents",
    route: `${CHAT}/agents`,
    fixtures: ["agents-work"],
    variant: "all",
    open: async (page) => {
      await page.getByRole("button", { name: /^Other bots/u }).click();
      await expect(page.getByRole("button", { name: /^Other bots/u })).toHaveAttribute("aria-expanded", "true");
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
  // W533: the DMs T1 sent and got, as cards among its steps: read at a step, a wake allowed, one held for a finished agent.
  { id: "agents.work", route: AGENT_ROUTE, fixtures: ["dms-relays"], variant: "dms" },
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
  // W919: where an order's chip lands, the order itself: its agents at work and finished, each opening it, and its PRs.
  {
    id: "agents.order",
    route: `#/project/${AGENT.machineId}/${AGENT.projectId}/agents/W1`,
    fixtures: ["agents-work"],
    open: (page) => expect(page.locator('[data-screen="agents.order"] h2')).toBeVisible(),
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
  // F9: Settings. The built-in prompts open from the foot of Instructions; one opens on the lead's first message, the
  // longest text; many-prompts lists 72 with long keys and titles; settings-prompts is the real registry with edits.
  // Max agents: the fleet cap and each project's slider.
  // Settings › Projects: the list of projects, each row opening its pages under tabs; none yet says how to make one, and
  // no hub says it isn't connected.
  { id: "settings.projects", variant: "list", route: "#/settings/projects", fixtures: ["admin-owner", "admin-member", "empty", "hub-unreachable"] },
  { id: "settings.agents", route: "#/settings/agents", fixtures: ["settings-agents", "long-text", "empty", "hub-unreachable"] },
  // Settings' Hub group (D211): People as the owner (every row changeable but their own) and as an admin (the owner
  // out of reach), with Invite someone, Dana's invite waiting and a new one just made with its link; Every project's
  // Agents (at Tools & skills, which was a page once) and Instructions (the hub-wide built-in prompts open from its
  // foot); Setup, which holds the hub's accounts (Hub accounts once); and a member who follows a link.
  { id: "settings.hub.people", route: "#/settings/hub/people", fixtures: ["admin-owner", "admin-admin", "admin-old-hub"] },
  // The audit log: a morning of the workspace, newest first, by name, a member's refused change in red, Older for the
  // rest; and a workspace from before it, which says to update.
  { id: "settings.hub.audit", route: "#/settings/hub/audit", fixtures: ["admin-owner", "admin-old-hub"] },
  // Share links: on, at the workspace's preview name, an agent's link and a person's, each with Open, Renew and Stop,
  // and Share a port under them; and a workspace from before them, which says to update.
  { id: "settings.hub.share", route: "#/settings/hub/share", fixtures: ["admin-owner", "admin-old-hub"] },
  // The Vault: the team's logins, cards and addresses with the set-aside section under them; as a member; one list on
  // a hub from before the team vault; and an empty one, its own add beside its words. A team card only its creator or an admin may show or change, opened.
  // A project's variables and its order's; and Every project › Vault, the vault key alone.
  { id: "settings.vault", route: "#/settings/vault", fixtures: ["vault-team", "vault-team-member", "vault-old-hub", "vault-empty"] },
  {
    id: "settings.vault",
    variant: "creator-or-admin",
    route: "#/settings/vault",
    fixtures: ["vault-team-member"],
    open: async (page) => {
      await page.getByRole("listitem", { name: "Workspace Visa" }).getByRole("button").click();
      await expect(page.getByText("Only its creator or an admin can show it. Agents still fill it.")).toBeVisible();
    },
  },
  { id: "settings.project-vault", route: `#/settings/project-vault?for=${AGENT.machineId}/${AGENT.projectId}`, fixtures: ["vault-team"] },
  { id: "settings.hub.vault", route: "#/settings/hub/vault", fixtures: ["vault-team"] },
  // Hub accounts is a part of Setup: its old link lands on Setup's accounts, each a row. A hub too old to serve its
  // steps says so and still lists its own two accounts.
  { id: "settings.hub.accounts", route: "#/settings/hub/accounts", fixtures: ["admin-owner", "admin-admin"] },
  { id: "settings.hub.accounts", route: "#/settings/hub/accounts", fixtures: ["admin-old-hub"], expect: "error" },
  // Your accounts › Claude: the owner on their own subscription, Alice on the hub's key by choice, Bob on it by default,
  // and Bob with nothing to run on, told to connect.
  { id: "settings.accounts", route: "#/settings/accounts", fixtures: ["admin-owner", "admin-admin", "admin-member", "admin-claude-member", "admin-old-hub", "hub-unreachable"] },
  // Several hubs: the hub it manages above the page, and a switch to the hubs Sam administers (Club, a member's, isn't).
  {
    id: "settings.hub.people",
    route: "#/settings/hub/people?at=h2",
    fixtures: ["admin-hubs"],
    variant: "hubs",
    open: async (page) => {
      await expect(page.getByRole("note", { name: "Managing Acme" })).toBeVisible();
      await page.getByRole("button", { name: "Invite someone" }).click();
      await expect(page.getByRole("button", { name: "Create invite link to Acme" })).toBeVisible();
    },
  },
  {
    id: "settings.hub.people",
    route: "#/settings/hub/people",
    fixtures: ["admin-owner", "admin-owner-here"],
    variant: "created",
    open: async (page) => {
      await page.getByRole("button", { name: "Invite someone" }).click();
      await page.getByRole("textbox", { name: "Name" }).fill("Eve Park");
      await page.getByRole("button", { name: "Create invite link" }).click();
      await page.getByRole("region", { name: "Invite link for Eve Park" }).getByRole("button", { name: "Copy link" }).waitFor();
    },
  },
  // Making someone an owner asks first: an admin can't take it back.
  {
    id: "settings.hub.people",
    route: "#/settings/hub/people",
    fixtures: ["admin-owner"],
    variant: "make-owner",
    open: async (page) => {
      await page.getByRole("combobox", { name: "Bob Okafor's role" }).click();
      await page.getByRole("option", { name: "Owner" }).click();
      await page.getByRole("dialog", { name: "Make Bob Okafor an owner?" }).waitFor();
    },
  },
  // W469 and W603: Hub › Machines at its Updates (a page of its own once: its link lands there): the everyday status (up to date, Update automatically on), a ready build it installs
  // by itself, one holding back with why, and the switch off.
  { id: "settings.hub.updates", route: "#/settings/hub/updates", fixtures: ["updates-auto-current", "updates-auto-on", "updates-auto-held", "updates-hub-current", "updates-numbered"] },
  // Machines: the hub's machines, each a name and its role, with a dot on one that needs someone (offline, claude
  // logged out); a hub with one machine; a run going; a failed step with Retry. Add machine is the button at the
  // title's end.
  { id: "settings.hub.machines", route: "#/settings/hub/machines", fixtures: ["machines-add", "machines-one", "machines-unwell", "machines-running", "machines-failed"] },
  // W721: no machine yet, the empty list holding Add machine itself (and no button at the title); boat.dev connected with
  // no Claude account for its hosted agents, which the providers' notice says with Connect. Its button opens Add machine.
  { id: "settings.hub.machines", route: "#/settings/hub/machines", fixtures: ["machines-none"], variant: "none" },
  {
    id: "settings.hub.machines",
    route: "#/settings/hub/machines",
    fixtures: ["machines-none"],
    variant: "none-add",
    open: async (page) => {
      await page.locator("[data-machines-none]").getByRole("button", { name: "Add machine" }).click();
      await page.getByRole("button", { name: "Choose…" }).waitFor();
    },
  },
  // W693: the page as one model, every place agents and screens run a row with its state as a dot: three machines (one
  // busy, one logged out, one offline) with boat.dev (refused) connected, so What runs where's Linux machine is a pick; one machine and nothing
  // connected; and each machine's page.
  { id: "settings.hub.machines", route: "#/settings/hub/machines", fixtures: ["machines-places", "machines-places-one"], variant: "places" },
  // ...Connect on a provider opens its key's sealed field in its row, the same for each of them.
  {
    id: "settings.hub.machines",
    route: "#/settings/hub/machines",
    fixtures: ["machines-places-one"],
    variant: "places-connect",
    open: async (page) => {
      await page.locator('[data-sandbox="boat"]').getByRole("button", { name: "Connect" }).click();
      await page.getByRole("textbox", { name: "fleetd's computers API key" }).waitFor();
    },
  },
  // W722, D653: Tailscale's row in Connections: Connect; waiting for the sign-in at Tailscale's page; connected with
  // the tailnet's name; the gateway ended, with why and Connect again.
  {
    id: "connections",
    route: "#/connections",
    fixtures: ["machines-tailscale-off", "machines-tailscale-login", "machines-tailscale-on", "machines-tailscale-failed"],
    variant: "tailscale",
    open: async (page) => {
      await page.locator("[data-tailscale]").waitFor();
    },
  },
  { id: "settings.hub.machine", route: "#/settings/hub/machines/devbox", fixtures: ["machines-places"], variant: "places" },
  { id: "settings.hub.machine", route: "#/settings/hub/machines/buildbox", fixtures: ["machines-places"], variant: "places-offline" },
  { id: "settings.hub.machine", route: "#/settings/hub/machines/laptop", fixtures: ["machines-places"], variant: "places-laptop" },
  // D576: a hub that had Revyl connected before fleetd removed it says so in one plain line above the providers.
  {
    id: "settings.hub.machines",
    route: "#/settings/hub/machines",
    fixtures: ["machines-revyl-removed"],
    variant: "revyl-removed",
    open: async (page) => {
      await page.locator("[data-sandboxes]").scrollIntoViewIfNeeded();
      await expect(page.getByText("Revyl was removed from fleetd, with the key you connected")).toBeVisible();
    },
  },
  // D576: a hub that had E2B and Daytona connected says so, a plain line each, and lists boat.dev alone.
  {
    id: "settings.hub.machines",
    route: "#/settings/hub/machines",
    fixtures: ["machines-e2b-removed"],
    variant: "e2b-removed",
    open: async (page) => {
      await page.locator("[data-sandboxes]").scrollIntoViewIfNeeded();
      await expect(page.getByText("E2B was removed from fleetd, with the key you connected")).toBeVisible();
      await expect(page.getByText("Daytona was removed from fleetd, with the key you connected")).toBeVisible();
    },
  },
  // W727: What runs where is two rows; with machines and boat.dev both, Linux machine is a pick of three places.
  {
    id: "settings.hub.machines",
    route: "#/settings/hub/machines",
    fixtures: ["machines-places"],
    variant: "where-pick",
    open: async (page) => {
      const where = page.locator("[data-where]");
      await where.scrollIntoViewIfNeeded();
      await expect(where.locator("[data-where-kind]")).toHaveCount(2);
      const linux = where.locator("[data-where-kind='linux']");
      await expect(linux.getByRole("combobox", { name: "Where agents and their Linux screens run" })).toContainText("Your machines first, then fleetd's computers");
      await linux.getByRole("combobox").click();
      await expect(page.getByRole("option", { name: "fleetd's computers only" })).toBeVisible();
    },
  },
  // W743: boat.dev's row says its real state with the one button that fixes it: Starting… while the hub's runner comes
  // up; Ready with 3 of 20 running; Needs a Claude account with Connect; Couldn't start after a refusal for billing, with
  // its fix and Try again; its key refused at its test, with Test again. No explaining text under it at rest.
  {
    id: "settings.hub.machines",
    route: "#/settings/hub/machines",
    fixtures: ["machines-hosted-starting", "machines-hosted-ready", "machines-none", "machines-hosted-refused", "machines-sandboxes-on"],
    variant: "hosted-states",
    open: async (page) => {
      const row = page.locator('[data-sandbox="boat"]');
      await row.scrollIntoViewIfNeeded();
      await expect(row).toHaveAttribute("data-hosted-state", /^(starting|ready|needs_claude|failed)$/);
    },
  },
  // W688: the team's own hosted sandbox account, one section on Machines: none connected, and one with a failed test.
  {
    id: "settings.hub.machines",
    route: "#/settings/hub/machines",
    fixtures: ["machines-sandboxes-off", "machines-sandboxes-on"],
    variant: "sandboxes",
    open: async (page) => {
      await page.locator("[data-sandboxes]").scrollIntoViewIfNeeded();
    },
  },
  // ...Connect on boat.dev opens its sealed key field.
  {
    id: "settings.hub.machines",
    route: "#/settings/hub/machines",
    fixtures: ["machines-sandboxes-off"],
    variant: "sandboxes-connect",
    open: async (page) => {
      await page.locator('[data-sandbox="boat"]').getByRole("button", { name: "Connect" }).click();
      await page.getByRole("textbox", { name: "fleetd's computers API key" }).waitFor();
    },
  },
  // W743: a link to the hosted sandboxes' old machine page lands on Machines at boat.dev's row, never a machine page.
  {
    id: "settings.hub.machines",
    route: "#/settings/hub/machines/hosted",
    fixtures: ["machines-sandboxes-on"],
    variant: "hosted-link",
    open: async (page) => {
      await expect(page.locator('[data-sandbox="boat"]')).toBeInViewport();
      await expect(page.locator("[data-screen='settings.hub.machine']")).toHaveCount(0);
      await expect.poll(() => page.evaluate(() => window.location.hash)).toBe("#/settings/hub/machines");
    },
  },
  // The plus opens Add machine's ways in over the list.
  {
    id: "settings.hub.machines",
    route: "#/settings/hub/machines",
    fixtures: ["machines-add"],
    variant: "add",
    open: async (page) => {
      await page.getByRole("button", { name: "Add machine" }).click();
      await page.getByRole("button", { name: "Choose…" }).waitFor();
    },
  },
  {
    id: "settings.hub.machines",
    route: "#/settings/hub/machines",
    fixtures: ["machines-add"],
    variant: "hosts",
    open: async (page) => {
      await page.getByRole("button", { name: "Add machine" }).click();
      await page.getByRole("button", { name: "Choose…" }).click();
      await page.getByRole("list", { name: "Hosts" }).waitFor();
    },
  },
  {
    id: "settings.hub.machines",
    route: "#/settings/hub/machines",
    fixtures: ["machines-add"],
    variant: "plan",
    open: async (page) => {
      await page.getByRole("button", { name: "Add machine" }).click();
      await page.getByRole("button", { name: "Choose…" }).click();
      await page.getByRole("button", { name: "Plan…" }).first().click();
      await page.getByRole("button", { name: "Add builder-1" }).waitFor();
    },
  },
  // A Mac for agents: the 6-digit code the fleetd app on the Mac takes, with the hub's address under it.
  {
    id: "settings.hub.machines",
    route: "#/settings/hub/machines",
    fixtures: ["machines-add"],
    variant: "mac-code",
    open: async (page) => {
      await page.getByRole("button", { name: "Add machine" }).click();
      await page.getByRole("button", { name: "Set up…" }).click();
      await page.getByText("482 913").waitFor();
    },
  },
  // Any other machine: its name, then the line with Copy and "Waiting for laptop…", which turns into Joined.
  {
    id: "settings.hub.machines",
    route: "#/settings/hub/machines",
    fixtures: ["machines-add"],
    variant: "line",
    open: async (page) => {
      await page.getByRole("button", { name: "Add machine" }).click();
      await page.getByRole("button", { name: "Get the line…" }).click();
      await page.getByRole("textbox", { name: "Name" }).fill("laptop");
      await page.getByRole("button", { name: "Make the line" }).click();
      await page.getByText("Waiting for laptop…").waitFor();
    },
  },
  {
    id: "settings.hub.machines",
    route: "#/settings/hub/machines",
    fixtures: ["machines-joined"],
    variant: "joined",
    open: async (page) => {
      await page.getByRole("button", { name: "Add machine" }).click();
      await page.getByRole("button", { name: "Get the line…" }).click();
      await page.getByRole("textbox", { name: "Name" }).fill("laptop");
      await page.getByRole("button", { name: "Make the line" }).click();
      await page.getByText("laptop joined.").waitFor();
    },
  },
  // A Mac for agents in Terminal, under its code (D309): the Xcode block from the hub's guide, the name, then its line
  // and the two clicks.
  {
    id: "settings.hub.machines",
    route: "#/settings/hub/machines",
    fixtures: ["machines-add"],
    variant: "mac",
    open: async (page) => {
      await page.getByRole("button", { name: "Add machine" }).click();
      await page.getByRole("button", { name: "Set up…" }).click();
      await page.getByRole("button", { name: "Use Terminal instead" }).click();
      await page.getByRole("button", { name: "Make the line" }).click();
      await page.getByText("Waiting for mac…").waitFor();
    },
  },
  // A machine's page says only what is wrong with it: nothing while its checks pass, one row with Log in while claude
  // is logged out, one with the command to run while a screen kind is off; and Claude's login from the app with the
  // page to sign in at and the code field.
  { id: "settings.hub.machine", route: "#/settings/hub/machines/laptop", fixtures: ["machines-well", "machines-logged-out", "machines-warning"] },
  // A machine that needs someone says why where its state is, with Repair beside it: buildbox offline for three days.
  { id: "settings.hub.machine", route: "#/settings/hub/machines/buildbox", fixtures: ["machines-unwell"], variant: "offline" },
  // The whole row opens its machine, its ends too: the dot, the state's words and the chevron are marks, so the
  // pointer falls through each to the row's link, which holds the dot's why as its tooltip. A click on the chevron,
  // back, one on the dot, back, then one on the words.
  {
    id: "settings.hub.machine",
    route: "#/settings/hub/machines",
    fixtures: ["machines-unwell"],
    variant: "from-dot",
    open: async (page) => {
      const row = page.getByRole("listitem", { name: "buildbox" });
      // Its chevron, its dot and its state's words: each a part of the row, which opens its page.
      for (const mark of [row.locator("svg").last(), row.getByRole("img", { name: /^Offline/u }), row.getByText(/^Offline since/u)]) {
        await page.evaluate(() => {
          window.location.hash = "#/settings/hub/machines";
        });
        const at = await mark.boundingBox();
        if (at === null) throw new Error("buildbox's row has no dot or no chevron");
        const [x, y] = [at.x + at.width / 2, at.y + at.height / 2];
        expect(await page.evaluate(([px, py]) => document.elementFromPoint(px ?? 0, py ?? 0)?.closest("a")?.title, [x, y])).toMatch(/^Offline/u);
        await page.mouse.click(x, y);
        await expect(page).toHaveURL(/#\/settings\/hub\/machines\/buildbox$/u);
      }
    },
  },
  // Repair opens in place: buildbox joined by itself, so its line again and the wait for it.
  {
    id: "settings.hub.machine",
    route: "#/settings/hub/machines/buildbox",
    fixtures: ["machines-unwell"],
    variant: "repair",
    open: async (page) => {
      await page.getByRole("button", { name: "Repair…" }).click();
      await page.getByText("Waiting for buildbox…").waitFor();
    },
  },
  // Remove, at the page's end, asks first.
  {
    id: "settings.hub.machine",
    route: "#/settings/hub/machines/buildbox",
    fixtures: ["machines-unwell"],
    variant: "remove",
    open: async (page) => {
      await page.getByRole("button", { name: "Remove…" }).click();
      await page.getByRole("dialog").waitFor();
    },
  },
  {
    id: "settings.hub.machine",
    route: "#/settings/hub/machines/laptop",
    fixtures: ["machines-logged-out"],
    variant: "login",
    open: async (page) => {
      await page.getByRole("button", { name: "Log in…" }).click();
      await page.getByRole("form", { name: "Sign in" }).waitFor();
    },
  },
  { id: "settings.hub.tools", route: "#/settings/hub/tools", fixtures: ["admin-owner", "settings-agents", "admin-old-hub"] },
  // Every project › Agents: the Default profile and Lead runs on, picked from the profiles Providers lists, then skills.
  { id: "settings.hub.agents", route: "#/settings/hub/agents", fixtures: ["admin-owner", "settings-agents"] },
  // Providers with the hub's three profiles under Anthropic, high the default and quick in fast mode; medium open in
  // its editor, on Anthropic's models, its reasoning and fast mode.
  {
    id: "settings.hub.providers",
    route: "#/settings/hub/providers",
    fixtures: ["settings-agents"],
    variant: "edit",
    open: async (page) => {
      // A profile's editor opens from its name.
      await page.locator("[data-profile='medium'] button").first().click();
      await page.getByRole("region", { name: "Edit medium" }).waitFor();
    },
  },
  // Providers: Anthropic and Google, a row each with how it is connected and its profiles under it; Google not connected yet
  // (Sign in with Google at its end), and connected (signed in, a bot's key). Then Google's row open, and its sign-in
  // started from the row: the Google page to open and the code to paste.
  { id: "settings.hub.providers", route: "#/settings/hub/providers", fixtures: ["admin-owner", "admin-google"] },
  {
    id: "settings.hub.providers",
    route: "#/settings/hub/providers",
    fixtures: ["admin-google"],
    variant: "google",
    open: async (page) => {
      await page.locator("[data-provider='google'] button").first().click();
      await page.locator("[data-provider-setup='google']").waitFor();
    },
  },
  {
    id: "settings.hub.providers",
    route: "#/settings/hub/providers",
    fixtures: ["admin-owner"],
    variant: "sign-in",
    open: async (page) => {
      await page.getByRole("button", { name: "Sign in with Google" }).click();
      await page.getByRole("form", { name: "Sign in" }).waitFor();
    },
  },
  // Google's row open on a hub with no team key yet, and Add key…: the key and its endpoint, sealed on Save.
  {
    id: "settings.hub.providers",
    route: "#/settings/hub/providers",
    fixtures: ["admin-owner"],
    variant: "gemini-key",
    open: async (page) => {
      await page.locator("[data-provider='google'] button").first().click();
      await page.getByRole("button", { name: "Add key…" }).click();
      await page.getByRole("textbox", { name: "Gemini API key" }).waitFor();
    },
  },
  // A new profile under Google, which isn't connected: the editor on Google's models.
  {
    id: "settings.hub.providers",
    route: "#/settings/hub/providers",
    fixtures: ["settings-agents"],
    variant: "google-profile",
    sizes: ["medium"],
    open: async (page) => {
      await page.getByRole("button", { name: "Add Google profile" }).click();
      await page.getByRole("region", { name: "New Google profile" }).waitFor();
    },
  },
  // A profile's Model open: its provider's models alone.
  {
    id: "settings.hub.providers",
    route: "#/settings/hub/providers",
    fixtures: ["settings-agents"],
    variant: "models",
    sizes: ["medium"],
    open: async (page) => {
      await page.locator("[data-profile='medium'] button").first().click();
      await page.getByRole("combobox", { name: "Model" }).click();
      await page.getByRole("listbox").waitFor();
    },
  },
  { id: "settings.hub.instructions", route: "#/settings/hub/instructions", fixtures: ["admin-owner", "settings-agents"] },
  // Every project › Agents, at its skills: the hub-wide ones (one installed and pinned), Update on the installed one,
  // and Install.
  {
    id: "settings.hub.tools",
    route: "#/settings/hub/tools",
    fixtures: ["admin-owner"],
    variant: "skills-installed",
    open: async (page) => {
      await page.getByRole("button", { name: /^pr-review/u }).click();
      await expect(page.getByRole("button", { name: "Update", exact: true })).toBeVisible();
    },
  },
  {
    id: "settings.hub.tools",
    route: "#/settings/hub/tools",
    fixtures: ["admin-owner"],
    variant: "skills-install",
    open: async (page) => {
      await page.getByRole("button", { name: "Install from a source…" }).click();
      await page.getByRole("textbox", { name: "Source" }).fill("acme/agent-skills");
      await page.getByRole("button", { name: "Install", exact: true }).click();
      await page.getByText(/^Installed pr-review, pinned/u).waitFor();
    },
  },
  // Hub › Setup reads the hub's steps (setup_list), a row each: its accounts always, each saying what it uses or
  // what it needs, then the other steps left. A fresh hub with a required step left, one with only later steps left,
  // one with every step done, and a hub in use whose 1Password asks for a look. The done steps shown again. A row
  // opens its step in place: an account's page is its controls over its guide (Claude, teams step 8: the hub's key
  // sealed and tested and the members switch, Change opening the key's form, which never shows the key; GitHub's App,
  // and GitHub on a fresh hub, its guide open); any other step is its guide.
  { id: "settings.hub.setup", route: "#/settings/hub/setup", fixtures: ["setup-fresh", "setup-done", "setup-all", "admin-owner"] },
  {
    id: "settings.hub.setup.step",
    route: "#/settings/hub/setup",
    fixtures: ["admin-owner", "setup-fresh"],
    variant: "claude",
    open: async (page) => {
      await page.getByRole("list", { name: "Steps" }).getByRole("button", { name: "Claude" }).click();
      await page.getByRole("article", { name: "Claude" }).waitFor();
    },
  },
  {
    id: "settings.hub.setup.step",
    route: "#/settings/hub/setup",
    fixtures: ["admin-owner"],
    variant: "claude-change",
    open: async (page) => {
      await page.getByRole("list", { name: "Steps" }).getByRole("button", { name: "Claude" }).click();
      await page.getByRole("button", { name: "Change" }).click();
      await page.getByRole("textbox", { name: "API key" }).waitFor();
    },
  },
  {
    id: "settings.hub.setup.step",
    route: "#/settings/hub/setup",
    fixtures: ["admin-owner", "setup-done", "setup-fresh"],
    variant: "github",
    open: async (page) => {
      await page.getByRole("list", { name: "Steps" }).getByRole("button", { name: "GitHub" }).click();
      await page.getByRole("article", { name: "GitHub" }).waitFor();
    },
  },
  {
    id: "settings.hub.setup.step",
    route: "#/settings/hub/setup",
    fixtures: ["setup-fresh"],
    variant: "people",
    open: async (page) => {
      await page.getByRole("list", { name: "Steps" }).getByRole("button", { name: "People" }).click();
      await page.getByRole("article", { name: "People" }).waitFor();
    },
  },
  { id: "settings.hub.denied", route: "#/settings/hub/people", fixtures: ["admin-member", "cloud-people-member"] },
  // People on a fleetd cloud team (fixtures/cloud): the plus invites by email, and who is invited is listed with
  // Revoke; the form open; an invite sent, which says the person gets an email and signs in with it; and one the team
  // refuses (its limit of people), one line by the field. A self-hosted hub's People above is today's.
  { id: "settings.hub.people", route: "#/settings/hub/people", fixtures: ["cloud-people-owner", "cloud-people-admin"], variant: "cloud" },
  {
    id: "settings.hub.people",
    route: "#/settings/hub/people",
    fixtures: ["cloud-people-owner"],
    variant: "cloud-form",
    open: async (page) => {
      await page.getByRole("button", { name: "Invite by email" }).click();
      await page.getByRole("form", { name: "Invite by email" }).waitFor();
    },
  },
  {
    id: "settings.hub.people",
    route: "#/settings/hub/people",
    fixtures: ["cloud-people-owner"],
    variant: "cloud-sent",
    open: async (page) => {
      await page.getByRole("button", { name: "Invite by email" }).click();
      await page.getByRole("textbox", { name: "Email" }).fill("eve@example.com");
      await page.getByRole("button", { name: "Invite", exact: true }).click();
      await page.getByRole("status").filter({ hasText: "Invite sent to eve@example.com" }).waitFor();
    },
  },
  {
    id: "settings.hub.people",
    route: "#/settings/hub/people",
    fixtures: ["cloud-people-limit"],
    variant: "cloud-refused",
    open: async (page) => {
      await page.getByRole("button", { name: "Invite by email" }).click();
      await page.getByRole("textbox", { name: "Email" }).fill("eve@example.com");
      await page.getByRole("button", { name: "Invite", exact: true }).click();
      await page.getByRole("alert").filter({ hasText: "limit of people" }).waitFor();
    },
  },
  // Billing on a fleetd cloud team (fixtures/cloud, the team's answer from src/shared/billing.samples.ts): no plan and
  // no credits, the Team plan with credits and use, a declined card, the cap reached, and the team not answering; then
  // Add credits' menu open. A self-hosted hub has no Billing row (settings.sheet).
  {
    id: "settings.hub.billing",
    route: "#/settings/hub/billing",
    fixtures: ["cloud-billing-none", "cloud-billing-plan", "cloud-billing-failed", "cloud-billing-cap", "cloud-billing-unreachable", "cloud-billing-warned"],
  },
  // Sign-in on a fleetd cloud workspace (fixtures/cloud): Google required with a verified domain joining, and nothing
  // set yet. A self-hosted workspace has no Sign-in row (settings.sheet).
  { id: "settings.hub.signin", route: "#/settings/hub/signin", fixtures: ["cloud-signin-set", "cloud-signin-empty"] },
  // Spend limits (admin/Limits.tsx): each person's spend on People with Bob's limit reached, then his Spend limit… dialog;
  // a bot's limit in its settings; and a member's own in Workspaces & devices.
  { id: "settings.hub.people", route: "#/settings/hub/people", fixtures: ["cloud-people-limits"], variant: "limits" },
  {
    id: "settings.hub.people",
    route: "#/settings/hub/people",
    fixtures: ["cloud-people-limits"],
    variant: "limit-dialog",
    open: async (page) => {
      await page.getByRole("button", { name: "Bob Okafor: more" }).click();
      await page.getByRole("menuitem", { name: "Spend limit…" }).click();
      await page.getByRole("dialog", { name: "Bob Okafor's spend limit" }).waitFor();
    },
  },
  {
    id: "settings.projects",
    route: "#/settings/projects",
    fixtures: ["cloud-limits-bot"],
    variant: "spend-limit",
    open: async (page) => {
      await page.getByRole("navigation", { name: "Settings" }).getByRole("button", { name: "storefront" }).click();
      await page.getByText("Spend limit", { exact: true }).scrollIntoViewIfNeeded();
    },
  },
  { id: "settings.hubs", route: "#/settings/hubs", fixtures: ["cloud-people-member-limit"], variant: "my-limit" },
  // Before fleetd's computers are on for the team there is nothing to buy, so no Billing: no entry in the index, and its
  // link lands on People, never a page that only says so (W759).
  {
    id: "settings.hub.people",
    route: "#/settings/hub/billing",
    fixtures: ["cloud-billing-off"],
    variant: "billing-off",
    check: async (page) => {
      await expect(page).toHaveURL(/#\/settings\/hub\/people/u);
      await expect(page.getByRole("navigation", { name: "Settings" }).getByRole("button", { name: "Billing", exact: true })).toHaveCount(0);
    },
  },
  {
    id: "settings.hub.billing",
    route: "#/settings/hub/billing",
    fixtures: ["cloud-billing-plan"],
    variant: "add-credits",
    open: async (page) => {
      await page.getByRole("button", { name: "Add credits" }).click();
      await page.getByRole("menu").waitFor();
    },
  },
  // No hub and nothing kept from one: connect first, never Loading… for ever.
  { id: "settings.hub.offline", route: "#/settings/hub/people", fixtures: ["hub-unreachable"] },
  // A machine's page, under what is wrong with it: its role, its screens and its max agents, devbox's auto 22 and where it
  // comes from.
  {
    id: "settings.hub.machine",
    route: "#/settings/hub/machines/devbox",
    fixtures: ["settings-machines"],
    variant: "caps",
    open: async (page) => {
      const caps = page.locator('[data-part="hub.caps"]');
      await caps.scrollIntoViewIfNeeded();
      await caps.getByText("Auto: memory 60 GB, about 2 GB an agent.").waitFor();
    },
  },
  // devbox's Screens: no switch per kind (D574), only Android's line, which needs KVM, with its fix to run there; how
  // many at once, and when an idle one ends.
  {
    id: "settings.hub.machine",
    route: "#/settings/hub/machines/devbox",
    fixtures: ["settings-machines"],
    variant: "screens",
    open: async (page) => {
      const screens = page.locator("[data-screens]").first();
      await screens.scrollIntoViewIfNeeded();
      await screens.locator('[data-screens-needs="android"]').waitFor();
      await expect(screens.locator("[data-screens-needs]")).toHaveCount(1);
      await expect(screens.getByRole("switch")).toHaveCount(0);
    },
  },
  // The agents' Mac's page: its switch for agents, no switch per screen kind, and how soon an idle one ends (a hint).
  {
    id: "settings.hub.machine",
    route: "#/settings/hub/machines/buildbox",
    fixtures: ["settings-agents-mac"],
    variant: "agents-mac",
    open: async (page) => {
      const mac = page.locator("[data-screens]");
      await mac.scrollIntoViewIfNeeded();
      await mac.getByRole("region", { name: "At once", exact: true }).waitFor();
      await expect(mac.getByRole("switch")).toHaveCount(0);
      await expect(mac.locator("[data-screens-needs]")).toHaveCount(0);
      // How soon an idle one ends is the hint of its At once row.
      await expect(mac.getByRole("region", { name: "At once", exact: true })).toContainText("An idle Mac screen ends after 5 minutes");
      // How many simulators it runs at once: its default, 2, until a person picks a number.
      await expect(mac.getByRole("region", { name: "iOS simulators at once" }).getByRole("combobox")).toContainText("Default (2)");
    },
  },
  // storefront set to 30 on devbox, which holds it at 22: the line, and for an admin the way to Hub › Machines.
  {
    id: "settings.agents",
    route: "#/settings/agents?for=devbox/dcffccea-c5a7-40a6-940d-7f70239ffa22",
    fixtures: ["settings-machines"],
    variant: "machine-holds",
    open: async (page) => {
      const storefront = page.getByRole("region", { name: "Max agents" });
      await storefront.scrollIntoViewIfNeeded();
      await storefront.getByRole("button", { name: "devbox's max in Workspace › Machines" }).waitFor();
    },
  },
  // A project's allowed profiles: high (the default, always), medium switched on, quick off; and storefront
  // allowing the default alone.
  {
    id: "settings.agents",
    route: "#/settings/agents?for=devbox/dcffccea-c5a7-40a6-940d-7f70239ffa22",
    fixtures: ["settings-agents", "settings-default-profile-only"],
    variant: "profiles",
    open: async (page) => {
      const allowed = page.getByRole("region", { name: "Allowed profiles" });
      await allowed.scrollIntoViewIfNeeded();
      await allowed.getByRole("switch").first().waitFor();
    },
  },
  // A link to one project's Agents opens on that project, whichever the sidebar last showed.
  // A bot's Lead model open: its profiles by provider, and Google's models a lead can start on.
  {
    id: "settings.agents",
    route: "#/settings/agents?for=devbox/dcffccea-c5a7-40a6-940d-7f70239ffa22",
    fixtures: ["settings-agents"],
    variant: "lead-models",
    sizes: ["medium"],
    open: async (page) => {
      const lead = page.getByRole("combobox", { name: "Lead model" });
      await lead.scrollIntoViewIfNeeded();
      await lead.click();
      await page.getByRole("listbox").waitFor();
    },
  },
  {
    id: "settings.agents",
    variant: "for-project",
    route: "#/settings/agents?for=devbox/dcffccea-c5a7-40a6-940d-7f70239ffa22",
    fixtures: ["settings-agents"],
    open: (page) => page.getByRole("slider", { name: "Max agents" }).waitFor(),
  },
  // A slider applies when you let go (keys: once they rest): a project lowered under its running agents, with the
  // pause and Undo; and the whole fleet moved below a project's own max, which warns.
  {
    id: "settings.agents",
    route: "#/settings/agents?for=devbox/dcffccea-c5a7-40a6-940d-7f70239ffa22",
    fixtures: ["settings-agents"],
    variant: "applied",
    open: async (page) => {
      // storefront: 6 running under a max of 12, lowered to 4.
      await page.getByRole("slider", { name: "Max agents" }).focus();
      for (let i = 0; i < 8; i++) await page.keyboard.press("ArrowLeft");
      await page.getByRole("button", { name: "Undo" }).waitFor();
    },
  },
  // A project's own max goes back to the default: storefront's 12 to the fleet's 16, with Undo.
  {
    id: "settings.agents",
    route: "#/settings/agents?for=devbox/dcffccea-c5a7-40a6-940d-7f70239ffa22",
    fixtures: ["settings-agents"],
    variant: "to-default",
    open: async (page) => {
      const storefront = page.getByRole("region", { name: "Max agents" });
      await storefront.getByText("Set for this bot. The default is 16.").waitFor();
      await storefront.getByRole("button", { name: "Use the default" }).click();
      await storefront.getByText("Max agents, the default: 16, was 12.").waitFor();
      await storefront.getByText("Follows the default: the workspace's fleet cap.").waitFor();
    },
  },
  // A fleet cap the CLI set below the machines' total: no slider, a line in the machines' group saying it and how to change it.
  {
    id: "settings.hub.machines",
    route: "#/settings/hub/machines",
    fixtures: ["settings-agents"],
    variant: "fleet-cap",
    open: async (page) => {
      await page.locator("[data-fleet-cap]").scrollIntoViewIfNeeded();
    },
  },
  // General's last group, About: fleetd.sh's privacy policy, terms and support, each opening in the browser.
  {
    id: "settings.general",
    route: "#/settings/general",
    fixtures: ["typical"],
    variant: "about",
    open: (page) => page.locator("[data-legal=support]").scrollIntoViewIfNeeded(),
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
  // Your devices, on You › Hubs & devices (its old link lands there): Sam's own two, then Pair a phone's QR with the
  // address and code under it.
  { id: "settings.devices", route: "#/settings/devices", fixtures: ["admin-owner", "admin-member", "hub-unreachable"] },
  {
    id: "settings.devices",
    route: "#/settings/devices",
    fixtures: ["admin-owner"],
    variant: "pair-a-phone",
    open: async (page) => {
      await page.getByRole("button", { name: "Pair a phone" }).click();
      await expect(page.getByRole("img", { name: "Pairing QR code" })).toBeVisible();
    },
  },
  // Memory: yours (You › Your memory) with what the lead remembered, then one project's MEMORY.md and a topic.
  { id: "settings.your-memory", route: "#/settings/your-memory", fixtures: ["typical", "empty", "hub-unreachable"] },
  { id: "settings.instructions", route: "#/settings/instructions", fixtures: ["typical", "empty", "hub-unreachable"], variant: "memory" },
  { id: "settings.instructions", route: "#/settings/instructions?for=devbox/dcffccea-c5a7-40a6-940d-7f70239ffa22", fixtures: ["typical", "long-text"], variant: "memory-project" },
  // An entry being edited in its card, and a topic open as text.
  {
    id: "settings.instructions",
    route: "#/settings/instructions?for=devbox/dcffccea-c5a7-40a6-940d-7f70239ffa22",
    fixtures: ["typical"],
    variant: "memory-editing",
    open: async (page) => {
      await page.getByRole("button", { name: "Edit “No npm here: use pnpm.”" }).click();
      await page.getByRole("textbox", { name: "Edit the entry in MEMORY.md" }).fill("No npm here: use pnpm, and pin its version.");
      await page.getByRole("region", { name: "deploys", exact: true }).getByRole("button", { name: "Edit as text" }).click();
      await expect(page.getByRole("textbox", { name: "All of deploys.md" })).toBeVisible();
    },
  },
  // A deleted entry, gone from its file, with Undo in the toast.
  {
    id: "settings.your-memory",
    route: "#/settings/your-memory",
    fixtures: ["typical"],
    variant: "memory-deleted",
    open: async (page) => {
      await page.getByRole("button", { name: "Delete “Never estimate time.”" }).click();
      await expect(page.getByRole("button", { name: "Undo" })).toBeVisible();
    },
  },
  // A bot's look (W573, W774): the five shapes over the palette's eleven dots beside its Icon, a green Ghost picked, and
  // the Icon's bot a green ghost.
  {
    id: "settings.projects",
    variant: "bot-color",
    route: "#/settings/projects?for=devbox/dcffccea-c5a7-40a6-940d-7f70239ffa22",
    fixtures: ["sidebar-colors"],
    open: async (page) => {
      const look = page.getByRole("region", { name: "Look" });
      const colors = look.getByRole("radiogroup", { name: "Color" });
      const shapes = look.getByRole("radiogroup", { name: "Shape" });
      await expect(colors.getByRole("radio")).toHaveCount(11);
      await expect(colors.getByRole("radio", { name: "Green" })).toBeChecked();
      await expect(shapes.getByRole("radio")).toHaveCount(5);
      await expect(shapes.getByRole("radio", { name: "Ghost" })).toBeChecked();
      await expect(page.getByRole("region", { name: "Icon" }).locator('[data-bot][data-color="green"][data-shape="ghost"]')).toBeVisible();
    },
  },
  // A project's approvals (W239): the three modes with the checker on, its model and effort, and what ran without asking.
  {
    id: "settings.projects",
    variant: "integrations-approvals",
    route: "#/settings/projects?for=devbox/dcffccea-c5a7-40a6-940d-7f70239ffa22",
    fixtures: ["integrations-approvals"],
    open: async (page) => {
      const part = page.getByRole("region", { name: "Approvals" });
      await expect(part.getByRole("radio", { name: /Checker decides/u })).toBeChecked();
      await expect(page.getByRole("list", { name: "Ran without asking" }).getByRole("listitem")).toHaveCount(4);
      await part.scrollIntoViewIfNeeded();
    },
  },
  // A busy project's log (W601): 400 actions, the page shows the newest five, repeats folded, and Show all.
  {
    id: "settings.projects",
    variant: "integrations-approvals-long",
    route: "#/settings/projects?for=devbox/dcffccea-c5a7-40a6-940d-7f70239ffa22",
    fixtures: ["integrations-approvals-long"],
    open: async (page) => {
      const part = page.getByRole("region", { name: "Ran without asking" });
      await expect(part.getByRole("list", { name: "Ran without asking" }).getByRole("listitem")).toHaveCount(5);
      await expect(part.getByRole("button", { name: "Show all 400" })).toBeVisible();
      await part.scrollIntoViewIfNeeded();
    },
  },
  // ...Show all: the log in a bounded list that reads older pages as it scrolls.
  {
    id: "settings.projects",
    variant: "integrations-approvals-all",
    route: "#/settings/projects?for=devbox/dcffccea-c5a7-40a6-940d-7f70239ffa22",
    fixtures: ["integrations-approvals-long"],
    open: async (page) => {
      const part = page.getByRole("region", { name: "Ran without asking" });
      await part.getByRole("button", { name: "Show all 400" }).click();
      await part.getByRole("button", { name: "Show older" }).click();
      await expect(part.getByRole("button", { name: "Show older" })).toBeEnabled();
      await part.scrollIntoViewIfNeeded();
    },
  },
  // A bot's Computer (W705): its image built, building, failed or not built yet, each with its setup under it; a failed
  // one with its log opened; and two repos, each its own Computer, api's with no commands and so no image row.
  {
    id: "settings.projects",
    variant: "computer",
    route: "#/settings/projects?for=devbox/dcffccea-c5a7-40a6-940d-7f70239ffa22",
    fixtures: ["computer-ready", "computer-building", "computer-failed", "computer-new"],
    open: async (page) => {
      const part = page.getByRole("region", { name: "Computer", exact: true });
      await expect(part.getByRole("region", { name: "Image" })).toBeVisible();
      await expect(part.getByRole("textbox", { name: "Setup commands" })).toHaveValue(/cargo fetch/u);
      await part.scrollIntoViewIfNeeded();
    },
  },
  // Runs on: one pick of provider and exact size; its list open, each choice a real machine.
  {
    id: "settings.projects",
    variant: "computer-runs-on",
    route: "#/settings/projects?for=devbox/dcffccea-c5a7-40a6-940d-7f70239ffa22",
    fixtures: ["computer-runs-on"],
    open: async (page) => {
      const row = page.getByRole("region", { name: "Computer", exact: true }).getByRole("region", { name: "Runs on" });
      const pick = row.getByRole("combobox", { name: "Runs on" });
      await expect(pick).toContainText("fleetd's computers · 4 vCPU / 8 GB");
      await row.scrollIntoViewIfNeeded();
      await pick.click();
      await expect(page.getByRole("option", { name: "fleetd's computers · 16 vCPU / 32 GB" })).toBeVisible();
      await expect(page.getByRole("option", { name: "fleetd's computers · 2 vCPU / 4 GB" })).toBeVisible();
    },
  },
  // ...its pick's provider disconnected: the pick stays, and the row says its agents wait and why.
  {
    id: "settings.projects",
    variant: "computer-runs-on-gone",
    route: "#/settings/projects?for=devbox/dcffccea-c5a7-40a6-940d-7f70239ffa22",
    fixtures: ["computer-runs-on-gone"],
    open: async (page) => {
      const row = page.getByRole("region", { name: "Computer", exact: true }).getByRole("region", { name: "Runs on" });
      await expect(row.getByRole("combobox", { name: "Runs on" })).toContainText("fleetd's computers · 8 vCPU / 16 GB");
      await expect(row).toContainText("Its agents wait: fleetd's computers aren't connected");
      await row.scrollIntoViewIfNeeded();
    },
  },
  // ...on a machine that builds no images: its setup alone, no image row and no Rebuild.
  {
    id: "settings.projects",
    variant: "computer-nowhere",
    route: "#/settings/projects?for=devbox/dcffccea-c5a7-40a6-940d-7f70239ffa22",
    fixtures: ["computer-nowhere"],
    open: async (page) => {
      const part = page.getByRole("region", { name: "Computer", exact: true });
      await expect(part.getByRole("textbox", { name: "Setup commands" })).toHaveValue(/cargo fetch/u);
      await expect(part.getByRole("region", { name: "Image" })).toHaveCount(0);
      await expect(part.getByRole("button", { name: "Rebuild" })).toHaveCount(0);
      await part.scrollIntoViewIfNeeded();
    },
  },
  {
    id: "settings.projects",
    variant: "computer-log",
    route: "#/settings/projects?for=devbox/dcffccea-c5a7-40a6-940d-7f70239ffa22",
    fixtures: ["computer-failed"],
    open: async (page) => {
      const row = page.getByRole("region", { name: "Computer", exact: true }).getByRole("region", { name: "Image" });
      await row.getByRole("button", { name: "Log" }).click();
      await expect(row.getByLabel("Image build log")).toContainText("Could not resolve host");
      await row.scrollIntoViewIfNeeded();
    },
  },
  {
    id: "settings.projects",
    variant: "computer-rebuild",
    route: "#/settings/projects?for=devbox/dcffccea-c5a7-40a6-940d-7f70239ffa22",
    fixtures: ["computer-ready"],
    open: async (page) => {
      const row = page.getByRole("region", { name: "Computer", exact: true }).getByRole("region", { name: "Image" });
      await row.getByRole("button", { name: "Rebuild" }).click();
      await expect(row).toContainText("Building…");
      await expect(row.getByRole("button", { name: "Rebuild" })).toHaveCount(0);
      await row.scrollIntoViewIfNeeded();
    },
  },
  {
    id: "settings.projects",
    variant: "computer-two",
    route: "#/settings/projects?for=devbox/dcffccea-c5a7-40a6-940d-7f70239ffa22",
    fixtures: ["computer-two"],
    open: async (page) => {
      await expect(page.getByRole("region", { name: "Computer: storefront" }).getByRole("region", { name: "Image" })).toBeVisible();
      const api = page.getByRole("region", { name: "Computer: api" });
      await expect(api.getByRole("region", { name: "Image" })).toHaveCount(0);
      await api.scrollIntoViewIfNeeded();
    },
  },
  // Connections (D653), from the sidebar's icon: nothing connected, some connected, and as a member.
  { id: "connections", route: "#/connections", fixtures: ["connections-empty", "connections-some", "connections-member"] },
  {
    id: "connections",
    variant: "from-sidebar",
    route: "#/",
    fixtures: ["connections-some"],
    open: async (page) => {
      await page.getByRole("button", { name: "Connections", exact: true }).click();
      await expect(page.getByRole("list", { name: "Custom MCP" }).getByRole("listitem")).toHaveCount(4);
      await expect(page.getByRole("switch", { name: "sentry on" })).not.toBeChecked();
    },
  },
  // ...a Test that works through Tailscale, on the custom MCP on the tailnet.
  {
    id: "connections",
    variant: "test-tailnet",
    route: "#/connections",
    fixtures: ["connections-some"],
    open: async (page) => {
      const row = page.getByRole("listitem", { name: "docs" });
      await row.getByRole("button", { name: "docs: more" }).click();
      await page.getByRole("menuitem", { name: "Test" }).click();
      await expect(row).toContainText("Works on devbox through Tailscale: 2 tools.");
    },
  },
  // ...a failing Test: why, in one line on its row.
  {
    id: "connections",
    variant: "test-failed",
    route: "#/connections",
    fixtures: ["connections-failing"],
    open: async (page) => {
      const row = page.getByRole("listitem", { name: "github" });
      await row.getByRole("button", { name: "github: more" }).click();
      await page.getByRole("menuitem", { name: "Test" }).click();
      await expect(row.getByRole("alert")).toContainText("401 Bad credentials");
    },
  },
  // ...Bots, a list to tick in a row's menu.
  {
    id: "connections",
    variant: "bots",
    route: "#/connections",
    fixtures: ["connections-some"],
    open: async (page) => {
      await page.getByRole("listitem", { name: "linear" }).getByRole("button", { name: "linear: more" }).click();
      await page.getByRole("menuitem", { name: /Bots/u }).click();
      await expect(page.getByRole("menuitemcheckbox", { name: "Every bot" })).toBeVisible();
    },
  },
  // ...Notion's Connect: saved for the team, its sign-in page open in the browser, the dialog waiting on it; linear
  // signed out by its service, with Sign in on its row.
  {
    id: "connections",
    variant: "oauth",
    route: "#/connections",
    fixtures: ["connections-oauth"],
    open: async (page) => {
      await expect(page.getByRole("listitem", { name: "linear" })).toContainText("mcp.linear.app ended the sign-in");
      await page.getByRole("listitem", { name: "Notion" }).getByRole("button", { name: "Connect" }).click();
      const dialog = page.getByRole("dialog", { name: "Sign in to Notion" });
      await expect(dialog.getByRole("status")).toContainText("Finish signing in on mcp.notion.com");
      await expect(dialog.getByRole("button", { name: "Open the sign-in page again" })).toBeVisible();
    },
  },
  // ...a bot's own server whose service lets no app sign up: the person's own app, with the redirect URL to paste.
  {
    id: "connections",
    variant: "own-client",
    route: "#/connections",
    fixtures: ["integrations-signin"],
    open: async (page) => {
      await page.getByRole("listitem", { name: "calendar" }).getByRole("button", { name: "Sign in" }).click();
      const dialog = page.getByRole("dialog");
      await dialog.getByRole("button", { name: "Sign in" }).click();
      await expect(dialog.getByRole("region", { name: "Redirect URL" })).toContainText("http://devbox:4790/oauth/callback");
    },
  },
  // ...the form as a member: a URL that signs in is theirs to add; headers are off, why in Add header's hover.
  {
    id: "connections",
    variant: "add-member",
    route: "#/connections",
    fixtures: ["connections-member"],
    open: async (page) => {
      await page.getByRole("button", { name: "Add a custom MCP" }).click();
      await page.getByRole("textbox", { name: "URL" }).fill("https://mcp.linear.app/mcp");
      await page.getByRole("button", { name: "Add header" }).hover();
      await expect(page.getByRole("tooltip")).toContainText("An owner or admin adds a command or headers.");
    },
  },
  // ...a custom MCP on the tailnet: added, then tested through Tailscale, with nothing else to set.
  {
    id: "connections",
    variant: "add-tailnet",
    route: "#/connections",
    fixtures: ["connections-tailnet"],
    open: async (page) => {
      await page.getByRole("button", { name: "Add a custom MCP" }).click();
      await page.getByRole("textbox", { name: "URL" }).fill("http://docs.tail4f2e.ts.net:8080/mcp");
      await expect(page.locator("[data-tailnet-line]")).toContainText("reached through Tailscale");
      await page.getByRole("button", { name: "Add and test" }).click();
      await expect(page.locator("[data-result]")).toContainText("Works on devbox through Tailscale: 2 tools, no sign-in needed.");
    },
  },
  // ...the same URL while Tailscale isn't connected: the form says so, with Connect Tailscale.
  {
    id: "connections",
    variant: "add-tailnet-off",
    route: "#/connections",
    fixtures: ["connections-tailnet-off"],
    open: async (page) => {
      await page.getByRole("button", { name: "Add a custom MCP" }).click();
      await page.getByRole("button", { name: "Command" }).click();
      await page.getByRole("button", { name: "URL" }).click();
      await page.getByRole("textbox", { name: "URL" }).fill("http://docs.tail4f2e.ts.net:8080/mcp");
      await page.getByRole("button", { name: "Add header" }).click();
      await expect(page.getByRole("button", { name: "Connect Tailscale" })).toBeVisible();
    },
  },
  // Import memory under it, shut at rest as one row: Import… opens its two steps in place, a ChatGPT export pasted,
  // then what Add to Memory added.
  {
    id: "settings.your-memory",
    route: "#/settings/your-memory",
    fixtures: ["typical"],
    variant: "import-memory",
    open: async (page) => {
      const part = page.locator('[data-part="import-memory"]');
      await part.getByRole("button", { name: "Import…" }).click();
      await part.getByRole("textbox", { name: "The other assistant's answer" }).fill("## Instructions\n[2024-03-02] - Keep answers short and skip the pleasantries.");
      await part.getByRole("button", { name: "Add to Memory" }).click();
      await expect(part.getByText("Added 5 entries to your memory.", { exact: false })).toBeVisible();
      await part.scrollIntoViewIfNeeded();
    },
  },
  // Automations: one project's watchers at the top (Main's CI and one sentence, each with how often, its profile and its
  // cost), then its schedule, webhook and paused automations, a run history with its orders, the editor, and a
  // watcher's runs and the new-watcher editor.
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
    // Edit is in the card's "…", with Pause and Delete.
    open: async (page) => {
      await page.getByRole("region", { name: "Weekday dependency check" }).getByRole("button", { name: "Weekday dependency check: more" }).click();
      await page.getByRole("menuitem", { name: "Edit" }).click();
    },
  },
  {
    id: "settings.automations",
    route: "#/settings/automations?for=devbox/dcffccea-c5a7-40a6-940d-7f70239ffa22",
    fixtures: ["typical"],
    variant: "watcher-runs",
    open: async (page) => {
      await page.getByRole("button", { name: "Main's CI: more" }).click();
      await page.getByRole("menuitem", { name: "Runs" }).click();
    },
  },
  {
    id: "settings.automations",
    route: "#/settings/automations?for=devbox/dcffccea-c5a7-40a6-940d-7f70239ffa22",
    fixtures: ["typical"],
    variant: "new-watcher",
    open: (page) => page.getByRole("button", { name: "New watcher" }).click(),
  },
  // Skills: a project's (the first one, then storefront's): its repo's .agents/skills and .claude/skills, its own (one
  // outranked by the repo's of the same name) and a read-only line naming the hub-wide ones; a project skill open to
  // edit, a repo skill open to read, New and Install. The hub-wide ones are on Every project › Agents.
  { id: "settings.agents", route: "#/settings/agents", fixtures: ["typical", "empty", "hub-unreachable"], variant: "skills" },
  { id: "settings.agents", route: "#/settings/agents?for=devbox/dcffccea-c5a7-40a6-940d-7f70239ffa22", fixtures: ["typical", "long-text"], variant: "skills-project" },
  {
    id: "settings.agents",
    route: "#/settings/agents?for=devbox/dcffccea-c5a7-40a6-940d-7f70239ffa22",
    fixtures: ["typical"],
    variant: "skills-edit",
    open: async (page) => {
      await page.getByRole("button", { name: /^checkout-qa/u }).click();
      await expect(page.getByRole("textbox", { name: "SKILL.md" })).toHaveValue(/name: checkout-qa/u);
    },
  },
  {
    id: "settings.agents",
    route: "#/settings/agents?for=devbox/dcffccea-c5a7-40a6-940d-7f70239ffa22",
    fixtures: ["typical"],
    variant: "skills-repo",
    open: async (page) => {
      await page.getByRole("button", { name: /^triage/u }).click();
      await expect(page.getByRole("textbox", { name: "SKILL.md" })).toHaveValue(/name: triage/u);
    },
  },
  {
    id: "settings.agents",
    route: "#/settings/agents?for=devbox/dcffccea-c5a7-40a6-940d-7f70239ffa22",
    fixtures: ["typical"],
    variant: "skills-new",
    open: async (page) => {
      await page.getByRole("button", { name: "New skill" }).click();
      await page.getByRole("textbox", { name: "Name" }).fill("Release Notes");
    },
  },
  // A member's: the hub-wide line, without the way to Every project an owner or admin gets.
  { id: "settings.agents", route: "#/settings/agents", fixtures: ["admin-member", "admin-owner"], variant: "skills-role" },
  // The built-in prompts before one is picked: the edited ones first, the rest behind their groups, one unfolded.
  { id: "settings.prompts", route: "#/settings/prompts?for=devbox/storefront", fixtures: ["settings-prompts", "many-prompts"], variant: "none" },
  {
    id: "settings.prompts",
    route: "#/settings/prompts?for=devbox/storefront",
    fixtures: ["settings-prompts", "many-prompts"],
    variant: "unfolded",
    open: (page) => page.getByRole("button", { name: "The lead", exact: true }).click(),
  },
  { id: "settings.general", route: "#/settings/general", fixtures: ["typical", "empty", "hub-unreachable"] },
  // A row's hint (W612): at rest the row is its title and its control; with keyboard focus on its switch, what it does
  // shows under the title. A row with no control of its own takes focus on its title: Approvals, a line per choice.
  {
    id: "settings.general",
    route: "#/settings/general",
    fixtures: ["typical"],
    variant: "hint",
    open: async (page) => {
      await expect(page.getByRole("tooltip")).toHaveCount(0);
    },
    check: async (page) => {
      const toggle = page.getByRole("switch", { name: "Tell the workspace when I'm using the app" });
      await toggle.blur();
      await toggle.focus();
      await expect(page.getByRole("tooltip")).toContainText("Never what you type or see.");
    },
  },
  {
    id: "settings.projects",
    variant: "hint-choices",
    route: "#/settings/projects?for=devbox/dcffccea-c5a7-40a6-940d-7f70239ffa22",
    fixtures: ["integrations-approvals"],
    check: async (page) => {
      const part = page.getByRole("region", { name: "Approvals" });
      // A hint leaves when its page scrolls, and the page hears of a scroll a frame or more after it happened. So the
      // scroll that brings the part into view has been heard before the title takes focus: heard after it, it closed
      // the hint the focus had just opened.
      await part.evaluate(
        (el) =>
          new Promise((heard) => {
            const { top } = el.getBoundingClientRect();
            el.scrollIntoView({ block: "center" });
            if (el.getBoundingClientRect().top === top) heard(null);
            else addEventListener("scroll", () => requestAnimationFrame(() => heard(null)), { capture: true, once: true });
          }),
      );
      const title = part.getByText("Approvals", { exact: true }).first();
      await title.blur();
      await title.focus();
      await expect(page.getByRole("tooltip")).toContainText("YOLO: Nothing asks");
    },
  },
  // Your name, an owner's and a member's alike: at rest, while typing a new one, saved on Enter as the hub kept it, and
  // an empty one refused in the hub's words under the row's title.
  { id: "settings.general", route: "#/settings/general", fixtures: ["admin-owner", "admin-member"], variant: "name" },
  {
    id: "settings.general",
    route: "#/settings/general",
    fixtures: ["admin-member"],
    variant: "name-editing",
    open: (page) => page.getByRole("textbox", { name: "Name" }).fill("Bob Okafor Jr."),
  },
  {
    id: "settings.general",
    route: "#/settings/general",
    fixtures: ["admin-member"],
    variant: "name-saved",
    open: async (page) => {
      await page.getByRole("textbox", { name: "Name" }).fill("Bob Okafor Jr.");
      await page.getByRole("textbox", { name: "Name" }).press("Enter");
      await page.getByRole("textbox", { name: "Name" }).and(page.locator(":enabled:not(:focus)")).waitFor();
    },
  },
  {
    id: "settings.general",
    route: "#/settings/general",
    fixtures: ["admin-member"],
    variant: "name-refused",
    open: async (page) => {
      await page.getByRole("textbox", { name: "Name" }).fill("");
      await page.getByRole("textbox", { name: "Name" }).press("Enter");
      await page.getByRole("alert").filter({ hasText: "The name is empty." }).waitFor();
    },
  },
  // Notifications: the kinds, sound, the Dock badge, then the test's two answers: sent (with where to allow fleetd
  // if nothing showed) and a system that shows none.
  { id: "settings.general", route: "#/settings/general", fixtures: ["typical"], variant: "notifications" },
  {
    id: "settings.general",
    route: "#/settings/general",
    fixtures: ["typical"],
    variant: "notifications-test-sent",
    open: async (page, app) => {
      await systemNotifications(app, true);
      await page.getByRole("dialog", { name: "Settings" }).getByRole("button", { name: "Send", exact: true }).click();
      await page.getByRole("status").filter({ hasText: /^Sent\./u }).waitFor();
    },
  },
  {
    id: "settings.general",
    route: "#/settings/general",
    fixtures: ["typical"],
    variant: "notifications-test-unsupported",
    open: async (page, app) => {
      await systemNotifications(app, false);
      await page.getByRole("dialog", { name: "Settings" }).getByRole("button", { name: "Send", exact: true }).click();
      await page.getByRole("status").filter({ hasText: "doesn’t show notifications" }).waitFor();
    },
  },
  {
    id: "settings.prompts",
    route: "#/settings/prompts?prompt=lead.start",
    fixtures: ["settings-prompts", "many-prompts", "long-text", "empty", "hub-unreachable"],
  },
  // A project's own edit, with Reset to the built-in; and its edit of a prompt fleetd no longer sends.
  { id: "settings.prompts", variant: "edited", route: "#/settings/prompts?prompt=task.brief.write&for=devbox/storefront", fixtures: ["settings-prompts"] },
  { id: "settings.prompts", variant: "retired", route: "#/settings/prompts?prompt=router&for=devbox/storefront", fixtures: ["settings-prompts"] },
  // The hub-wide texts open from the foot of Every project's Instructions: their list, and an edit whose built-in text
  // changed since it was made, with both changes to save together.
  { id: "settings.hub.prompts", variant: "none", route: "#/settings/hub/prompts", fixtures: ["settings-prompts"] },
  { id: "settings.hub.prompts", route: "#/settings/hub/prompts?prompt=lead.start", fixtures: ["settings-prompts"] },
  { id: "settings.hub.instructions", variant: "prompts", route: "#/settings/hub/instructions", fixtures: ["settings-prompts"] },
  { id: "settings.instructions", route: "#/settings/instructions?for=devbox/storefront", fixtures: ["settings-prompts", "typical", "empty"] },
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
    route: "#/factory/time/order/W8",
    fixtures: ["typical", "long-text", "many-agents", "time-heavy", "empty"],
  },
  {
    id: "time.breakdown",
    route: "#/factory/time",
    fixtures: ["typical", "long-text", "empty"],
  },
  // With no hub, the breakdown says so in words (time.breakdown.offline): a connection state, not an error page.
  { id: "time.breakdown", route: "#/factory/time", fixtures: ["hub-unreachable"] },
  // The harness waits for the id before `open`, so the insights entry waits for the screen root, then opens the tab.
  {
    id: "time",
    route: "#/factory/time",
    fixtures: ["typical", "long-text", "empty"],
    open: (page) => page.getByRole("tab", { name: "Insights" }).click(),
  },
  // A finding's spans, then one span's transcript with its item marked (the selected fill, no coloured edge).
  {
    id: "time",
    route: "#/factory/time/order/W8",
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

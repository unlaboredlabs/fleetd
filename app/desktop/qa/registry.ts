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

import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, type Page } from "@playwright/test";
import { STEER_SENDS } from "../fixtures/order/steerSends.ts";

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
  "projects-errors",
  "projects-machines",
  // F5: the inbox with the open-asks read refused.
  "inbox-error",
  // F6: the Status view's own states (fixtures/status).
  "status-stale",
  "status-planning",
  "status-legacy",
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
  // E0/F1: the frame (top bar, sidebar) around the default route, and the connection states it shows.
  {
    id: "shell",
    route: "#/",
    fixtures: ["empty", "typical", "many-agents", "long-text", "hub-unreachable", "pairing-failed", "node-too-old"],
  },
  // F10: connecting to a hub. pairing-failed: the form after the hub refused the saved key, with the fix;
  // hub-unreachable: retrying, with the reason and the countdown. #/onboarding?key opens on the key path.
  {
    id: "onboarding",
    route: "#/onboarding",
    fixtures: ["pairing-failed", "hub-unreachable"],
  },
  {
    id: "onboarding.key",
    route: "#/onboarding?key",
    fixtures: ["pairing-failed"],
  },
  // F5: the inbox panel with every ask shape (needs-you), the long-text stress ask, and nothing to answer.
  { id: "inbox", route: "#/board?inbox", fixtures: ["needs-you", "long-text", "empty"] },
  // The answering flow: the first question answered (collapsed to "You chose", with the 10 s Undo) and the approval
  // approved (no undo window: its receipt at once).
  {
    id: "inbox.answered",
    route: "#/board?inbox&ask=A1",
    fixtures: ["needs-you"],
    open: async (page) => {
      await page.keyboard.press("1");
      await page.keyboard.press("Enter");
      const approval = page.getByRole("region", { name: /database migration/u });
      await approval.getByRole("radio", { name: /Approve/u }).click();
      await approval.getByRole("button", { name: /Send answer/u }).click();
      await page.getByText(/The lead has your answer/u).waitFor();
    },
  },
  // The open-asks read refused: the reason, the hub's fix and Retry; the badge is plain "Inbox", not loading.
  { id: "inbox.error", route: "#/board?inbox", fixtures: ["inbox-error"], expect: "error" },
  // F2: the board (#/ and #/board). board.empty, board.list, board.stage and board.finish are its states: the stage
  // and finish fixtures put one order on it mid-run and after every PR merged.
  {
    id: "board",
    route: "#/board",
    fixtures: ["empty", "typical", "long-text", "many-agents", "needs-you", "board-stage", "board-finish"],
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
    fixtures: ["needs-you", "long-text", "empty"],
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
  // values, a hub without the progress model, the skeleton before the first answer, and the link down. needs-you
  // joins once F5's card text passes the raw-text check (it flags share_snapshots / share.example.test today).
  ...(
    [
      ["status.fleet", "#/status"],
      ["status.project", "#/status/project/devbox/storefront"],
      ["status.order", "#/status/order/W14"],
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
  // F3: the order view on the fixtures' one order, W1: fleet, PRs, done-when and the lead's conversation (a wake,
  // markdown, steers and receipts, 20k streamed lines). The empty hub has no W1: its not-found state is expected.
  { id: "order", route: "#/order/W1", fixtures: ["typical", "long-text", "many-agents", "conversation", "conversation-20k", "needs-you"] },
  { id: "order", route: "#/order/W1", fixtures: ["empty"], expect: "error" },
  // Report B5: the idle lead's last message ends as the thread's last message does, never mid-sentence.
  {
    id: "order.lead",
    route: "#/order/W1",
    fixtures: ["long-text", "conversation"],
    open: async (page) => {
      // The route is up once any screen is; the order and its log load after.
      await page.locator('[data-screen="order.lead"]').waitFor({ timeout: 30_000 });
      const lastRow = page.locator('[data-entry="say"], [data-entry="more"]').last();
      const fixture = await page.evaluate(() => (window as unknown as { fleetd: { fixture: string | null } }).fleetd.fixture);
      await expect(lastRow).toContainText(leadMessageEnding(fixture ?? ""), { timeout: 30_000 });
    },
  },
  {
    id: "order.told",
    route: "#/order/W1",
    fixtures: ["conversation", "long-text", "order-told-overrides"],
    open: (page) => page.getByRole("button", { name: "What the lead was told" }).click(),
  },
  {
    id: "order.steer",
    route: "#/order/W1",
    fixtures: ["typical", "many-agents", "long-text"],
    open: async (page) => {
      const fleet = page.getByRole("tab", { name: "Fleet" });
      if ((await fleet.count()) > 0) await fleet.click();
      // A finished order's agents sit under its "Done (n)" fold.
      if ((await page.locator("[data-lane]").count()) === 0) await page.getByRole("button", { name: /^Done \(/ }).click();
      await page.locator("[data-lane]").first().click();
    },
  },
  // F4: steering states. In the log: each receipt stage the hub reports, with a cut reply and a cut stopped command,
  // and a steer waiting on the lead's running step. Sent from the lead's box: refused (not sent, with Resend, Edit
  // and Dismiss), cut off by the link, unanswered, and one still sending. In T12's sheet: its queued and withdrawn
  // steers, and a steer that found no hub, still in the box.
  { id: "order", route: "#/order/W1", fixtures: ["order-steering"] },
  {
    id: "order.lead",
    route: "#/order/W1",
    fixtures: ["order-steering"],
    open: async (page) => {
      const lead = page.getByRole("tab", { name: "Lead" });
      if ((await lead.count()) > 0) await lead.click();
      const box = page.getByRole("textbox", { name: "Steer the lead" });
      for (const text of [STEER_SENDS.refused, STEER_SENDS.cutOff, STEER_SENDS.unanswered, STEER_SENDS.sending]) {
        await box.fill(text);
        await box.press("Enter");
        // The box empties once the hub answers; the last one never does.
        if (text !== STEER_SENDS.sending) await expect(box).toHaveValue("");
      }
      await expect(page.locator('[data-receipt="sending"]')).toHaveCount(1);
    },
  },
  {
    id: "order.steer",
    route: "#/order/W1",
    fixtures: ["order-steering"],
    open: async (page) => {
      const fleet = page.getByRole("tab", { name: "Fleet" });
      if ((await fleet.count()) > 0) await fleet.click();
      // T12 has finished: it sits under the fleet's folded "Done" list.
      const lane = page.locator(`[data-lane="T12"]`);
      if ((await lane.count()) === 0) await page.getByRole("button", { name: /^Done \(/ }).click();
      await lane.click();
      const box = page.getByRole("textbox", { name: "Steer T12" });
      await box.fill(STEER_SENDS.offline);
      await box.press("Enter");
      await expect(page.getByText("Not connected to the hub, so this steer wasn’t sent.")).toBeVisible();
    },
  },
];

// Platform checks that need a screen writer's work before they can pass; the owner turns theirs on when it lands.
export const platformChecks: Record<"appMenu", boolean> = {
  // F1: the macOS app menu, with an Edit menu wired to the text actions.
  appMenu: true,
};

/** The last sentence of order W1's lead's latest message, as the fixture's thread_tail says. */
function leadMessageEnding(fixture: string): string {
  const dir = process.env.QA_FIXTURE_DIR ?? path.join(import.meta.dirname, "..", "fixtures");
  const file = JSON.parse(readFileSync(path.join(dir, `${fixture}.json`), "utf8")) as {
    calls: Array<{ tool: string; input?: Record<string, unknown>; outcome: { ok: boolean; output?: Record<string, unknown> } }>;
  };
  const order = file.calls.find((c) => c.tool === "order_get" && c.input?.["workstreamId"] === "W1")?.outcome.output;
  const thread = (order?.["lead"] as { threadRef?: { threadId: string } } | undefined)?.threadRef?.threadId;
  const tail = file.calls.find((c) => c.tool === "thread_tail" && c.input?.["threadId"] === thread && c.input?.["n"] === 50)?.outcome.output;
  const latest = ((tail?.["thread"] as { latestMessageTail?: string } | undefined)?.latestMessageTail ?? "").trim();
  const ending = latest.split(/(?<=[.!?])\s+/).at(-1) ?? latest;
  // An empty ending would match any row: the fixture must have the lead's message.
  if (ending.length < 10) throw new Error(`${fixture}: no latest lead message for W1 to check against`);
  return ending;
}

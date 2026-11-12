// The Screens page (D305): sessions-preview's hub with screens across the hub, not one project. On storefront: its
// agent at checkout, the one asking for the payouts code, and an agent leased the agents' Mac; on billing (buildbox),
// an agent on a Linux desktop and your own Android emulator with #31's build; your own project Home booking a table in its
// browser; and the recent ones that ended. Each row names the machine it runs on and, while live, its agent's latest
// step, and each live one's picture comes as a screen_thumb while the page shows. Its pages: media/.
import fs from "node:fs";
import path from "node:path";
import { Fixture } from "../kit/fixture.ts";
import { asText, isObject, type JsonObject } from "../kit/json.ts";
import { SESSION } from "./ids.ts";

const STOREFRONT = { machineId: "devbox", projectId: "dcffccea-c5a7-40a6-940d-7f70239ffa22" };
const BILLING = { machineId: "buildbox", projectId: "67be1c66-b1dd-446c-a185-33baa907bb5c" };
const CHECKOUT = { machineId: "devbox", projectId: "7a9a4d2f-7656-4a38-a750-56ac34e9f090" };
const HOME = { machineId: "devbox", projectId: "c1d2e3f4-a5b6-4c7d-8e9f-0a1b2c3d4e5f" };
const MEDIA = path.join(import.meta.dirname, "media");
const b64 = (name: string) => fs.readFileSync(path.join(MEDIA, name)).toString("base64");

/** A step of the agent's as a node's heartbeat carries it (contracts BrowserAction). */
const step = (tool: string, args: JsonObject, at: string): JsonObject => ({ seq: 6, at, offsetMs: 40_000, tool, args, ok: true, durationMs: 120 });

/** The page's own sessions, beside storefront's (ids as the node mints them). */
export const PAGE_SESSION = {
  mac: "B7c1e5a9d3f7b1c5e9a3d7f1b5c9e3a7d",
  desktop: "B2d6f0a4c8e2b6d0f4a8c2e6b0d4f8a2c",
  android: "B9e3c7a1f5d9b3e7c1a5f9d3b7e1c5a9f",
  home: "B4a8e2c6f0b4d8a2e6c0f4b8d2a6e0c4b",
  checkoutEnded: "B6f0b4d8a2e6c0f4b8d2a6e0c4b8f2a6d",
  homeEnded: "B8b2f6d0a4e8c2f6b0d4a8e2c6f0b4d8a",
} as const;

export const screensPage = (preview: Fixture): Fixture => {
  const f = Fixture.from(preview, "sessions-page", "Screens page: live and recent screens across the hub's projects, Home among them, on devbox, buildbox and the agents' Mac.");
  const iso = (agoMs: number) => new Date(Date.parse(f.now) - agoMs).toISOString();
  if (f.state.phase !== "live") throw new Error("sessions-preview's hub isn't live");
  f.state = { ...f.state, features: [...(f.state.features ?? []), "screen_thumbs"] };
  const snapshot = f.snapshot;
  if (snapshot === undefined) throw new Error("sessions-preview has no snapshot");
  // Your own Home beside the projects, and the agents' Mac beside devbox and buildbox.
  const projects = snapshot["projects"];
  if (!Array.isArray(projects)) throw new Error("no projects");
  projects.unshift({
    ...HOME,
    title: "Home",
    workspaceRoot: "/home/dev/projects/home",
    lastActivityAt: iso(60_000),
    threads: { failed: 0, idle: 0, running: 1, waiting: 0 },
    createdBy: { keyId: "k-laptop", name: "laptop" },
  });
  const machines = snapshot["machines"];
  if (!Array.isArray(machines)) throw new Error("no machines");
  machines.push({ boxPubKey: "Qm9vdHN0cmFwTWFjS2V5UGFkZGVkPT0=", lastSeenAt: iso(4_000), machineId: "mac", name: "mac", nodeVersion: "0.0.0", status: "online", tags: [] });

  // storefront: its list as sessions-preview answers it, without the legacy iOS simulator and your own browser, and
  // with an agent on the agents' Mac.
  const answered = f.output("browser_sessions", { projectRef: STOREFRONT });
  if (!isObject(answered) || !Array.isArray(answered["sessions"])) throw new Error("no storefront sessions");
  // Each on devbox, where storefront runs; its agent at checkout last typed the code.
  const typed = step("agent-browser", { command: "agent-browser fill @e12 SAVE10" }, iso(6_000));
  const kept = answered["sessions"]
    .filter((r): r is JsonObject => isObject(r) && ![SESSION.phone, SESSION.mine].includes(asText(r["sessionId"]) as never))
    .map((r) => ({ ...r, machineId: "devbox", ...(asText(r["sessionId"]) === SESSION.checkout && r["state"] === "live" ? { step: typed } : {}) }));
  const row = (project: JsonObject, id: string, thread: string, purpose: string, startedAgoMs: number, more: JsonObject): JsonObject => ({
    sessionId: id,
    projectRef: project,
    threadId: thread,
    purpose,
    state: "live",
    control: "agent",
    startedAt: iso(startedAgoMs),
    ...more,
  });
  const mac = row(STOREFRONT, PAGE_SESSION.mac, "c8a1f2e3-0000-4000-8000-00000000mac1", "Run the cart fix on the iOS simulator and add to cart", 6 * 60_000 + 12_000, {
    kind: "mac",
    taskId: "T12",
    machineId: "mac",
    step: step("agent-device", { command: 'agent-device tap "Add to cart"' }, iso(9_000)),
  });
  const storefront = [mac, ...kept];
  f.drop("browser_sessions", { projectRef: STOREFRONT });
  f.answer("browser_sessions", { projectRef: STOREFRONT }, { ...answered, sessions: storefront, waits: [] });

  // billing on buildbox: an agent on a Linux desktop, and your own Android emulator with #31's build.
  const desktop = row(BILLING, PAGE_SESSION.desktop, "c8a1f2e3-0000-4000-8000-0000000desk1", "Check October’s invoice preview shows the rounding line", 3 * 60_000 + 40_000, {
    kind: "linux_desktop",
    taskId: "T10",
    machineId: "buildbox",
    step: step("desktop", { action: "type", text: "npm run invoice-preview -- --month 2026-10" }, iso(14_000)),
  });
  const android = row(BILLING, PAGE_SESSION.android, "screen-9e3c7a1f5d9b3e7c1a5f9d3b7e1c5a9f", "Android emulator opened by Sam", 11 * 60_000, {
    kind: "android",
    machineId: "buildbox",
    control: "human",
    openedBy: { personId: "p_samsamsa", name: "Sam" },
  });
  f.answer("browser_sessions", { projectRef: BILLING }, { sessions: [desktop, android], waits: [], retention: { retentionDays: 30, maxGbPerProject: 20 } });

  // checkout: one that ended this morning.
  const checkoutEnded = row(CHECKOUT, PAGE_SESSION.checkoutEnded, "c8a1f2e3-0000-4000-8000-0000000chk01", "Confirm the 3-D Secure step loads in the payment sheet", 3 * 3_600_000, {
    state: "recorded",
    machineId: "devbox",
    taskId: "T9",
    endedAt: iso(3 * 3_600_000 - 2 * 60_000 - 14_000),
  });
  f.answer("browser_sessions", { projectRef: CHECKOUT }, { sessions: [checkoutEnded], waits: [], retention: { retentionDays: 30, maxGbPerProject: 20 } });

  // Home: booking a table in its own browser, with its saved sign-ins; and yesterday's train times.
  const booking = row(HOME, PAGE_SESSION.home, "c8a1f2e3-0000-4000-8000-0000000home1", "Book a table for two at Casa Lina on Tuesday", 90_000, {
    machineId: "devbox",
    step: step("agent-browser", { command: "agent-browser click @e21" }, iso(4_000)),
  });
  const train = row(HOME, PAGE_SESSION.homeEnded, "c8a1f2e3-0000-4000-8000-0000000home2", "Find Friday’s last train to Porto", 26 * 3_600_000, {
    state: "recorded",
    machineId: "devbox",
    endedAt: iso(26 * 3_600_000 - 64_000),
  });
  f.answer("browser_sessions", { projectRef: HOME }, { sessions: [booking, train], waits: [], retention: { retentionDays: 30, maxGbPerProject: 20 } });

  // Their pages now, for the view a row opens.
  const frame = (sessionId: string, image: string, width: number, height: number, control: string, url?: string): JsonObject => ({
    sessionId,
    seq: 1,
    jpegB64: b64(image),
    width,
    height,
    control,
    ...(url === undefined ? {} : { url }),
  });
  f.later(0, "browser_frame", frame(PAGE_SESSION.mac, "macDesktop.jpg", 1280, 800, "agent"));
  f.later(0, "browser_frame", frame(PAGE_SESSION.desktop, "linuxDesktop.jpg", 1280, 800, "agent"));
  f.later(0, "browser_frame", frame(PAGE_SESSION.android, "androidInvoices.jpg", 412, 915, "human"));
  f.later(0, "browser_frame", frame(PAGE_SESSION.home, "tableBooking.jpg", 960, 600, "agent", "https://casalina.example.com/reservations"));

  // Each live one's picture, as the hub sends it while the page shows: a frame made small.
  const thumb = (sessionId: string, image: string, width: number, height: number): JsonObject => ({ sessionId, jpegB64: b64(image), width, height, at: iso(3_000) });
  f.later(0, "screen_thumb", thumb(SESSION.checkout, "checkoutApplied.jpg", 960, 600));
  f.later(0, "screen_thumb", thumb(SESSION.payouts, "payCode.jpg", 960, 600));
  f.later(0, "screen_thumb", thumb(PAGE_SESSION.mac, "macDesktop.jpg", 1280, 800));
  f.later(0, "screen_thumb", thumb(PAGE_SESSION.desktop, "linuxDesktop.jpg", 1280, 800));
  f.later(0, "screen_thumb", thumb(PAGE_SESSION.android, "androidInvoices.jpg", 412, 915));
  f.later(0, "screen_thumb", thumb(PAGE_SESSION.home, "tableBooking.jpg", 960, 600));

  // The sidebar's Screens row: six live across the hub, one asking for you.
  f.answer("screens_count", undefined, { live: 6, asking: 1 });

  // The machines' screens: devbox 3 of 8, buildbox 2 of 4, the agents' Mac leased to one agent at a time.
  const check = (host: string, ready: boolean) => ({ host, ready, detail: ready ? "ready" : "not set up here" });
  const machine = (machineId: string, ready: readonly string[], live: number, max: number): JsonObject => ({
    machineId,
    name: machineId,
    online: true,
    roles: ["agents", "sessions"],
    maxSessions: max,
    maxSessionsWhy: "set",
    sessionsLive: live,
    hostsOthers: true,
    hosts: ["browser", "android", "desktop", "mac"].map((h) => check(h, ready.includes(h))),
  });
  f.drop("machine_roles");
  f.answer("machine_roles", undefined, {
    machines: [machine("devbox", ["browser", "android", "desktop"], 3, 8), machine("buildbox", ["browser", "android", "desktop"], 2, 4), machine("mac", ["mac"], 1, 1)],
  });
  return f;
};

// The Screens page's design preview (W399): sessions-preview's hub with screens across the hub, not one project. On
// storefront: its agent at checkout, the one asking for the payouts code, and an agent leased the agents' Mac; on
// billing (buildbox), an agent on a Linux desktop and your own Android emulator with #31's build; your Navi Home
// booking a table in its browser; and the recent ones that ended. Its pages: media/ (macDesktop, linuxDesktop,
// androidInvoices and tableBooking are rendered from app/desktop/web/mocks).
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

/** The page's own sessions, beside storefront's (ids as the node mints them). */
export const PAGE_SESSION = {
  mac: "B7c1e5a9d3f7b1c5e9a3d7f1b5c9e3a7d",
  desktop: "B2d6f0a4c8e2b6d0f4a8c2e6b0d4f8a2c",
  android: "B9e3c7a1f5d9b3e7c1a5f9d3b7e1c5a9f",
  navi: "B4a8e2c6f0b4d8a2e6c0f4b8d2a6e0c4b",
  checkoutEnded: "B6f0b4d8a2e6c0f4b8d2a6e0c4b8f2a6d",
  naviEnded: "B8b2f6d0a4e8c2f6b0d4a8e2c6f0b4d8a",
} as const;

export const screensPage = (preview: Fixture): Fixture => {
  const f = Fixture.from(preview, "sessions-page", "Screens page: live and recent screens across the hub's projects and a Navi, on devbox, buildbox and the agents' Mac.");
  const iso = (agoMs: number) => new Date(Date.parse(f.now) - agoMs).toISOString();
  const snapshot = f.snapshot;
  if (snapshot === undefined) throw new Error("sessions-preview has no snapshot");
  // Your Navi Home beside the projects, and the agents' Mac beside devbox and buildbox.
  const projects = snapshot["projects"];
  if (!Array.isArray(projects)) throw new Error("no projects");
  projects.unshift({
    ...HOME,
    title: "Home",
    workspaceRoot: "/home/dev/.fleetd/navi/home",
    lastActivityAt: iso(60_000),
    threads: { failed: 0, idle: 0, running: 1, waiting: 0 },
    kind: "assistant",
    createdBy: { keyId: "k-laptop", name: "laptop" },
  });
  const machines = snapshot["machines"];
  if (!Array.isArray(machines)) throw new Error("no machines");
  machines.push({ boxPubKey: "Qm9vdHN0cmFwTWFjS2V5UGFkZGVkPT0=", lastSeenAt: iso(4_000), machineId: "mac", name: "mac", nodeVersion: "0.0.0", status: "online", tags: [] });

  // storefront: its list as sessions-preview answers it, without the legacy iOS simulator and your own browser, and
  // with an agent on the agents' Mac.
  const answered = f.output("browser_sessions", { projectRef: STOREFRONT });
  if (!isObject(answered) || !Array.isArray(answered["sessions"])) throw new Error("no storefront sessions");
  const kept = answered["sessions"].filter((r) => isObject(r) && ![SESSION.phone, SESSION.mine].includes(asText(r["sessionId"]) as never));
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
  const mac = row(STOREFRONT, PAGE_SESSION.mac, "c8a1f2e3-0000-4000-8000-00000000mac1", "Run the cart fix on the iOS simulator and add to cart", 6 * 60_000 + 12_000, { kind: "mac", taskId: "T12" });
  const storefront = [mac, ...kept];
  f.drop("browser_sessions", { projectRef: STOREFRONT });
  f.answer("browser_sessions", { projectRef: STOREFRONT }, { ...answered, sessions: storefront, waits: [] });

  // billing on buildbox: an agent on a Linux desktop, and your own Android emulator with #31's build.
  const desktop = row(BILLING, PAGE_SESSION.desktop, "c8a1f2e3-0000-4000-8000-0000000desk1", "Check October’s invoice preview shows the rounding line", 3 * 60_000 + 40_000, { kind: "linux_desktop", taskId: "T10" });
  const android = row(BILLING, PAGE_SESSION.android, "screen-9e3c7a1f5d9b3e7c1a5f9d3b7e1c5a9f", "Android emulator opened by Sam", 11 * 60_000, {
    kind: "android",
    control: "human",
    openedBy: { personId: "p_samsamsa", name: "Sam" },
  });
  f.answer("browser_sessions", { projectRef: BILLING }, { sessions: [desktop, android], waits: [], retention: { retentionDays: 30, maxGbPerProject: 20 } });

  // checkout: one that ended this morning.
  const checkoutEnded = row(CHECKOUT, PAGE_SESSION.checkoutEnded, "c8a1f2e3-0000-4000-8000-0000000chk01", "Confirm the 3-D Secure step loads in the payment sheet", 3 * 3_600_000, {
    state: "recorded",
    taskId: "T9",
    endedAt: iso(3 * 3_600_000 - 2 * 60_000 - 14_000),
  });
  f.answer("browser_sessions", { projectRef: CHECKOUT }, { sessions: [checkoutEnded], waits: [], retention: { retentionDays: 30, maxGbPerProject: 20 } });

  // Home (a Navi): booking a table in its own browser, with its saved sign-ins; and yesterday's train times.
  const navi = row(HOME, PAGE_SESSION.navi, "c8a1f2e3-0000-4000-8000-0000000navi1", "Book a table for two at Casa Lina on Tuesday", 90_000, {});
  const naviEnded = row(HOME, PAGE_SESSION.naviEnded, "c8a1f2e3-0000-4000-8000-0000000navi2", "Find Friday’s last train to Porto", 26 * 3_600_000, {
    state: "recorded",
    endedAt: iso(26 * 3_600_000 - 64_000),
  });
  f.answer("browser_sessions", { projectRef: HOME }, { sessions: [navi, naviEnded], waits: [], retention: { retentionDays: 30, maxGbPerProject: 20 } });

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
  f.later(0, "browser_frame", frame(PAGE_SESSION.navi, "tableBooking.jpg", 960, 600, "agent", "https://casalina.example.com/reservations"));

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
    hosts: ["browser", "android", "ios", "desktop", "mac"].map((h) => check(h, ready.includes(h))),
  });
  f.drop("machine_roles");
  f.answer("machine_roles", undefined, {
    machines: [machine("devbox", ["browser", "android", "desktop"], 3, 8), machine("buildbox", ["browser", "android", "desktop"], 2, 4), machine("mac", ["mac"], 1, 1)],
  });
  return f;
};

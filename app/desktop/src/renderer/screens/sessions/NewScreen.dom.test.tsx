// @vitest-environment happy-dom
// New screen (D239): the Screens tab's button opens the picker; it lists the machines that can host the kind picked,
// opens the screen there and goes to its live view; a full machine waits for a slot, and the wait shows in the list
// with Cancel. An iOS or Android screen takes an open PR's build: the picker follows it in the hub until the screen is
// yours, or says why it failed. The palette's "New screen…" opens the same picker.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDataLayer, type HubApi } from "../../src/data/queries";
import { DataProvider } from "../../src/data/react";
import { AT, event, live, project, snapshot } from "../../src/data/fixtures.test-util";
import { TooltipProvider } from "../../ui/primitives/Tooltip";
import { SessionsPane } from "./SessionsPane";
import { NewScreenHost } from "./NewScreen";
import { commandFor } from "../palette/registry";
import { CallRequest } from "../../../shared/ipc";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const machine = (machineId: string, ready: readonly string[], live = 0) => ({
  machineId,
  name: machineId,
  online: true,
  roles: ["agents", "sessions"],
  maxSessions: 2,
  maxSessionsWhy: "set",
  sessionsLive: live,
  hostsOthers: true,
  hosts: ["browser", "android", "ios", "desktop"].map((host) => ({ host, ready: ready.includes(host), detail: "as tested" })),
});
const MACHINES = [machine("devbox", ["browser", "desktop", "android"]), machine("mac", ["browser", "ios"], 2)];
const pr = (number: number, title: string, state: string) => ({
  repo: "acme/app",
  number,
  url: `https://github.com/acme/app/pull/${String(number)}`,
  title,
  state,
  review: { state: "none", agentVerdicts: 0, blocking: 0 },
  author: { login: "ada" },
  createdAt: AT,
  updatedAt: AT,
});
const PRS = [pr(12, "Swipe to reply", "open"), pr(9, "Old idea", "closed")];
const OPENED = {
  sessionId: "B00000000000000000000000000000001",
  projectRef: project,
  threadId: "screen-1",
  kind: "ios",
  purpose: "iOS simulator opened by Ada",
  state: "live",
  control: "human",
  startedAt: AT,
  openedBy: { personId: "p_adaadaad", name: "Ada" },
};
const WAIT = { waitId: "W1", projectRef: project, kind: "ios", machineId: "mac", since: AT, ahead: 0 };
// An Android screen with #12's build, past its wait from the answer on.
const OPENING = { ...WAIT, waitId: "W2", kind: "android", machineId: "devbox", stage: "starting", threadId: "screen-2", pr: { repo: "acme/app", number: 12 } };
const MINE = { ...OPENED, sessionId: "B00000000000000000000000000000002", threadId: "screen-2", kind: "android" };

let host: HTMLDivElement;
let root: Root | undefined;
let send: Parameters<HubApi["subscribe"]>[0] = () => undefined;
let calls: { tool: string; input: unknown; timeoutMs?: number | undefined }[] = [];
/** screen_open with a PR fails the way the app's IPC does, before the hub. */
let refuse: string | undefined;
let waits: unknown[] = [];
let sessions: unknown[] = [];
/** pr_list fails this many more times. */
let prsFail = 0;
/** screen_open answers without its session, as a hub that answers before it has the session does. */
let forgets = false;
/** What machine_roles, hub_info and people_list answer. */
let machines: unknown[] = MACHINES;
let info: unknown = {};
const PEOPLE = [
  { personId: "p_anaanaan", name: "Ana", role: "owner", createdAt: AT },
  { personId: "p_bobobobo", name: "Bo", role: "member", createdAt: AT },
];

beforeEach(() => {
  vi.stubGlobal("fleetd", { platform: "darwin", fixture: null, hub: { watch: () => Promise.resolve(), input: () => Promise.resolve() } });
  host = document.createElement("div");
  document.body.appendChild(host);
  calls = [];
  refuse = undefined;
  prsFail = 0;
  forgets = false;
  waits = [];
  sessions = [];
  machines = MACHINES;
  info = {};
  window.location.hash = "";
});
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  host.remove();
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

const settle = async () => {
  for (let i = 0; i < 8; i++) await act(() => new Promise((done) => setTimeout(done, 0)));
};
/** An event's reads, which the data layer batches every 100 ms. */
const eventSettle = async () => {
  await act(() => new Promise((done) => setTimeout(done, 150)));
  await settle();
};

const mount = async () => {
  const hub: HubApi = {
    call: (tool, input, options) => {
      calls.push({ tool, input, timeoutMs: options?.timeoutMs });
      if (tool === "screen_open" && refuse !== undefined) return Promise.reject(new Error(refuse));
      if (tool === "browser_sessions") return Promise.resolve({ ok: true, output: { sessions, waits, retention: { retentionDays: 30, maxGbPerProject: 20 } } });
      if (tool === "machine_roles") return Promise.resolve({ ok: true, output: { machines } });
      if (tool === "hub_info") return Promise.resolve({ ok: true, output: info });
      if (tool === "people_list") return Promise.resolve({ ok: true, output: { people: PEOPLE, devices: [], invites: [] } });
      if (tool === "machine_screens_set") {
        machines = MACHINES;
        return Promise.resolve({ ok: true, output: { machine: MACHINES[0], next: "Saved. The node restarts now to apply it." } });
      }
      if (tool === "pr_list") {
        if (prsFail > 0) {
          prsFail -= 1;
          return Promise.resolve({ ok: false, error: { code: "failed", message: "GitHub can’t be reached" } });
        }
        return Promise.resolve({ ok: true, output: { prs: PRS } });
      }
      if (tool === "screen_open" && (input as { pr?: unknown }).pr !== undefined) {
        waits = [OPENING];
        return Promise.resolve({ ok: true, output: { waiting: OPENING } });
      }
      if (tool === "screen_open") {
        const full = (input as { machineId: string }).machineId === "mac" && (input as { kind: string }).kind === "ios";
        if (full) waits = [WAIT];
        else if (forgets) return Promise.resolve({ ok: true, output: {} });
        else sessions = [OPENED];
        return Promise.resolve({ ok: true, output: full ? { waiting: WAIT } : { session: OPENED } });
      }
      if (tool === "screen_end") {
        waits = [];
        return Promise.resolve({ ok: true, output: {} });
      }
      return Promise.resolve({ ok: true, output: tool === "agents_list" ? { at: AT, agents: [] } : {} });
    },
    subscribe: (l) => ((send = l), () => undefined),
    resync: () => Promise.resolve(),
    focus: () => Promise.resolve(),
    chat: () => Promise.resolve(),
  };
  const layer = createDataLayer(hub);
  root = createRoot(host);
  act(() => {
    root?.render(
      <DataProvider layer={layer}>
        <TooltipProvider>
          <SessionsPane project={project} session={null} />
          <NewScreenHost />
        </TooltipProvider>
      </DataProvider>,
    );
  });
  act(() => {
    send(live(["browser_sessions", "screen_open"]));
    send(snapshot(1));
  });
  await settle();
};

const button = (words: string) => [...document.querySelectorAll("button")].find((b) => b.textContent.includes(words));
const picker = () => document.querySelector("[data-screen='sessions.new']");

it("opens a screen on the machine picked, from the Screens tab, and goes to its live view", async () => {
  await mount();
  act(() => button("New screen")?.click());
  await settle();
  expect(picker()).not.toBeNull();
  // A browser by default: both machines can host one.
  const machines = () => [...document.querySelectorAll("[role='radiogroup'] label")].map((l) => l.textContent);
  expect(machines().some((m) => m.startsWith("devbox"))).toBe(true);
  // iOS: only the Mac, full, so the picker offers to wait.
  act(() => button("iOS")?.click());
  await settle();
  expect(machines()).toEqual(["macFull: 2 of 2 screens in use. You can wait for the next one."]);
  expect(button("Wait for a slot")).toBeDefined();
  // The desktop: devbox, with room.
  act(() => button("Linux desktop")?.click());
  await settle();
  act(() => button("Open screen")?.click());
  await settle();
  expect(calls.find((c) => c.tool === "screen_open")?.input).toEqual({
    projectRef: { machineId: project.machineId, projectId: project.projectId },
    kind: "linux_desktop",
    machineId: "devbox",
    wait: false,
  });
  expect(picker()).toBeNull();
  expect(window.location.hash).toContain(OPENED.sessionId);
});

it("opens a screen the hub's answer left out straight into its live view, once the list has it", async () => {
  // A screen of the person's from before, still live: not the one this open made.
  const before = { ...OPENED, sessionId: "B00000000000000000000000000000009", kind: "browser" };
  sessions = [before];
  forgets = true;
  await mount();
  act(() => button("New screen")?.click());
  await settle();
  act(() => button("Open screen")?.click());
  await settle();
  // Still opening: the screen isn't in the list yet.
  expect(picker()).not.toBeNull();
  expect(button("Opening…")).toBeDefined();
  expect(window.location.hash).not.toContain("sessions");
  // Its browser.session event reads the list again, which has it now.
  const made = { ...OPENED, sessionId: "B00000000000000000000000000000003", kind: "browser" };
  sessions = [made, before];
  act(() => send(event(2, "browser.session", { projectRef: project, sessionId: made.sessionId })));
  await eventSettle();
  expect(picker()).toBeNull();
  expect(window.location.hash).toContain(made.sessionId);
});

it("says what is starting once an open is slow, in the footer", async () => {
  forgets = true;
  await mount();
  act(() => button("New screen")?.click());
  await settle();
  act(() => button("Open screen")?.click());
  await settle();
  expect(picker()?.closest("[role='dialog']")?.textContent).not.toContain("Starting the browser…");
  await act(() => new Promise((done) => setTimeout(done, 1_250)));
  expect(document.querySelector("[role='dialog'] [role='status']")?.textContent).toBe("Starting the browser…");
});

it("waits for a slot on a full machine, shows the wait in the list, and cancels it", async () => {
  await mount();
  act(() => button("New screen")?.click());
  await settle();
  act(() => button("iOS")?.click());
  await settle();
  act(() => button("Wait for a slot")?.click());
  await settle();
  expect(calls.find((c) => c.tool === "screen_open")?.input).toMatchObject({ kind: "ios", machineId: "mac", wait: true });
  expect(host.textContent).toContain("iOS simulator on mac");
  expect(host.textContent).toContain("waiting for a free slot · next in line");
  act(() => button("Cancel")?.click());
  await settle();
  expect(calls.find((c) => c.tool === "screen_end")?.input).toEqual({ waitId: "W1" });
  expect(host.textContent).not.toContain("waiting for a free slot");
});

/** Picks `label` in the picker's PR select. */
const pickPr = async (label: string) => {
  const trigger = document.querySelector<HTMLElement>("[aria-label^='PR ']");
  if (trigger === null) throw new Error("no PR picker");
  await act(async () => {
    trigger.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerType: "mouse" }));
    await Promise.resolve();
  });
  await settle();
  const options = [...document.querySelectorAll<HTMLElement>("[role='option']")];
  act(() => options.find((o) => o.textContent === label)?.click());
  await settle();
  return options.map((o) => o.textContent);
};

it("installs an open PR's build into an Android screen, following it until the screen is yours", async () => {
  await mount();
  act(() => button("New screen")?.click());
  await settle();
  act(() => button("Android")?.click());
  await settle();
  expect(document.querySelector("[aria-label='PR build']")?.textContent).toBe("None");
  // Only open PRs.
  expect(await pickPr("#12 Swipe to reply")).toEqual(["None", "#12 Swipe to reply"]);
  expect(picker()?.textContent).toContain("Its newest CI build is installed before you get control.");
  act(() => button("Open screen")?.click());
  await settle();
  const opened = calls.find((c) => c.tool === "screen_open");
  expect(opened?.input).toEqual({
    projectRef: { machineId: project.machineId, projectId: project.projectId },
    kind: "android",
    machineId: "devbox",
    wait: false,
    pr: { repo: "acme/app", number: 12 },
  });
  // The app's calls wait at most 5 minutes (shared/ipc.ts CallRequest): longer is refused before the hub.
  expect(CallRequest.safeParse({ tool: "screen_open", input: {}, timeoutMs: opened?.timeoutMs }).success).toBe(true);
  // It answered at once; the picker follows it as the hub moves it on.
  expect(picker()?.textContent).toContain("Reading #12’s build and starting the screen on devbox…");
  waits = [{ ...OPENING, stage: "installing" }];
  act(() => send(event(2, "screen.wait", { projectRef: project, waitId: "W2", stage: "installing" })));
  await eventSettle();
  expect(picker()?.textContent).toContain("Installing #12’s build on devbox…");
  expect(host.textContent).toContain("installing #12’s build");
  // Yours: the picker goes, and the panel shows its live view.
  waits = [];
  sessions = [MINE];
  act(() => send(event(3, "screen.wait", { projectRef: project, waitId: "W2" })));
  await eventSettle();
  expect(picker()).toBeNull();
  expect(window.location.hash).toContain(MINE.sessionId);
});

it("says why a PR's build didn't open, and clears it when closed", async () => {
  await mount();
  act(() => button("New screen")?.click());
  await settle();
  act(() => button("Android")?.click());
  await settle();
  await pickPr("#12 Swipe to reply");
  act(() => button("Open screen")?.click());
  await settle();
  waits = [{ ...OPENING, stage: "failed", error: "PR #12's build didn't install, so the screen was closed: Failure [INSTALL_FAILED_INVALID_APK]" }];
  act(() => send(event(2, "screen.wait", { projectRef: project, waitId: "W2", stage: "failed" })));
  await eventSettle();
  expect(picker()?.textContent).toContain("It didn’t open.");
  expect(picker()?.textContent).toContain("INSTALL_FAILED_INVALID_APK");
  act(() => button("Close")?.click());
  await settle();
  expect(picker()).toBeNull();
  expect(calls.filter((c) => c.tool === "screen_end").map((c) => c.input)).toEqual([{ waitId: "W2" }]);
});

it("says plainly when the project's PRs can't be read, and reads them again on Retry", async () => {
  prsFail = 10;
  await mount();
  act(() => button("New screen")?.click());
  await settle();
  act(() => button("iOS")?.click());
  await settle();
  await vi.waitFor(() => expect(picker()?.textContent).toContain("The project’s PRs couldn’t be read"), { timeout: 10_000 });
  prsFail = 0;
  act(() => button("Retry")?.click());
  await settle();
  expect(picker()?.textContent).not.toContain("couldn’t be read");
  expect(picker()?.textContent).toContain("Optional: an open PR whose CI build to install.");
});

it("says so when the call fails before the hub, and can be tried again", async () => {
  await mount();
  refuse = "call: invalid request.";
  act(() => button("New screen")?.click());
  await settle();
  act(() => button("Android")?.click());
  await settle();
  act(() => button("Open screen")?.click());
  await settle();
  expect(picker()?.textContent).toContain("call: invalid request.");
  expect(button("Open screen")?.disabled).toBe(false);
});

it("offers New screen… in the palette for the project on screen", async () => {
  await mount();
  window.location.hash = `#/project/${project.machineId}/${project.projectId}`;
  const command = commandFor("screen.new");
  expect(command?.enabled?.()).toBe(true);
  act(() => command?.run());
  await settle();
  expect(picker()).not.toBeNull();
});

/** devbox with Android switched off in its node.json, and a node that takes screen settings from the hub. */
const ANDROID_OFF = [
  {
    ...machine("devbox", ["browser", "desktop"]),
    screenSettings: true,
    hosts: ["browser", "android", "ios", "desktop"].map((host) =>
      host === "android"
        ? { host, ready: false, detail: "Android screens are off in node.json", off: "off", on: false }
        : host === "ios"
          ? { host, ready: false, detail: "iOS simulators need macOS", off: "unsupported", on: false }
          : { host, ready: true, detail: "as tested", on: true },
    ),
  },
];

it("says why a kind can't open, and an admin turns it on from there", async () => {
  machines = ANDROID_OFF;
  await mount();
  act(() => button("New screen")?.click());
  await settle();
  // Each kind that can't open says so in its tile, and stays pickable.
  const tile = (name: string) => button(name);
  expect(tile("Android")?.textContent).toContain("Turned off");
  expect(tile("iOS")?.textContent).toContain("Needs a Mac");
  expect(tile("Android")?.disabled).toBe(false);
  act(() => tile("iOS")?.click());
  await settle();
  expect(document.querySelector("[data-off-reason]")?.textContent).toContain("iOS simulators need a Mac with Xcode");
  expect(button("Add machine")).toBeDefined();
  act(() => tile("Android")?.click());
  await settle();
  expect(document.querySelector("[data-off-reason='turn_on']")?.textContent).toContain("Android emulators are turned off on devbox.");
  expect(button("Open screen")?.disabled).toBe(true);
  act(() => button("Turn on")?.click());
  await settle();
  expect(calls.find((c) => c.tool === "machine_screens_set")?.input).toEqual({ machineId: "devbox", host: "android", on: true });
  // The machines are read again: devbox hosts Android now, so the picker lists it.
  await eventSettle();
  const listed = [...document.querySelectorAll("[role='radiogroup'] label")].map((l) => l.textContent);
  expect(listed.some((m) => m.startsWith("devbox"))).toBe(true);
});

it("tells a member who to ask, with no button", async () => {
  machines = ANDROID_OFF;
  info = { admin: false, me: PEOPLE[1] };
  await mount();
  act(() => button("New screen")?.click());
  await settle();
  act(() => button("Android")?.click());
  await settle();
  const reason = document.querySelector("[data-off-reason='turn_on']");
  expect(reason?.textContent).toContain("Android emulators are turned off on devbox.");
  expect(reason?.textContent).toContain("Ask Ana to turn them on in Settings › Hub › Machines.");
  expect(button("Turn on")).toBeUndefined();
});

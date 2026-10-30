// @vitest-environment happy-dom
// New screen (D239): the Screens tab's button opens the picker; it lists the machines that can host the kind picked,
// opens the screen there and goes to its live view; a full machine waits for a slot, and the wait shows in the list
// with Cancel. The palette's "New screen…" opens the same picker.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDataLayer, type HubApi } from "../../src/data/queries";
import { DataProvider } from "../../src/data/react";
import { AT, live, project, snapshot } from "../../src/data/fixtures.test-util";
import { TooltipProvider } from "../../ui/primitives/Tooltip";
import { SessionsPane } from "./SessionsPane";
import { NewScreenHost } from "./NewScreen";
import { commandFor } from "../palette/registry";

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
const MACHINES = [machine("devbox", ["browser", "desktop"]), machine("mac", ["browser", "ios"], 2)];
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

let host: HTMLDivElement;
let root: Root | undefined;
let send: Parameters<HubApi["subscribe"]>[0] = () => undefined;
let calls: { tool: string; input: unknown }[] = [];
let waits: unknown[] = [];
let sessions: unknown[] = [];

beforeEach(() => {
  vi.stubGlobal("fleetd", { platform: "darwin", fixture: null, hub: { watch: () => Promise.resolve(), input: () => Promise.resolve() } });
  host = document.createElement("div");
  document.body.appendChild(host);
  calls = [];
  waits = [];
  sessions = [];
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

const mount = async () => {
  const hub: HubApi = {
    call: (tool, input) => {
      calls.push({ tool, input });
      if (tool === "browser_sessions") return Promise.resolve({ ok: true, output: { sessions, waits, retention: { retentionDays: 30, maxGbPerProject: 20 } } });
      if (tool === "machine_roles") return Promise.resolve({ ok: true, output: { machines: MACHINES } });
      if (tool === "screen_open") {
        const full = (input as { machineId: string }).machineId === "mac" && (input as { kind: string }).kind === "ios";
        if (full) waits = [WAIT];
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

it("offers New screen… in the palette for the project on screen", async () => {
  await mount();
  window.location.hash = `#/project/${project.machineId}/${project.projectId}`;
  const command = commandFor("screen.new");
  expect(command?.enabled?.()).toBe(true);
  act(() => command?.run());
  await settle();
  expect(picker()).not.toBeNull();
});

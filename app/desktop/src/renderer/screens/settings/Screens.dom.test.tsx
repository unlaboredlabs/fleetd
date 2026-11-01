// @vitest-environment happy-dom
// Hub › Machines › Screens: each machine that hosts screens with a switch per kind, its line from the machine's node,
// its idle timeout, and the hub's recording retention. A switch goes out as machine_screens_set and the node's answer
// shows under the row; a machine whose node can't take it can't be switched from here.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { MachineRolesEntry } from "../../../shared/contracts";
import type { HubFrame } from "../../../shared/hub";
import { createDataLayer, type HubApi } from "../../src/data/queries";
import { DataProvider } from "../../src/data/react";
import { UiProvider } from "../../ui";
import { Screens } from "./Screens";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.hoisted(() => {
  (globalThis as { fleetd?: unknown }).fleetd = { platform: "linux" };
});

const AT = "2026-10-26T10:00:00.000Z";

const devbox: MachineRolesEntry = {
  machineId: "devbox",
  name: "devbox",
  online: true,
  roles: ["agents", "sessions"],
  maxSessions: 4,
  maxSessionsWhy: "auto: 8 CPUs, 16 GB",
  sessionsLive: 1,
  hostsOthers: true,
  screenSettings: true,
  hosts: [
    { host: "browser", ready: true, detail: "Chrome at /usr/bin/google-chrome", on: true, idleMinutes: 30 },
    { host: "android", ready: false, detail: "Android screens are off in node.json", off: "off", on: false, idleMinutes: 30 },
    { host: "ios", ready: false, detail: "iOS simulators need macOS", off: "unsupported", on: false, idleMinutes: 30 },
    { host: "desktop", ready: true, detail: "Xvfb at /usr/bin/Xvfb", on: true, idleMinutes: 30 },
  ],
};
// A Mac on an older fleetd: what it hosts shows, but its switches don't move from here.
const mac1: MachineRolesEntry = {
  ...devbox,
  machineId: "mac1",
  name: "mac1",
  roles: ["sessions"],
  screenSettings: false,
  nodeRestart: "launchctl kickstart -k gui/501/sh.fleetd.node",
  hosts: [{ host: "ios", ready: true, detail: "Xcode with 6 iOS simulators" }],
};
const agentsOnly: MachineRolesEntry = { ...devbox, machineId: "builder", name: "builder", roles: ["agents"] };

const machine = (id: string) => ({ machineId: id, name: id, nodeVersion: "1", status: "online" as const, lastSeenAt: AT, tags: [] });

let host: HTMLDivElement;
let root: Root;
let calls: Array<{ tool: string; input: unknown }>;
/** What machine_roles answers now. */
let listed: MachineRolesEntry[];
let send: (frame: HubFrame) => void;

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  calls = [];
  listed = [devbox, mac1, agentsOnly];
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  document.body.innerHTML = "";
});

const settle = () => act(async () => new Promise((r) => setTimeout(r, 0)));

const render = async () => {
  let listener: (frame: HubFrame) => void = () => undefined;
  const hub: HubApi = {
    call: (tool, input) => {
      calls.push({ tool, input });
      const output =
        tool === "machine_roles"
          ? { machines: listed, retention: { retentionDays: 30, maxGbPerProject: 20 } }
          : tool === "machine_screens_set"
            ? { machine: devbox, next: "Saved. It applies once the screen live here ends, when the node restarts." }
            : {};
      return Promise.resolve({ ok: true, output });
    },
    subscribe: (l) => ((listener = l), () => undefined),
    resync: () => Promise.resolve(),
    focus: () => Promise.resolve(),
    chat: () => Promise.resolve(),
  };
  await act(async () => {
    root.render(
      <UiProvider>
        <DataProvider layer={createDataLayer(hub)}>
          <Screens />
        </DataProvider>
      </UiProvider>,
    );
    await Promise.resolve();
  });
  await act(async () => {
    listener({ t: "state", state: { phase: "live", hub: "devbox:4710", protocol: 1 } });
    listener({ t: "snapshot", snapshot: { cursor: 1, attention: [], machines: [machine("devbox"), machine("mac1")], projects: [] } });
    await new Promise((r) => setTimeout(r, 0));
  });
  send = listener;
  await settle();
};

const row = (m: string) => host.querySelector<HTMLElement>(`[data-screens="${m}"]`);
const toggle = (within: HTMLElement | null, label: string) => within?.querySelector<HTMLButtonElement>(`button[role="switch"][aria-label^="${label} screens"]`);

it("lists each machine that hosts screens with a switch per kind and what its node says", async () => {
  await render();
  expect(row("builder")).toBeNull();
  const box = row("devbox");
  expect(toggle(box, "Browser")?.getAttribute("aria-checked")).toBe("true");
  expect(toggle(box, "Android")?.getAttribute("aria-checked")).toBe("false");
  expect(toggle(box, "Android")?.disabled).toBe(false);
  expect(box?.textContent).toContain("Ready");
  // iOS can't run on Linux: its switch doesn't move, and says why.
  expect(toggle(box, "iOS")?.disabled).toBe(true);
  expect(box?.textContent).toContain("iOS simulators need macOS");
  expect(box?.textContent).toContain("Idle screens end after");
  // An older node: what it hosts shows, and why it can't be switched from here.
  expect(toggle(row("mac1"), "iOS")?.getAttribute("aria-checked")).toBe("true");
  expect(toggle(row("mac1"), "iOS")?.disabled).toBe(true);
  expect(row("mac1")?.textContent).toContain("mac1's fleetd is too old to change these from here: press Update under Updates below.");
  // And if an update didn't restart it: the command, to copy, and where to run it.
  expect(row("mac1")?.textContent).toContain("run this on mac1");
  expect(row("mac1")?.textContent).toContain("launchctl kickstart -k gui/501/sh.fleetd.node");
  expect([...(row("mac1")?.querySelectorAll("button") ?? [])].some((b) => b.textContent === "Copy")).toBe(true);
  expect(row("devbox")?.textContent).not.toContain("too old");
  expect(host.querySelector("[data-screens-retention]")?.textContent).toContain("30 days");
});

// The person updated: the hub read the machines while devbox's node was restarting onto the new build (the machine
// still online), and the node linked again with no status change. It never reads as too old, and its switches come
// back once machine.linked says the node is back.
it("a node restarting after an update is not too old, and its switches come back once it links again", async () => {
  listed = [{ ...devbox, screenSettings: undefined }];
  await render();
  expect(row("devbox")?.textContent).not.toContain("too old");
  expect(row("devbox")?.textContent).toContain("devbox's node is restarting: these come back once it links again.");
  expect(toggle(row("devbox"), "Android")?.disabled).toBe(true);

  listed = [devbox];
  await act(async () => {
    send({ t: "event", event: { seq: 2, at: AT, type: "machine.linked", machineId: "devbox", summary: "devbox's node linked again, on fleetd 2", data: { nodeVersion: "2" } } });
    await new Promise((r) => setTimeout(r, 300));
  });
  for (let i = 0; i < 3; i++) await settle();
  expect(row("devbox")?.textContent).not.toContain("restarting");
  expect(toggle(row("devbox"), "Android")?.disabled).toBe(false);
});

it("turns a kind on with machine_screens_set and shows the node's answer", async () => {
  await render();
  await act(async () => {
    toggle(row("devbox"), "Android")?.click();
    await Promise.resolve();
  });
  await settle();
  expect(calls.find((c) => c.tool === "machine_screens_set")?.input).toEqual({ machineId: "devbox", host: "android", on: true });
  expect(row("devbox")?.textContent).toContain("It applies once the screen live here ends, when the node restarts.");
});

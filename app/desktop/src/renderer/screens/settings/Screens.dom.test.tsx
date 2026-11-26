// @vitest-environment happy-dom
// A machine's Screens, on its page in Hub › Machines: no switch per kind (D574), only a line for a kind that needs
// someone, with the command that fixes it; how many it hosts at once and when an idle one ends (said, not picked); and
// the hub's recording retention, in days only.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { MachineRolesEntry } from "../../../shared/contracts";
import type { HubFrame } from "../../../shared/hub";
import { createDataLayer, type HubApi } from "../../src/data/queries";
import { DataProvider, useToolQuery } from "../../src/data/react";
import { UiProvider } from "../../ui";
import { resetServes } from "../admin/role";
import { MachineScreens, Recordings } from "./Screens";

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
  hosts: [
    { host: "browser", ready: true, detail: "Chrome at /usr/bin/google-chrome", idleMinutes: 30 },
    { host: "android", ready: false, detail: "Installing the Android emulator for screens", off: "installing", idleMinutes: 30 },
    { host: "desktop", ready: true, detail: "Xvfb at /usr/bin/Xvfb", idleMinutes: 30 },
    { host: "mac", ready: false, detail: "the Mac screen is the agents' Mac's own", off: "unsupported", idleMinutes: 5 },
  ],
};
// A machine on an older fleetd, whose node.json turned Android off: on once it is updated.
const mac1: MachineRolesEntry = {
  ...devbox,
  machineId: "mac1",
  name: "mac1",
  roles: ["sessions"],
  hosts: [
    { host: "browser", ready: true, detail: "Chrome at /Applications/Google Chrome.app" },
    { host: "android", ready: false, detail: "Android screens are off in node.json", off: "off" },
  ],
};
// A Linux box with no Xvfb: its node says what installs it.
const lab: MachineRolesEntry = {
  ...devbox,
  machineId: "lab",
  name: "lab",
  hosts: [
    { host: "browser", ready: true, detail: "Chrome at /usr/bin/google-chrome", idleMinutes: 30 },
    { host: "desktop", ready: false, detail: "no docker, podman or Xvfb", off: "missing", idleMinutes: 30, fix: "sudo apt-get install -y xvfb" },
  ],
};
const agentsOnly: MachineRolesEntry = { ...devbox, machineId: "builder", name: "builder", roles: ["agents"] };

const machine = (id: string) => ({ machineId: id, name: id, nodeVersion: "1", status: "online" as const, lastSeenAt: AT, tags: [] });

/** Each machine's Screens where its page shows them (it hosts screens, or is the agents' Mac), then Recordings. */
function Pages() {
  const machines = useToolQuery("machine_roles", {}).data?.machines ?? [];
  return (
    <>
      {machines.filter((m) => m.mac !== undefined || m.roles.includes("sessions")).map((m) => <MachineScreens key={m.machineId} machine={m} />)}
      <Recordings />
    </>
  );
}

let host: HTMLDivElement;
let root: Root;
let calls: Array<{ tool: string; input: unknown }>;
/** What machine_roles answers now. */
let listed: MachineRolesEntry[];
/** Whether machine_roles says how long recordings are kept (a hub from before it doesn't). */
let withRetention: boolean;
/** What hub_info says the hub leaves out: fleetd cloud leaves its own update out. */
let leftOut: string[] | undefined;

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  calls = [];
  listed = [devbox, mac1, lab, agentsOnly];
  withRetention = true;
  leftOut = undefined;
  resetServes();
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
          ? { machines: listed, ...(withRetention ? { retention: { retentionDays: 30, maxGbPerProject: 20 } } : {}) }
          : tool === "hub_info"
            ? { version: "0.9.0", protocol: 1, busy: [], admin: true, ...(leftOut === undefined ? {} : { leftOut }) }
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
          <Pages />
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
  await settle();
};

const row = (m: string) => host.querySelector<HTMLElement>(`[data-screens="${m}"]`);
const needs = (within: HTMLElement | null) => [...(within?.querySelectorAll<HTMLElement>("[data-screens-needs]") ?? [])].map((r) => r.dataset.screensNeeds);

it("lists each machine that hosts screens with no switch per kind, and nothing more while none needs someone", async () => {
  await render();
  expect(row("builder")).toBeNull();
  const box = row("devbox");
  expect(host.querySelector('button[role="switch"]')).toBeNull();
  // Ready, installing, or a kind it can't run at all (the agents' Mac on Linux): nothing at rest.
  expect(needs(box)).toEqual([]);
  for (const word of ["Browser", "Android", "Linux desktop", "Agents’ Mac", "Not known yet", "Ready"]) expect(box?.textContent).not.toContain(word);
  // Online: nothing about being offline.
  expect(box?.textContent).not.toContain("is offline");
  // The screens open now beside the limit; where the limit comes from is the row's hover.
  expect(box?.textContent).toContain("1 open");
  expect([...(box?.querySelectorAll("[data-hint]") ?? [])].some((h) => h.textContent.includes("(auto: 8 CPUs, 16 GB)"))).toBe(true);
  // One idle timeout, said rather than picked.
  expect(box?.textContent).toContain("An idle screen ends after 30 minutes.");
  expect(box?.querySelector("[aria-label^='Idle timeout']")).toBeNull();
  // Recordings keep only a number of days; the size limit stays the hub's safety net.
  expect(host.querySelector("[data-screens-retention]")?.textContent).toContain("30 days");
  // It lines up with What runs where's other rows, which have no state mark: no empty mark slot pushes it in.
  expect(host.querySelector("[data-screens-retention] [data-mark]")).toBeNull();
  expect(host.querySelector("[aria-label='Recordings per bot, at most']")).toBeNull();
});

it("tells a hub without recordings' retention to update only when it is updated from here, never fleetd cloud", async () => {
  withRetention = false;
  await render();
  expect(host.textContent).toContain("Update the workspace's fleetd to change this here.");
  act(() => root.unmount());
  root = createRoot(host);
  leftOut = ["hub_update", "hub_restart"];
  resetServes();
  await render();
  await settle();
  expect(host.textContent).not.toContain("Update the workspace's fleetd");
  expect(host.querySelector("[data-screens-retention]")).toBeNull();
});

it("shows what a kind that can't run is missing as the command to run on that machine", async () => {
  await render();
  const box = row("lab");
  expect(needs(box)).toEqual(["desktop"]);
  expect(box?.textContent).toContain("No docker, podman or Xvfb.");
  expect(box?.querySelector("dt")?.textContent).toBe("Run on lab, for Linux desktop");
  expect(box?.querySelector("dd [data-text='code']")?.textContent).toBe("sudo apt-get install -y xvfb");
  expect(box?.querySelector("button[aria-label^='Copy']")).not.toBeNull();
  expect(row("devbox")?.querySelector("dt")).toBeNull();
});

it("says a kind an older node turned off comes on with its update, and nothing of the rest", async () => {
  await render();
  const box = row("mac1");
  expect(needs(box)).toEqual(["android"]);
  expect(box?.textContent).toContain("Off until mac1’s fleetd is updated.");
  expect(box?.querySelector('button[role="switch"]')).toBeNull();
});

it("says nothing of an offline machine's kinds: its own note says it is offline", async () => {
  listed = [{ ...lab, online: false }];
  await render();
  expect(needs(row("lab"))).toEqual([]);
});

// The agents' Mac offers only its own screen: an older node of it still reports a browser, an emulator and a desktop,
// and none of them shows, nor an idle timeout to pick, as its screen ends after its own few idle minutes.
it("the agents' Mac says only of its own screen", async () => {
  const agentsMac: MachineRolesEntry = {
    ...devbox,
    machineId: "studio",
    name: "studio",
    roles: ["sessions"],
    mac: { on: true, ready: false },
    hosts: [
      { host: "browser", ready: false, detail: "node.json names Chrome at /nowhere, which is not there", off: "missing", idleMinutes: 30 },
      { host: "desktop", ready: false, detail: "desktop screens run on Linux (docker or Xvfb)", off: "unsupported", idleMinutes: 30 },
      { host: "mac", ready: false, detail: "fleetd needs Screen Recording", off: "missing", fix: "open 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture'", idleMinutes: 5 },
    ],
  };
  listed = [devbox, agentsMac];
  await render();
  const mac = row("studio");
  expect(needs(mac)).toEqual(["mac"]);
  expect(mac?.querySelector("dt")?.textContent).toBe("Run on studio, for Agents’ Mac");
  expect(mac?.textContent).not.toContain("An idle screen ends");
  expect(mac?.textContent).toContain("An idle Mac screen ends after 5 minutes, so the next agent gets it.");
  expect(mac?.textContent).not.toContain("Chrome");
});

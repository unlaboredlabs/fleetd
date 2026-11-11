// @vitest-environment happy-dom
// A machine's Screens, on its page in Hub › Machines: a switch per kind, its line from the machine's node, how many it
// hosts at once and when an idle one ends (said, not picked); and the hub's recording retention, in days only. A
// switch goes out as machine_screens_set and the node's answer shows under it; a machine whose node can't take it
// can't be switched from here.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { MachineRolesEntry } from "../../../shared/contracts";
import type { HubFrame } from "../../../shared/hub";
import { createDataLayer, type HubApi } from "../../src/data/queries";
import { DataProvider, useToolQuery } from "../../src/data/react";
import { UiProvider } from "../../ui";
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
  screenSettings: true,
  hosts: [
    { host: "browser", ready: true, detail: "Chrome at /usr/bin/google-chrome", on: true, idleMinutes: 30 },
    { host: "android", ready: false, detail: "Android screens are off in node.json", off: "off", on: false, idleMinutes: 30 },
    { host: "desktop", ready: true, detail: "Xvfb at /usr/bin/Xvfb", on: true, idleMinutes: 30 },
    { host: "mac", ready: false, detail: "the Mac screen is a Mac's own: its agents session's screen", off: "unsupported", on: false, idleMinutes: 5 },
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
  hosts: [{ host: "mac", ready: true, detail: "the agents session is on the Mac's screen" }],
};
// A Linux box with no Xvfb: its node says what installs it.
const lab: MachineRolesEntry = {
  ...devbox,
  machineId: "lab",
  name: "lab",
  hosts: [
    { host: "browser", ready: true, detail: "Chrome at /usr/bin/google-chrome", on: true, idleMinutes: 30 },
    { host: "desktop", ready: false, detail: "no docker, podman or Xvfb", off: "missing", on: true, idleMinutes: 30, fix: "sudo apt-get install -y xvfb" },
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
let send: (frame: HubFrame) => void;

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  calls = [];
  listed = [devbox, mac1, lab, agentsOnly];
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
  // No iOS switch (D298); the agents' Mac can't run on Linux: its switch doesn't move, and says why and how to get one.
  expect(toggle(box, "iOS")).toBeNull();
  expect(toggle(box, "Agents’ Mac")?.disabled).toBe(true);
  expect(box?.textContent).toContain("Only a Mac has this screen. Add one from Machines: the plus, then A Mac for agents.");
  expect(box?.textContent).not.toContain("the Mac screen is a Mac's own");
  // Online: nothing about being offline.
  expect(box?.textContent).not.toContain("is offline");
  expect(box?.textContent).toContain("1 of 4 screens now (auto: 8 CPUs, 16 GB)");
  // One idle timeout, said rather than picked.
  expect(box?.textContent).toContain("An idle screen ends after 30 minutes.");
  expect(box?.querySelector("[aria-label^='Idle timeout']")).toBeNull();
  // An older node: what it hosts shows, and why it can't be switched from here.
  expect(toggle(row("mac1"), "Agents’ Mac")?.getAttribute("aria-checked")).toBe("true");
  expect(toggle(row("mac1"), "Agents’ Mac")?.disabled).toBe(true);
  expect(row("mac1")?.textContent).toContain("Update mac1's fleetd to change these.");
  expect([...(row("mac1")?.querySelectorAll("button") ?? [])].some((b) => b.textContent === "Open Updates")).toBe(true);
  // And if an update didn't restart it: the command, to copy, and where to run it.
  expect(row("mac1")?.textContent).toContain("Still the same after updating? Run this on mac1:");
  expect(row("mac1")?.textContent).toContain("launchctl kickstart -k gui/501/sh.fleetd.node");
  expect([...(row("mac1")?.querySelectorAll("button") ?? [])].some((b) => b.textContent === "Copy")).toBe(true);
  expect(row("devbox")?.textContent).not.toContain("Update devbox");
  // Recordings keep only a number of days; the size limit stays the hub's safety net.
  expect(host.querySelector("[data-screens-retention]")?.textContent).toContain("30 days");
  expect(host.querySelector("[aria-label='Recordings per project, at most']")).toBeNull();
});

it("says once that an offline machine's switches wait for it, not on every row", async () => {
  listed = [{ ...devbox, online: false }];
  await render();
  const box = row("devbox");
  expect((box?.textContent ?? "").split("devbox is offline: these change once it's back.")).toHaveLength(2);
  expect(box?.textContent).not.toContain("Offline");
  for (const kind of ["Browser", "Android"]) expect(toggle(box, kind)?.disabled).toBe(true);
});

// The person updated: the hub read the machines while devbox's node was restarting onto the new build (the machine
// still online), and the node linked again with no status change. It never reads as too old, and its switches come
// back once machine.linked says the node is back.
it("a node restarting after an update is not too old, and its switches come back once it links again", async () => {
  const { screenSettings: _, ...restarting } = devbox;
  listed = [restarting];
  await render();
  expect(row("devbox")?.textContent).not.toContain("Update devbox");
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

it("shows what a kind that can't run is missing as the command to run on that machine", async () => {
  await render();
  const box = row("lab");
  expect(box?.querySelector("dt")?.textContent).toBe("Run on lab, for Linux desktop");
  expect(box?.querySelector("dd [data-text='code']")?.textContent).toBe("sudo apt-get install -y xvfb");
  expect(box?.querySelector("button[aria-label^='Copy']")).not.toBeNull();
  // Where every kind runs or is simply off, no command.
  expect(row("devbox")?.querySelector("dt")).toBeNull();
});

// The agents' Mac offers only its own screen: an older node of it still reports a browser, an emulator and a desktop,
// and none of them shows, nor an idle timeout to pick, as its screen ends after its own few idle minutes.
it("the agents' Mac shows only its own screen's switch", async () => {
  const agentsMac: MachineRolesEntry = {
    ...devbox,
    machineId: "studio",
    name: "studio",
    roles: ["sessions"],
    mac: { on: true, ready: true },
    hosts: [
      { host: "browser", ready: true, detail: "Chrome at /Applications/Google Chrome.app", on: true, idleMinutes: 30 },
      { host: "android", ready: false, detail: "Android screens run on Linux x86_64 with KVM", off: "unsupported", on: false, idleMinutes: 30 },
      { host: "desktop", ready: false, detail: "desktop screens run on Linux (docker or Xvfb)", off: "unsupported", on: true, idleMinutes: 30 },
      { host: "mac", ready: true, detail: "the node's session is on the Mac's screen", on: true, idleMinutes: 5 },
    ],
  };
  listed = [devbox, agentsMac];
  await render();
  const mac = row("studio");
  expect([...(mac?.querySelectorAll('button[role="switch"]') ?? [])].map((b) => b.getAttribute("aria-label"))).toEqual(["Agents’ Mac screens on studio"]);
  expect(toggle(mac, "Agents’ Mac")?.disabled).toBe(false);
  expect(mac?.textContent).not.toContain("An idle screen ends");
  expect(mac?.textContent).toContain("An idle Mac screen ends after 5 minutes, so the next agent gets it.");
  expect(mac?.textContent).not.toContain("Chrome");
  // Another machine keeps every kind.
  expect(toggle(row("devbox"), "Browser")).not.toBeNull();
  expect(toggle(row("devbox"), "Linux desktop")).not.toBeNull();
});

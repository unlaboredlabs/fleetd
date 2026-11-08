// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { HubFrame, HubState } from "../../../shared/hub";
import { createDataLayer, type HubApi } from "../../src/data/queries";
import { DataProvider } from "../../src/data/react";
import { TooltipProvider } from "../../ui/primitives/Tooltip";
import { HubStatus } from "./HubStatus";
import { parseHash } from "./routes";

const fleetd = vi.hoisted(() => {
  const f = { fixture: null as string | null, platform: "linux", updates: { subscribe: () => () => undefined, state: () => new Promise(() => undefined) } };
  (window as unknown as { fleetd: typeof f }).fleetd = f;
  return f;
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const HUB = "http://devbox.example.ts.net:4790";

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  fleetd.fixture = null;
  window.location.hash = "#/";
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const hubApi: HubApi = {
  call: () => Promise.resolve({ ok: true, output: {} }),
  subscribe: () => () => undefined,
  resync: () => Promise.resolve(),
  focus: () => Promise.resolve(),
  chat: () => Promise.resolve(),
};

/** A fresh chip for `state`, its popover opened; returns the popover's buttons, by their words. */
const open = (state: HubState): string[] => {
  act(() => {
    root.render(
      <DataProvider layer={createDataLayer(hubApi)}>
        <TooltipProvider>
          <HubStatus key={JSON.stringify(state)} hub={state} />
        </TooltipProvider>
      </DataProvider>,
    );
  });
  const chip = host.querySelector<HTMLButtonElement>("[data-hub-status]");
  if (chip === null) throw new Error("no hub chip");
  act(() => chip.click());
  const pop = document.querySelector("[aria-label='Hub'][role='dialog']");
  if (pop === null) throw new Error("the popover didn't open");
  return [...pop.querySelectorAll("button")].map((b) => b.textContent);
};

const popover = () => document.querySelector("[aria-label='Hub'][role='dialog']")?.textContent ?? "";

it("shows only the actions that apply to each state", () => {
  expect(open({ phase: "live", hub: HUB, protocol: 1, version: "0.9.2" })).toEqual(["Settings › Hubs", "Disconnect…"]);
  expect(open({ phase: "connecting", hub: HUB, attempt: 1 })).toEqual(["Settings › Hubs", "Disconnect…"]);
  expect(open({ phase: "retrying", hub: HUB, reason: "Nothing is listening at devbox:4790", retryAt: 0 })).toEqual([
    "Retry now",
    "Settings › Hubs",
    "Disconnect…",
  ]);
  expect(open({ phase: "unpaired" })).toEqual(["Pair with a hub"]);
});

it("keeps the hub's name through a restart, says it is updating, and calls it offline only after 2 minutes", () => {
  const away = (ms: number): HubState => ({ phase: "retrying", hub: HUB, reason: "Nothing is listening at devbox:4790", retryAt: 0, restarting: Date.now() - ms });
  expect(open(away(1_000))).toEqual(["Settings › Hubs", "Disconnect…"]);
  const chip = () => host.querySelector<HTMLElement>("[data-hub-status]");
  expect(chip()?.dataset["tone"]).toBe("restarting");
  expect(chip()?.textContent).toBe("devboxUpdating…");
  expect(popover()).toContain("Updating fleetd…");
  expect(popover()).not.toContain("Nothing is listening");
  // Long: the line in the main area has Try now, and so does the popover.
  expect(open(away(40_000))).toEqual(["Retry now", "Settings › Hubs", "Disconnect…"]);
  expect(open(away(130_000))).toEqual(["Retry now", "Settings › Hubs", "Disconnect…"]);
  expect(chip()?.textContent).toBe("Offline");
  expect(popover()).toContain("Nothing is listening");
});

it("offers nothing to do on sample data", () => {
  fleetd.fixture = "status-rows";
  expect(open({ phase: "live", hub: HUB, protocol: 1 })).toEqual([]);
  expect(host.querySelector("[data-hub-status]")?.textContent).toBe("Sample data");
});

it("names a live hub by its short name, with the address, protocol and version in the popover", () => {
  open({ phase: "live", hub: HUB, protocol: 1, version: "0.9.2" });
  expect(host.querySelector("[data-hub-status]")?.textContent).toBe("devbox");
  expect(popover()).toContain(HUB);
  expect(popover()).toContain("v1 · fleetd 0.9.2");
});

it("says why it is offline and what to do about it", () => {
  open({ phase: "retrying", hub: HUB, reason: "Nothing is listening at devbox:4790", fix: "Run `fleetd doctor` on devbox", retryAt: 0 });
  expect(popover()).toContain("Nothing is listening at devbox:4790");
  expect(popover()).toContain("Run fleetd doctor on devbox");
  expect(document.querySelector("[aria-label='Hub'][role='dialog'] code")?.textContent).toBe("fleetd doctor");
});

it("changes hubs from Settings › Hubs, never #/onboarding, which a connected app leaves at once", () => {
  const buttons = () => [...document.querySelectorAll<HTMLButtonElement>("[aria-label='Hub'][role='dialog'] button")];
  open({ phase: "live", hub: HUB, protocol: 1 });
  act(() => buttons().find((b) => b.textContent === "Settings › Hubs")?.click());
  expect(parseHash(window.location.hash)).toMatchObject({ id: "settings", tab: "hubs" });

  open({ phase: "unpaired" });
  act(() => buttons().find((b) => b.textContent === "Pair with a hub")?.click());
  expect(window.location.hash).toBe("#/onboarding");
});

it("opens Machines from the popover always, and from \"N down\" while machines are down", async () => {
  let listener: (frame: HubFrame) => void = () => undefined;
  const machine = (name: string, status: "online" | "offline") => ({
    machineId: name,
    name,
    nodeVersion: "1",
    status,
    lastSeenAt: "2026-10-26T09:00:00.000Z",
    tags: [],
    boxPubKey: "Az+6kf/abi0V7SO+sn4h++sIgyPoNDAneLBDFaJf3TA=",
  });
  const feed = async (machines: ReturnType<typeof machine>[]) => {
    await act(async () => {
      listener({ t: "state", state: { phase: "live", hub: HUB, protocol: 1 } });
      listener({ t: "snapshot", snapshot: { cursor: 1, attention: [], projects: [], machines } });
      await new Promise((r) => setTimeout(r, 0));
    });
  };
  act(() => {
    root.render(
      <DataProvider layer={createDataLayer({ ...hubApi, subscribe: (l) => ((listener = l), () => undefined) })}>
        <TooltipProvider>
          <HubStatus hub={{ phase: "live", hub: HUB, protocol: 1 }} />
        </TooltipProvider>
      </DataProvider>,
    );
  });
  const down = () => host.querySelector<HTMLButtonElement>("[data-opens='machines']");

  // All online: no "N down", and the popover's Machines line still opens Machines.
  await feed([machine("devbox", "online")]);
  expect(down()).toBeNull();
  act(() => host.querySelector<HTMLButtonElement>("[data-hub-status]")?.click());
  const line = document.querySelector<HTMLButtonElement>("[aria-label='Hub'][role='dialog'] [data-opens='machines']");
  expect(line?.textContent).toBe("1 of 1 online");
  act(() => line?.click());
  expect(parseHash(window.location.hash)).toEqual({ id: "settings", tab: "hub.machines" });
  expect(document.querySelector("[aria-label='Hub'][role='dialog']")).toBeNull();
  window.location.hash = "#/";

  await feed([machine("devbox", "online"), machine("buildbox", "offline"), machine("laptop", "offline")]);
  expect(down()?.textContent).toBe("2 down");
  expect(down()?.getAttribute("aria-label")).toBe("2 machines down: open Machines");
  act(() => down()?.click());
  expect(parseHash(window.location.hash)).toEqual({ id: "settings", tab: "hub.machines" });
});

it("shows a member the machines online and down as plain text: Machines is for admins", async () => {
  let listener: (frame: HubFrame) => void = () => undefined;
  const member: HubApi = {
    ...hubApi,
    call: (tool) => Promise.resolve({ ok: true, output: tool === "hub_info" ? { me: { personId: "pe_sam", name: "Sam", role: "member" } } : {} }),
    subscribe: (l) => ((listener = l), () => undefined),
  };
  const machine = (name: string, status: "online" | "offline") => ({ machineId: name, name, nodeVersion: "1", status, lastSeenAt: "2026-10-26T09:00:00.000Z", tags: [] });
  act(() => {
    root.render(
      <DataProvider layer={createDataLayer(member)}>
        <TooltipProvider>
          <HubStatus hub={{ phase: "live", hub: HUB, protocol: 1 }} />
        </TooltipProvider>
      </DataProvider>,
    );
  });
  await act(async () => {
    listener({ t: "state", state: { phase: "live", hub: HUB, protocol: 1 } });
    listener({ t: "snapshot", snapshot: { cursor: 1, attention: [], projects: [], machines: [machine("devbox", "online"), machine("laptop", "offline")] } });
    await new Promise((r) => setTimeout(r, 0));
  });
  expect(host.querySelector("[data-opens='machines']")).toBeNull();
  expect(host.querySelector("[data-down]")?.textContent).toBe("1 down");
  act(() => host.querySelector<HTMLButtonElement>("[data-hub-status]")?.click());
  const pop = document.querySelector("[aria-label='Hub'][role='dialog']");
  expect(pop?.querySelector("[data-opens='machines']")).toBeNull();
  expect(pop?.textContent).toContain("1 of 2 online");
});

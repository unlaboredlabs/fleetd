// @vitest-environment happy-dom
// The sidebar's foot (W530): your name, and nothing else while all is well; a quiet mark on your picture only while a
// hub is really unreachable or refused your key (for an admin, also while machines are down); and, opened, each hub's
// card: where the link stands, what to do about it, the address, machines and version, and Settings.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { HubFrame, HubState } from "../../../shared/hub";
import { createDataLayer, type HubApi } from "../../src/data/queries";
import { DataProvider } from "../../src/data/react";
import { TooltipProvider } from "../../ui/primitives/Tooltip";
import { parseHash, type Screen } from "./routes";
import { You } from "./You";

const fleetd = vi.hoisted(() => {
  const f = { fixture: null as string | null, platform: "linux", updates: { subscribe: () => () => undefined, state: () => new Promise(() => undefined) } };
  (window as unknown as { fleetd: typeof f }).fleetd = f;
  return f;
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const HUB = "http://devbox.example.ts.net:4790";

let host: HTMLDivElement;
let root: Root;
let listener: (frame: HubFrame) => void;
let went: Screen[];

beforeEach(() => {
  fleetd.fixture = null;
  went = [];
  window.location.hash = "#/";
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const machine = (name: string, status: "online" | "offline") => ({
  machineId: name,
  name,
  nodeVersion: "1",
  status,
  lastSeenAt: "2026-10-26T09:00:00.000Z",
  tags: [],
  boxPubKey: "Az+6kf/abi0V7SO+sn4h++sIgyPoNDAneLBDFaJf3TA=",
});

/** The foot on a hub in `state`, as `me` (none: a hub before people, so an admin), with `machines`. */
const mount = async (state: HubState, { me, machines = [] }: { me?: { name: string; role: string }; machines?: ReturnType<typeof machine>[] } = {}) => {
  const hub: HubApi = {
    call: (tool) => Promise.resolve({ ok: true, output: tool === "hub_info" && me !== undefined ? { me: { personId: "pe_me", createdAt: "", ...me } } : {} }),
    subscribe: (l) => ((listener = l), () => undefined),
    resync: () => Promise.resolve(),
    focus: () => Promise.resolve(),
    chat: () => Promise.resolve(),
  };
  act(() => {
    root.render(
      <DataProvider key={String(Math.random())} layer={createDataLayer(hub)}>
        <TooltipProvider>
          <You screen={{ id: "home" }} factory go={(s) => went.push(s)} />
        </TooltipProvider>
      </DataProvider>,
    );
  });
  act(() => {
    listener({ t: "state", state: { phase: "live", hub: HUB, protocol: 1, version: "0.9.2" } });
    listener({ t: "snapshot", snapshot: { cursor: 1, attention: [], projects: [], machines } });
    if (state.phase !== "live") listener({ t: "state", state });
  });
  // The reads (hub_info, setup_list) answer.
  for (let i = 0; i < 4; i++) await act(() => new Promise((r) => setTimeout(r, 0)));
};

const me = () => host.querySelector<HTMLButtonElement>("[data-opens='you']");
const card = () => document.querySelector("[aria-label='You'][role='dialog']");
/** Opens the card; returns its hub's actions, by their words. */
const open = (): string[] => {
  act(() => me()?.click());
  if (card() === null) throw new Error("the card didn't open");
  return [...(card()?.querySelectorAll("[data-hub-card] button:not([data-opens])") ?? [])].map((b) => b.textContent);
};

it("says your name and nothing else while all is well", async () => {
  await mount({ phase: "live", hub: HUB, protocol: 1 }, { me: { name: "Sam", role: "owner" }, machines: [machine("devbox", "online")] });
  expect(me()?.textContent).toBe("Sam");
  expect(me()?.getAttribute("aria-label")).toBe("Sam");
  expect(me()?.dataset["mark"]).toBeUndefined();
  // No hub name, no dot at rest.
  expect(host.textContent).not.toContain("devbox");
});

it("marks your picture while the hub is offline or refused the key, never while it first connects or restarts", async () => {
  await mount({ phase: "connecting", hub: HUB, attempt: 1 });
  expect(me()?.dataset["mark"]).toBeUndefined();
  await mount({ phase: "retrying", hub: HUB, reason: "Nothing is listening at devbox:4790", retryAt: 0, restarting: Date.now() - 1_000, updatingTo: "0.9.3" });
  expect(me()?.dataset["mark"]).toBeUndefined();
  await mount({ phase: "retrying", hub: HUB, reason: "Nothing is listening at devbox:4790", retryAt: 0 });
  expect(me()?.dataset["mark"]).toBe("warning");
  expect(me()?.getAttribute("aria-label")).toBe("You, Offline");
  await mount({ phase: "refused", hub: HUB, message: "revoked" });
  expect(me()?.dataset["mark"]).toBe("danger");
});

it("shows only the actions that apply to each state", async () => {
  await mount({ phase: "live", hub: HUB, protocol: 1 });
  expect(open()).toEqual(["Settings › Hubs", "Disconnect…"]);
  await mount({ phase: "retrying", hub: HUB, reason: "Nothing is listening at devbox:4790", retryAt: 0 });
  expect(open()).toEqual(["Retry now", "Settings › Hubs", "Disconnect…"]);
  await mount({ phase: "unpaired" });
  expect(open()).toEqual(["Pair with a hub"]);
});

it("says the hub is updating through an update's restart, and offline only after 2 minutes", async () => {
  const away = (ms: number): HubState => ({ phase: "retrying", hub: HUB, reason: "Nothing is listening at devbox:4790", retryAt: 0, restarting: Date.now() - ms, updatingTo: "0.9.3" });
  await mount(away(1_000));
  expect(open()).toEqual(["Settings › Hubs", "Disconnect…"]);
  expect(card()?.textContent).toContain("Updating fleetd…");
  expect(card()?.textContent).not.toContain("Nothing is listening");
  await mount(away(130_000));
  expect(open()).toEqual(["Retry now", "Settings › Hubs", "Disconnect…"]);
  expect(card()?.textContent).toContain("Nothing is listening");
});

it("offers nothing to do on sample data", async () => {
  fleetd.fixture = "status-rows";
  await mount({ phase: "live", hub: HUB, protocol: 1 });
  expect(open()).toEqual([]);
  expect(card()?.textContent).toContain("Sample data");
});

it("has the address, version and protocol, and why it is offline with what to do", async () => {
  await mount({ phase: "live", hub: HUB, protocol: 1 });
  open();
  expect(card()?.textContent).toContain(HUB);
  expect(card()?.textContent).toContain("fleetd 0.9.2 · v1");
  await mount({ phase: "retrying", hub: HUB, reason: "Nothing is listening at devbox:4790", fix: "Run `fleetd doctor` on devbox", retryAt: 0 });
  open();
  expect(card()?.textContent).toContain("Nothing is listening at devbox:4790");
  expect(card()?.querySelector("code")?.textContent).toBe("fleetd doctor");
});

it("changes hubs from Settings › Hubs, never #/onboarding, and opens Settings", async () => {
  const button = (words: string) => [...(card()?.querySelectorAll<HTMLButtonElement>("button") ?? [])].find((b) => b.textContent.startsWith(words));
  await mount({ phase: "live", hub: HUB, protocol: 1 });
  open();
  act(() => button("Settings › Hubs")?.click());
  expect(parseHash(window.location.hash)).toMatchObject({ id: "settings", tab: "hubs" });
  open();
  act(() => card()?.querySelector<HTMLButtonElement>("[data-opens='settings']")?.click());
  expect(went).toEqual([{ id: "settings", tab: "general" }]);
  expect(card()).toBeNull();

  await mount({ phase: "unpaired" });
  open();
  act(() => button("Pair with a hub")?.click());
  expect(window.location.hash).toBe("#/onboarding");
});

it("marks an admin's picture while machines are down, and opens Machines from the card", async () => {
  await mount({ phase: "live", hub: HUB, protocol: 1 }, { machines: [machine("devbox", "online"), machine("buildbox", "offline"), machine("laptop", "offline")] });
  expect(me()?.dataset["mark"]).toBe("warning");
  expect(me()?.getAttribute("aria-label")).toBe("You, 2 machines down");
  open();
  const line = card()?.querySelector<HTMLButtonElement>("[data-opens='machines']");
  expect(line?.textContent).toBe("1 of 3 online");
  act(() => line?.click());
  expect(parseHash(window.location.hash)).toEqual({ id: "settings", tab: "hub.machines" });
  expect(card()).toBeNull();
});

it("shows a member the machines as plain text, and marks nothing for them: Machines is for admins", async () => {
  await mount({ phase: "live", hub: HUB, protocol: 1 }, { me: { name: "Sam", role: "member" }, machines: [machine("devbox", "online"), machine("laptop", "offline")] });
  expect(me()?.dataset["mark"]).toBeUndefined();
  open();
  expect(card()?.querySelector("[data-opens='machines']")).toBeNull();
  expect(card()?.textContent).toContain("1 of 2 online");
});

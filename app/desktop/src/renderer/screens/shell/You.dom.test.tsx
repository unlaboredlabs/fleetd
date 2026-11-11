// @vitest-environment happy-dom
// The sidebar's foot (W530): your name, and nothing else while all is well; a quiet mark on your picture only while a
// hub is really unreachable or refused your key (for an admin, also while a machine is offline or setup steps are
// left); and, opened, the menu (W607): who you are, a row per hub and Settings, with one more row for each thing off.
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
const mount = async (state: HubState, { me, machines = [], setupLeft = 0 }: { me?: { name: string; role: string }; machines?: ReturnType<typeof machine>[]; setupLeft?: number } = {}) => {
  const hub: HubApi = {
    call: (tool) =>
      Promise.resolve({
        ok: true,
        output: tool === "hub_info" && me !== undefined ? { me: { personId: "pe_me", createdAt: "", ...me } } : tool === "setup_list" ? { steps: [], requiredLeft: setupLeft } : {},
      }),
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
const row = (line: string) => card()?.querySelector<HTMLElement>(`[data-line='${line}']`);
/** Opens the menu; returns its rows as a person reads them: each one's words, then what its end says. */
const open = (): string[] => {
  act(() => me()?.click());
  if (card() === null) throw new Error("the menu didn't open");
  return [...(card()?.querySelectorAll("[data-line], [data-opens='settings']") ?? [])].map((r) => [...r.children].slice(1).map((c) => c.textContent).join(" · "));
};
const SETTINGS = "Settings · Ctrl+,";

it("says your name and nothing else while all is well", async () => {
  await mount({ phase: "live", hub: HUB, protocol: 1 }, { me: { name: "Sam", role: "owner" }, machines: [machine("devbox", "online")] });
  expect(me()?.textContent).toBe("Sam");
  expect(me()?.getAttribute("aria-label")).toBe("Sam");
  expect(me()?.dataset["mark"]).toBeUndefined();
  // No hub name, no dot at rest.
  expect(host.textContent).not.toContain("devbox");
});

it("opens on who you are, the hub's name and Settings, and nothing else while all is well", async () => {
  await mount({ phase: "live", hub: HUB, protocol: 1, version: "0.9.2" }, { me: { name: "Sam", role: "owner" }, machines: [machine("devbox", "online")] });
  expect(open()).toEqual(["devbox", SETTINGS]);
  expect(card()?.textContent).toBe("SamOwnerdevboxSettingsCtrl+,");
  expect(row("hub")?.dataset["mark"]).toBe("success");
});

it("is the same small menu for a member", async () => {
  await mount({ phase: "live", hub: HUB, protocol: 1 }, { me: { name: "Bob", role: "member" }, machines: [machine("devbox", "online"), machine("laptop", "offline")], setupLeft: 2 });
  expect(me()?.dataset["mark"]).toBeUndefined();
  expect(open()).toEqual(["devbox", SETTINGS]);
  expect(card()?.textContent).toBe("BobMemberdevboxSettingsCtrl+,");
});

it("marks your picture while the hub is offline or refused the key, never while it first connects or restarts", async () => {
  await mount({ phase: "connecting", hub: HUB, attempt: 1 });
  expect(me()?.dataset["mark"]).toBeUndefined();
  await mount({ phase: "retrying", hub: HUB, reason: "Nothing is listening at devbox:4790", retryAt: 0, restarting: Date.now() - 1_000, updatingTo: "0.9.3" });
  expect(me()?.dataset["mark"]).toBeUndefined();
  await mount({ phase: "retrying", hub: HUB, reason: "Nothing is listening at devbox:4790", retryAt: 0 });
  expect(me()?.dataset["mark"]).toBe("warning");
  expect(me()?.getAttribute("aria-label")).toBe("You, Can't reach devbox");
  await mount({ phase: "refused", hub: HUB, message: "revoked" });
  expect(me()?.dataset["mark"]).toBe("danger");
});

it("says a problem in one row with the one thing to do, and never the hub's address or its reason", async () => {
  await mount({ phase: "retrying", hub: HUB, reason: "Nothing is listening at devbox:4790", fix: "Run `fleetd doctor` on devbox", retryAt: 0 });
  expect(open()).toEqual(["Can't reach devbox · Retry", SETTINGS]);
  expect(card()?.textContent).not.toMatch(/https?:|4790|listening|doctor/u);
  await mount({ phase: "refused", hub: HUB, message: "This key was revoked" });
  expect(open()).toEqual(["devbox refused the key · Pair again", SETTINGS]);
  await mount({ phase: "unpaired" });
  expect(open()).toEqual(["Not paired with a hub · Pair", SETTINGS]);
});

it("lets only the hub's name give way in a narrow row, whole on hover; what is wrong and its action stay", async () => {
  await mount({ phase: "refused", hub: HUB, message: "" });
  open();
  const name = row("hub")?.querySelector<HTMLElement>("[title]");
  expect(name?.title).toBe("devbox");
  expect(name?.textContent).toBe("devbox");
  // The words after the name and the action are their own, outside the part that is cut short.
  expect([...(name?.parentElement?.children ?? [])].map((c) => c.textContent)).toEqual(["devbox", " refused the key"]);
});

it("says the hub is updating through an update's restart, and out of reach only after 2 minutes", async () => {
  const away = (ms: number): HubState => ({ phase: "retrying", hub: HUB, reason: "Nothing is listening at devbox:4790", retryAt: 0, restarting: Date.now() - ms, updatingTo: "0.9.3" });
  await mount(away(1_000));
  expect(open()).toEqual(["devbox · Updating…", SETTINGS]);
  expect(row("hub")?.dataset["mark"]).toBe("ring");
  await mount(away(130_000));
  expect(open()).toEqual(["Can't reach devbox · Retry", SETTINGS]);
});

it("reads the same on sample data: the banner says what it is", async () => {
  fleetd.fixture = "status-rows";
  await mount({ phase: "live", hub: HUB, protocol: 1 });
  expect(open()).toEqual(["devbox", SETTINGS]);
});

it("opens Settings › You › Hubs & devices from the hub's row, pairing from Pair, and Settings from its own row", async () => {
  await mount({ phase: "live", hub: HUB, protocol: 1 });
  open();
  act(() => row("hub")?.click());
  expect(parseHash(window.location.hash)).toMatchObject({ id: "settings", tab: "hubs" });
  expect(card()).toBeNull();
  open();
  act(() => card()?.querySelector<HTMLButtonElement>("[data-opens='settings']")?.click());
  expect(went).toEqual([{ id: "settings", tab: "general" }]);
  expect(card()).toBeNull();

  await mount({ phase: "unpaired" });
  open();
  act(() => row("hub")?.click());
  expect(window.location.hash).toBe("#/onboarding");
});

it("dials again from Retry, and stays open to say how it went", async () => {
  await mount({ phase: "retrying", hub: HUB, reason: "Nothing is listening at devbox:4790", retryAt: 0 });
  open();
  act(() => row("hub")?.click());
  expect(card()).not.toBeNull();
});

it("marks an admin's picture while a machine is offline, names it in the menu, and opens its page", async () => {
  await mount({ phase: "live", hub: HUB, protocol: 1 }, { machines: [machine("devbox", "online"), machine("buildbox", "offline")] });
  expect(me()?.dataset["mark"]).toBe("warning");
  expect(me()?.getAttribute("aria-label")).toBe("You, buildbox is offline");
  expect(open()).toEqual(["devbox", "buildbox is offline · Open", SETTINGS]);
  act(() => row("machines")?.click());
  expect(parseHash(window.location.hash)).toEqual({ id: "settings", tab: "hub.machines", machine: "buildbox" });
  expect(card()).toBeNull();
});

it("counts several machines, and opens Machines", async () => {
  await mount({ phase: "live", hub: HUB, protocol: 1 }, { machines: [machine("devbox", "online"), machine("buildbox", "offline"), machine("laptop", "offline")] });
  expect(me()?.getAttribute("aria-label")).toBe("You, 2 machines offline");
  expect(open()).toEqual(["devbox", "2 machines offline · Open", SETTINGS]);
  act(() => row("machines")?.click());
  expect(parseHash(window.location.hash)).toEqual({ id: "settings", tab: "hub.machines" });
});

it("tells an admin of setup steps left, and Finish opens Hub › Setup", async () => {
  await mount({ phase: "live", hub: HUB, protocol: 1 }, { me: { name: "Sam", role: "owner" }, machines: [machine("devbox", "online")], setupLeft: 2 });
  expect(me()?.dataset["mark"]).toBe("warning");
  expect(me()?.getAttribute("aria-label")).toBe("Sam, 2 setup steps left");
  expect(open()).toEqual(["devbox", "2 setup steps left · Finish", SETTINGS]);
  act(() => row("setup")?.click());
  expect(parseHash(window.location.hash)).toEqual({ id: "settings", tab: "hub.setup" });
  expect(card()).toBeNull();
});

it("tells a member who to ask when no machine is online, as plain text: Machines is for admins", async () => {
  await mount({ phase: "live", hub: HUB, protocol: 1 }, { me: { name: "Bob", role: "member" }, machines: [machine("devbox", "offline"), machine("laptop", "offline")] });
  expect(me()?.dataset["mark"]).toBe("warning");
  expect(open()).toEqual(["devbox", "All machines offline · Ask an admin", SETTINGS]);
  expect(row("machines")?.tagName).toBe("DIV");
});

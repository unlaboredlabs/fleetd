// @vitest-environment happy-dom
// The sidebar's foot (W530, W714): your picture and name alone, and your menu: who you are, Settings, Appearance,
// Keyboard shortcuts and Help. What is off with a hub (W607) is the hub switcher's: a quiet mark while a hub is really
// unreachable or refused your key (for an admin, also while a machine is offline or setup steps are left), and, in its
// menu, one row under the hub for each thing off with the one thing to do (HubLines).
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { HubFrame, HubState } from "../../../shared/hub";
import { createDataLayer, type HubApi } from "../../src/data/queries";
import { DataProvider } from "../../src/data/react";
import { parseHash, type Screen } from "./routes";
import { PlaceIcons, useHubsMark, You } from "./You";
import { HubLines } from "./HubStatus";
import { Menu, MenuContent, MenuTrigger, UiProvider } from "../../ui";

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

/** What the hub switcher says is off, as its mark and its words. */
function Marked() {
  const mark = useHubsMark();
  return <span data-testid="mark" data-mark={mark?.tone} aria-label={mark?.why ?? ""} />;
}

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
        <UiProvider>
          <PlaceIcons screen={{ id: "home" }} factory go={(s) => went.push(s)} />
          <You go={(s) => went.push(s)} />
          <Marked />
          <Menu>
            <MenuTrigger data-opens="hub-lines">Hub</MenuTrigger>
            <MenuContent aria-label="Hub lines">
              <HubLines />
            </MenuContent>
          </Menu>
        </UiProvider>
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
const mark = () => host.querySelector<HTMLElement>("[data-testid='mark']");
const menuOf = (label: string) => document.querySelector<HTMLElement>(`[role='menu'][aria-label='${label}']`);
/** A menu opens from the keys as from a press (a press opens it on pointer-down, which the DOM here can't give). */
const press = (el: HTMLElement | null | undefined) => act(() => void el?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
const close = () => act(() => void document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
/** A menu's rows as a person reads them: each one's words, then what its end says. */
const rows = (menu: HTMLElement | null) =>
  [...(menu?.querySelectorAll<HTMLElement>("[role='menuitem']") ?? [])].map((r) => [r.querySelector("[data-text]")?.textContent ?? "", r.querySelector("[class*=itemHint]")?.textContent ?? ""].filter((w) => w !== "").join(" · "));
/** Opens your menu; returns its rows. */
const open = (): string[] => {
  press(me());
  const menu = menuOf("You");
  if (menu === null) throw new Error("the menu didn't open");
  return rows(menu);
};
/** Opens the hub's lines, as the switcher's menu has them under the hub; returns them. */
const lines = (): string[] => {
  press(host.querySelector<HTMLElement>("[data-opens='hub-lines']"));
  const found = rows(menuOf("Hub lines"));
  return found;
};
const line = (key: string) => menuOf("Hub lines")?.querySelector<HTMLElement>(`[data-line='${key}']`);
const MENU = ["Settings · Ctrl+,", "Appearance · Match system", "Keyboard shortcuts · Ctrl+/", "Help & docs"];

it("is your picture and name alone, no second line, and no mark while all is well", async () => {
  await mount({ phase: "live", hub: HUB, protocol: 1 }, { me: { name: "Sam", role: "owner" }, machines: [machine("devbox", "online")] });
  expect(me()?.textContent).toBe("Sam");
  expect(me()?.getAttribute("aria-label")).toBe("Sam");
  expect(mark()?.dataset["mark"]).toBeUndefined();
});

it("opens on who you are, then Settings, Appearance, Keyboard shortcuts and Help, and no hub", async () => {
  await mount({ phase: "live", hub: HUB, protocol: 1, version: "0.9.2" }, { me: { name: "Sam", role: "owner" }, machines: [machine("devbox", "online")] });
  expect(open()).toEqual(MENU);
  expect(menuOf("You")?.textContent).toMatch(/^SamOwner/u);
  expect(menuOf("You")?.textContent).not.toContain("devbox");
  act(() => menuOf("You")?.querySelector<HTMLElement>("[data-opens='settings']")?.click());
  expect(went).toEqual([{ id: "settings", tab: "general" }]);
  expect(menuOf("You")).toBeNull();
});

it("is the same menu for a member", async () => {
  await mount({ phase: "live", hub: HUB, protocol: 1 }, { me: { name: "Bob", role: "member" }, machines: [machine("devbox", "online"), machine("laptop", "offline")], setupLeft: 2 });
  expect(mark()?.dataset["mark"]).toBeUndefined();
  expect(open()).toEqual(MENU);
});

it("marks the hub switcher while the hub is offline or refused the key, never while it first connects or restarts", async () => {
  await mount({ phase: "connecting", hub: HUB, attempt: 1 });
  expect(mark()?.dataset["mark"]).toBeUndefined();
  await mount({ phase: "retrying", hub: HUB, reason: "Nothing is listening at devbox:4790", retryAt: 0, restarting: Date.now() - 1_000, updatingTo: "0.9.3" });
  expect(mark()?.dataset["mark"]).toBeUndefined();
  await mount({ phase: "retrying", hub: HUB, reason: "Nothing is listening at devbox:4790", retryAt: 0 });
  expect(mark()?.dataset["mark"]).toBe("warning");
  expect(mark()?.getAttribute("aria-label")).toBe("Can't reach devbox");
  await mount({ phase: "refused", hub: HUB, message: "revoked" });
  expect(mark()?.dataset["mark"]).toBe("danger");
});

it("has no line under a hub while all is well", async () => {
  await mount({ phase: "live", hub: HUB, protocol: 1 }, { me: { name: "Sam", role: "owner" }, machines: [machine("devbox", "online")] });
  expect(lines()).toEqual([]);
});

it("says a problem in one line with the one thing to do, and never the hub's address or its reason", async () => {
  await mount({ phase: "retrying", hub: HUB, reason: "Nothing is listening at devbox:4790", fix: "Run `fleetd doctor` on devbox", retryAt: 0 });
  expect(lines()).toEqual(["Can't reach devbox · Retry"]);
  expect(menuOf("Hub lines")?.textContent).not.toMatch(/https?:|4790|listening|doctor/u);
  await mount({ phase: "refused", hub: HUB, message: "This key was revoked" });
  expect(lines()).toEqual(["devbox refused the key · Pair again"]);
  await mount({ phase: "unpaired" });
  expect(lines()).toEqual(["Not paired with a hub · Pair"]);
});

it("lets only the hub's name give way in a narrow line, whole on hover; what is wrong and its action stay", async () => {
  await mount({ phase: "refused", hub: HUB, message: "" });
  lines();
  const name = line("hub")?.querySelector<HTMLElement>("[title]");
  expect(name?.title).toBe("devbox");
  expect([...(name?.parentElement?.children ?? [])].map((c) => c.textContent)).toEqual(["devbox", " refused the key"]);
});

it("says the hub is updating through an update's restart, and out of reach only after 2 minutes", async () => {
  const away = (ms: number): HubState => ({ phase: "retrying", hub: HUB, reason: "Nothing is listening at devbox:4790", retryAt: 0, restarting: Date.now() - ms, updatingTo: "0.9.3" });
  await mount(away(1_000));
  expect(lines()).toEqual(["devbox · Updating…"]);
  expect(line("hub")?.dataset["mark"]).toBe("ring");
  close();
  await mount(away(130_000));
  expect(lines()).toEqual(["Can't reach devbox · Retry"]);
});

it("pairs from Pair", async () => {
  await mount({ phase: "unpaired" });
  lines();
  act(() => line("hub")?.click());
  expect(window.location.hash).toBe("#/onboarding");
});

it("dials again from Retry, and stays open to say how it went", async () => {
  await mount({ phase: "retrying", hub: HUB, reason: "Nothing is listening at devbox:4790", retryAt: 0 });
  lines();
  act(() => line("hub")?.click());
  expect(menuOf("Hub lines")).not.toBeNull();
});

it("marks the switcher for an admin while a machine is offline, names it under the hub, and opens its page", async () => {
  await mount({ phase: "live", hub: HUB, protocol: 1 }, { machines: [machine("devbox", "online"), machine("buildbox", "offline")] });
  expect(mark()?.dataset["mark"]).toBe("warning");
  expect(mark()?.getAttribute("aria-label")).toBe("buildbox is offline");
  expect(lines()).toEqual(["buildbox is offline · Open"]);
  act(() => line("machines")?.click());
  expect(parseHash(window.location.hash)).toEqual({ id: "settings", tab: "hub.machines", machine: "buildbox" });
  expect(menuOf("Hub lines")).toBeNull();
});

it("counts several machines, and opens Machines", async () => {
  await mount({ phase: "live", hub: HUB, protocol: 1 }, { machines: [machine("devbox", "online"), machine("buildbox", "offline"), machine("laptop", "offline")] });
  expect(mark()?.getAttribute("aria-label")).toBe("2 machines offline");
  expect(lines()).toEqual(["2 machines offline · Open"]);
  act(() => line("machines")?.click());
  expect(parseHash(window.location.hash)).toEqual({ id: "settings", tab: "hub.machines" });
});

it("tells an admin of setup steps left, and Finish opens Hub › Setup", async () => {
  await mount({ phase: "live", hub: HUB, protocol: 1 }, { me: { name: "Sam", role: "owner" }, machines: [machine("devbox", "online")], setupLeft: 2 });
  expect(mark()?.dataset["mark"]).toBe("warning");
  expect(mark()?.getAttribute("aria-label")).toBe("2 setup steps left");
  expect(lines()).toEqual(["2 setup steps left · Finish"]);
  act(() => line("setup")?.click());
  expect(parseHash(window.location.hash)).toEqual({ id: "settings", tab: "hub.setup" });
});

it("tells a member who to ask when no machine is online, a line that does nothing: Machines is for admins", async () => {
  await mount({ phase: "live", hub: HUB, protocol: 1 }, { me: { name: "Bob", role: "member" }, machines: [machine("devbox", "offline"), machine("laptop", "offline")] });
  expect(mark()?.dataset["mark"]).toBe("warning");
  expect(lines()).toEqual(["All machines offline · Ask an admin"]);
  expect(line("machines")?.hasAttribute("data-disabled")).toBe(true);
});

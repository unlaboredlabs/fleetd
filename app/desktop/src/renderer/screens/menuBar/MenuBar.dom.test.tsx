// @vitest-environment happy-dom
// The menu bar popover's buttons: Take over and Hand back go to the screen's handler; each health fix runs the app's
// own (the node's Restart, a grant's ask, the App Store) or copies its command; Update starts the hub's update.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { MacCheck } from "../../../shared/contracts";
import type { MacMenuBarRead } from "../../../shared/macMenuBar";
import { UiProvider } from "../../ui";
import { Popover } from "./MenuBar";
import type { HubInput, ScreenInput } from "./model";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { restart, openPane, updateHub, copy, menu, fit } = vi.hoisted(() => {
  const restart = vi.fn(() => Promise.resolve({ ok: true as const }));
  const openPane = vi.fn(() => Promise.resolve({ ok: true as const }));
  const updateHub = vi.fn(() => Promise.resolve({ ok: true as const }));
  const copy = vi.fn(() => Promise.resolve());
  const menu = vi.fn(() => Promise.resolve());
  const fit = vi.fn(() => Promise.resolve());
  vi.stubGlobal("fleetd", {
    platform: "darwin",
    copy,
    macSetup: { restart, openPane, updateHub },
    menuBar: { read: () => Promise.resolve(null), fit, hide: () => Promise.resolve(), menu },
  });
  return { restart, openPane, updateHub, copy, menu, fit };
});

const NOW = 1_800_000_000_000;
const HUB = "http://devbox.example.ts.net:4790";
const check = (id: string, state = "ok", more: Partial<MacCheck> = {}): MacCheck => ({ id, state, message: `${id} says so.`, ...more });

const read = (checks: MacCheck[], over: Partial<MacMenuBarRead> = {}): MacMenuBarRead => ({
  found: { hubUrl: HUB, hubName: "devbox", machineId: "mac", existing: true, here: { kind: "node", machineId: "mac", hub: HUB } },
  hubId: "h1",
  health: { health: { user: "ada", checks }, writtenAt: NOW, checkedAt: NOW, now: NOW, hubAnswers: true, hubBehind: null, macBehind: null },
  activity: { simulators: [{ agent: "T12", projectId: "p1", device: "iPhone 17 Pro", sinceMs: NOW - 6 * 60_000 }], jobs: [] },
  disk: { freeBytes: 182e9, totalBytes: 994e9 },
  macBehind: null,
  ...over,
});
const screen: ScreenInput = { id: "B7c1", project: { machineId: "devbox", projectId: "p1" }, projectTitle: "storefront", who: "Write locale tests", person: false, state: "running" };
const hub = (over: Partial<HubInput> = {}): HubInput => ({ screen, agents: new Map([["T12", "Write locale tests"]]), projects: new Map([["p1", "storefront"]]), ...over });

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  for (const f of [restart, openPane, updateHub, copy, menu, fit]) f.mockClear();
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const render = async (node: React.ReactNode) =>
  act(async () => {
    root.render(<UiProvider>{node}</UiProvider>);
    await Promise.resolve();
  });
const button = (name: string) => {
  const found = [...host.querySelectorAll("button")].find((b) => b.textContent === name || b.getAttribute("aria-label") === name);
  if (found === undefined) throw new Error(`no ${name} in: ${host.textContent}`);
  return found;
};
const click = (name: string) =>
  act(async () => {
    button(name).click();
    await new Promise((r) => setTimeout(r, 0));
  });

it("lists what agents do on the Mac, and takes the screen over or hands it back through the screen's handler", async () => {
  const onScreen = vi.fn(() => Promise.resolve());
  await render(<Popover read={read([])} hub={hub()} onScreen={onScreen} />);
  expect(host.textContent).toContain("iPhone 17 Pro");
  expect(host.textContent).toContain("Write locale tests · storefront");
  expect(host.textContent).toContain("6 min");
  expect(host.textContent).toContain("Write locale tests has it · storefront");
  await click("Take over");
  expect(onScreen).toHaveBeenCalledWith(screen, "takeOver");

  await render(<Popover read={read([])} hub={hub({ screen: { ...screen, state: "yours" } })} onScreen={onScreen} />);
  await click("Hand back");
  expect(onScreen).toHaveBeenLastCalledWith({ ...screen, state: "yours" }, "handBack");
});

it("says how to see the screen when this app isn't signed in to the Mac's hub", async () => {
  await render(<Popover read={read([])} hub={null} />);
  expect(host.textContent).toContain("Sign in to devbox in this app to see who has it and take over.");
  expect(host.querySelector("button[aria-label='More']")).not.toBeNull();
  await click("More");
  expect(menu).toHaveBeenCalled();
});

it("runs each health fix: a restart, a grant's ask, the App Store, and copies a command", async () => {
  const checks = [
    check("accessibility"),
    check("screen_recording", "fail", { message: "fleetd may not record the screen yet." }),
    check("xcode", "warn", { message: "Xcode isn't installed.", command: 'open "macappstore://apps.apple.com/app/id497799835"' }),
    check("tools", "warn", { message: "CocoaPods isn't installed.", fix: "In your own (admin) account's Terminal", command: "/opt/homebrew/bin/brew install cocoapods" }),
  ];
  // A node that stopped writing its checks: Restart.
  await render(<Popover read={read(checks, { health: { ...read(checks).health, checkedAt: NOW - 200_000, writtenAt: NOW - 200_000 } })} hub={hub()} />);
  expect(host.textContent).toContain("Not running");
  await click("Restart the node");
  expect(restart).toHaveBeenCalled();

  await render(<Popover read={read(checks)} hub={hub()} />);
  expect(host.textContent).toContain("Screen Recording off");
  await click("Allow in System Settings");
  expect(openPane).toHaveBeenCalledWith("screen_recording");
  await click("Open the App Store");
  expect(openPane).toHaveBeenLastCalledWith("app_store");
  expect(host.textContent).toContain("In your own (admin) account's Terminal:");
  await click("Copy the command");
  expect(copy).toHaveBeenCalledWith("/opt/homebrew/bin/brew install cocoapods");
});

it("shows a fix that failed in the node's words", async () => {
  restart.mockImplementationOnce(() => Promise.resolve({ ok: false, failure: { message: "launchctl refused.", fix: "Run it in Terminal." } }) as never);
  await render(<Popover read={read([], { health: { ...read([]).health, health: null, writtenAt: null, checkedAt: null } })} hub={hub()} />);
  await click("Restart the node");
  expect(host.querySelector("[role=alert]")?.textContent).toContain("launchctl refused. Run it in Terminal.");
});

it("offers Update while this Mac is behind its hub, to an admin, and says who can to anyone else", async () => {
  await render(<Popover read={read([])} hub={hub()} />);
  expect(host.textContent).not.toContain("Update");

  await render(<Popover read={read([], { macBehind: { macVersion: "0.9.0", hubVersion: "0.9.2", who: "admin" } })} hub={hub()} />);
  expect(host.textContent).toContain("This Mac runs fleetd 0.9.0; devbox runs 0.9.2.");
  await click("Update");
  expect(updateHub).toHaveBeenCalledWith(HUB);
  expect(host.querySelector("[role=status]")?.textContent).toContain("Updating");

  await render(<Popover read={read([], { macBehind: { macVersion: "0.9.0", hubVersion: "0.9.2", who: "member" } })} hub={hub()} />);
  expect(host.textContent).toContain("Ask an admin of devbox");
  expect([...host.querySelectorAll("button")].some((b) => b.textContent === "Update")).toBe(false);
});

// @vitest-environment happy-dom
// Set up this Mac for agents' window: the code traded, then the join's steps as main reports each, every report heard
// for as long as the join runs, and again after Try again.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { JoinStep } from "../../../shared/joinHere";
import type { MacMenuBarRead } from "../../../shared/macMenuBar";
import type { MacHealthRead, MacJoin, MacLeaveOutcome, MacRedeemOutcome, MacSetupStatus } from "../../../shared/macSetup";
import { UiProvider } from "../../ui";
import { MacSetup } from "./MacSetup";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { listeners, joins, status, health, redeem, updateHub, appCheck, macRead, leave, exit, openPane } = vi.hoisted(() => {
  const listeners = new Set<(join: MacJoin) => void>();
  const joins: Array<(join: MacJoin) => void> = [];
  const status = vi.fn((): Promise<MacSetupStatus> => Promise.resolve({ kind: "fresh" }));
  const health = vi.fn((): Promise<MacHealthRead> => Promise.resolve({ health: null, writtenAt: null, checkedAt: null, now: Date.now(), hubAnswers: true, hubBehind: null }));
  const found: MacRedeemOutcome = {
    ok: true,
    found: { hubUrl: "http://devbox.example.ts.net:4790", hubName: "devbox", machineId: "mac", existing: false, here: { kind: "none" } },
  };
  const redeem = vi.fn((): Promise<MacRedeemOutcome> => Promise.resolve(found));
  const updateHub = vi.fn(() => Promise.resolve({ ok: true as const }));
  const appCheck = vi.fn(() => Promise.resolve());
  const macRead = vi.fn((): Promise<MacMenuBarRead | null> => Promise.resolve(null));
  const leave = vi.fn((): Promise<MacLeaveOutcome> => Promise.resolve({ ok: true, told: "removed", hubName: "devbox", machineId: "mac" }));
  const exit = vi.fn(() => Promise.resolve());
  const openPane = vi.fn(() => Promise.resolve({ ok: true as const }));
  vi.stubGlobal("fleetd", {
    platform: "darwin",
    updates: {
      state: () => Promise.resolve({ app: { kind: "idle" } }),
      subscribe: () => () => undefined,
      check: appCheck,
      install: () => Promise.resolve(),
    },
    macSetup: {
      redeem,
      join: () => new Promise<MacJoin>((done) => joins.push(done)),
      onJoin: (listener: (join: MacJoin) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      health,
      openPane,
      restart: () => Promise.resolve({ ok: true }),
      status,
      cancel: () => Promise.resolve(),
      updateHub,
      leave,
      exit,
    },
    menuBar: { read: macRead, fit: () => Promise.resolve(), hide: () => Promise.resolve(), menu: () => Promise.resolve() },
  });
  return { listeners, joins, status, health, redeem, updateHub, appCheck, macRead, leave, exit, openPane };
});

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  listeners.clear();
  joins.length = 0;
  status.mockImplementation(() => Promise.resolve({ kind: "fresh" }));
  health.mockClear();
  redeem.mockClear();
  updateHub.mockClear();
  appCheck.mockClear();
  macRead.mockImplementation(() => Promise.resolve(null));
  leave.mockClear();
  exit.mockClear();
  openPane.mockClear();
});
afterEach(() => {
  vi.useRealTimers();
  act(() => root.unmount());
  host.remove();
});

const settle = () => act(async () => new Promise((r) => setTimeout(r, 0)));
const titles = ["download fleetd 0.9.0, the workspace's own", "check it against the release's checksums", "put it in place", "join the workspace and start the node in this login"];
const steps = (at: number, last: JoinStep["state"] = "running"): JoinStep[] =>
  titles.map((title, i) => ({ title, state: i < at ? "done" : i === at ? last : "planned" }));
const report = (join: MacJoin) =>
  act(async () => {
    for (const listener of listeners) listener(join);
    await Promise.resolve();
  });
const shown = () => [...host.querySelectorAll("li[data-state]")].filter((li) => li.closest("ol")?.getAttribute("aria-label") !== "Steps").map((li) => li.getAttribute("data-state"));

const typeCode = async () => {
  const input = host.querySelector<HTMLInputElement>("#mac-code");
  if (input === null) throw new Error(host.textContent);
  await act(async () => {
    // React tracks the value it set; the prototype's setter is what typing goes through.
    Reflect.set(HTMLInputElement.prototype, "value", "482913", input);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await Promise.resolve();
  });
  await settle();
};

it("shows every step of the join as main reports it, not only the first", async () => {
  await act(async () => {
    root.render(
      <UiProvider>
        <MacSetup />
      </UiProvider>,
    );
    await Promise.resolve();
  });
  await typeCode();
  expect(host.textContent).toContain("Joining devbox");
  expect(joins).toHaveLength(1);
  await report({ state: "running", steps: steps(0) });
  expect(shown()).toEqual(["running", "planned", "planned", "planned"]);
  await report({ state: "running", steps: steps(1) });
  expect(shown()).toEqual(["done", "running", "planned", "planned"]);
  await report({ state: "running", steps: steps(3) });
  expect(shown()).toEqual(["done", "done", "done", "running"]);
  expect(joins).toHaveLength(1);

  // A download that failed tries the same code again, and its steps are heard again too.
  const failed: MacJoin = { state: "failed", steps: steps(0, "failed"), failure: { message: "Couldn't download fleetd." }, retry: true };
  await report(failed);
  await act(async () => {
    joins[0]?.(failed);
    await Promise.resolve();
  });
  await settle();
  const retry = [...host.querySelectorAll("button")].find((b) => b.textContent === "Try again");
  await act(async () => {
    retry?.click();
    await Promise.resolve();
  });
  await settle();
  expect(joins).toHaveLength(2);
  await report({ state: "running", steps: steps(0) });
  await report({ state: "running", steps: steps(2) });
  expect(shown()).toEqual(["done", "done", "running", "planned"]);
});

const open = async () => {
  await act(async () => {
    root.render(
      <UiProvider>
        <MacSetup />
      </UiProvider>,
    );
    await Promise.resolve();
  });
  await settle();
};

it("opened again after a cancel, says the code is spent and what to do", async () => {
  status.mockImplementation(() =>
    Promise.resolve({
      kind: "spent",
      failure: { message: "Cancelled: nothing changed on this Mac.", fix: "The code you typed is spent. For a new one, open Add machine › A Mac for agents on your main machine." },
    }),
  );
  await open();
  const notice = host.querySelector("[role='status']");
  expect(notice?.textContent).toContain("Cancelled: nothing changed on this Mac.");
  expect(notice?.textContent).toContain("The code you typed is spent.");
  expect(host.querySelector("#mac-code")).not.toBeNull();
});

const HUB = "http://devbox.example.ts.net:4790";
const FOUND = { hubUrl: HUB, hubName: "devbox", machineId: "mac", existing: true, here: { kind: "node" as const, machineId: "mac", hub: HUB } };
/** The Mac's read as the status window gets it: linked, every check green, two simulators lent. */
const joinedRead = (over: Partial<MacHealthRead> = {}): MacMenuBarRead => ({
  found: FOUND,
  hubId: null,
  health: {
    health: { user: "ada", checks: ["accessibility", "screen_recording", "screen_capture", "xcode", "ios_runtime", "tools"].map((id) => ({ id, state: "ok", message: `${id} ok` })) },
    writtenAt: Date.now(),
    checkedAt: Date.now(),
    now: Date.now(),
    hubAnswers: true,
    hubBehind: null,
    macBehind: null,
    link: { state: "linked", since: Date.now() - 60_000 },
    ...over,
  },
  activity: { simulators: [{ agent: "T12", projectId: "p1", device: "iPhone 17 Pro", sinceMs: Date.now() - 6 * 60_000 }], jobs: [] },
  disk: { freeBytes: 182e9, totalBytes: 994e9 },
  macBehind: null,
});

it("opened again on a joined Mac, it says it works as the agents' Mac, with what runs and no setup left over", async () => {
  status.mockImplementation(() => Promise.resolve({ kind: "joined", found: FOUND }));
  macRead.mockImplementation(() => Promise.resolve(joinedRead()));
  await open();
  await settle();
  expect(host.querySelector("[data-screen='mac-status']")).not.toBeNull();
  expect(host.querySelector("h1")?.textContent).toBe("Working as devbox’s agents’ Mac");
  expect(host.textContent).toContain("Connected to devbox");
  expect(host.textContent).toContain("iPhone 17 Pro");
  // Nothing of setup or Welcome: no steps, no code, no pairing.
  expect(host.querySelector("[aria-label='Steps']")).toBeNull();
  expect(host.querySelector("#mac-code")).toBeNull();
  expect(host.textContent).not.toMatch(/Is this the Mac|fleetd pair|Pairing code/u);
});

it("Stop being the agents' Mac: one confirm says what happens, then the Mac leaves its hub and Continue goes to Welcome", async () => {
  status.mockImplementation(() => Promise.resolve({ kind: "joined", found: FOUND }));
  macRead.mockImplementation(() => Promise.resolve(joinedRead()));
  await open();
  await settle();
  await act(async () => {
    button("Stop being the agents’ Mac")?.click();
    await Promise.resolve();
  });
  const confirm = host.querySelector("[role='alertdialog']");
  expect(confirm?.textContent).toContain("mac leaves devbox, its node stops and its key is deleted.");
  expect(leave).not.toHaveBeenCalled();
  await act(async () => {
    [...(confirm?.querySelectorAll("button") ?? [])].find((b) => b.textContent === "Stop being the agents’ Mac")?.click();
    await Promise.resolve();
  });
  await settle();
  expect(leave).toHaveBeenCalledTimes(1);
  expect(host.querySelector("[data-screen='mac-left']")?.textContent).toContain("mac left devbox.");
  await act(async () => {
    button("Continue")?.click();
    await Promise.resolve();
  });
  expect(exit).toHaveBeenCalledTimes(1);
});

it("Stop being the agents' Mac with the hub offline: the Mac is clean all the same, and says the hub shows it offline", async () => {
  status.mockImplementation(() => Promise.resolve({ kind: "joined", found: FOUND }));
  macRead.mockImplementation(() => Promise.resolve(joinedRead({ link: { state: "down", since: Date.now() - 120_000 } })));
  leave.mockImplementationOnce(() => Promise.resolve({ ok: true, told: "unreached", hubName: "devbox", machineId: "mac" }));
  await open();
  await settle();
  expect(host.textContent).toContain("Not connected: devbox isn’t answering");
  await act(async () => {
    button("Stop being the agents’ Mac")?.click();
    await Promise.resolve();
  });
  await act(async () => {
    [...(host.querySelector("[role='alertdialog']")?.querySelectorAll("button") ?? [])].find((b) => b.textContent === "Stop being the agents’ Mac")?.click();
    await Promise.resolve();
  });
  await settle();
  expect(host.querySelector("[data-screen='mac-left']")?.getAttribute("data-told")).toBe("unreached");
  expect(host.textContent).toContain("devbox wasn’t reached, so it shows mac offline until an admin removes it there.");
});

it("after the join, every check is a row as the node reports it, each permission with its own Allow", async () => {
  await open();
  await typeCode();
  const now = Date.now();
  health.mockImplementation(() =>
    Promise.resolve({
      health: { user: "ada", checks: [{ id: "accessibility", state: "fail", message: "fleetd doesn't have Accessibility." }, { id: "screen_recording", state: "ok", message: "ok" }, { id: "screen_capture", state: "fail", message: "macOS hasn't let fleetd capture the screen directly yet." }] },
      writtenAt: now + 500,
      checkedAt: null,
      now: now + 500,
      hubAnswers: true,
      hubBehind: null,
      link: { state: "linked", since: now + 400 },
    }),
  );
  await report({ state: "done", steps: steps(4) });
  await act(async () => {
    joins[0]?.({ state: "done", steps: steps(4) });
    await Promise.resolve();
  });
  await settle();
  await settle();
  const row = (id: string) => host.querySelector(`[data-check='${id}']`);
  expect(host.textContent).not.toContain("Waiting for its first checks");
  expect(row("node")?.getAttribute("data-state")).toBe("done");
  expect(row("link")?.getAttribute("data-state")).toBe("done");
  expect(row("accessibility")?.getAttribute("data-state")).toBe("needs_you");
  expect(row("screen_capture")?.getAttribute("data-state")).toBe("needs_you");
  expect(row("checks")?.getAttribute("data-state")).toBe("running");
  await act(async () => {
    [...(row("screen_capture")?.querySelectorAll("button") ?? [])].find((b) => b.textContent === "Allow")?.click();
    await Promise.resolve();
  });
  expect(openPane).toHaveBeenCalledWith("screen_capture");
});

const button = (label: string) => [...host.querySelectorAll("button")].find((b) => b.textContent === label);

it("an app older than the hub says so in one line, with its Update button", async () => {
  redeem.mockImplementationOnce(() =>
    Promise.resolve({
      ok: false,
      failure: { message: "This app is older than your workspace, so it can't set up this Mac.", fix: "Update the app, then type a new code from Add machine › A Mac for agents.", updateApp: true },
    }),
  );
  await open();
  await typeCode();
  const alert = host.querySelector("[role='alert']");
  expect(alert?.textContent).toContain("This app is older than your workspace");
  expect(host.textContent.toLowerCase()).not.toContain("mismatch");
  await act(async () => {
    button("Update the app")?.click();
    await Promise.resolve();
  });
  expect(appCheck).toHaveBeenCalledTimes(1);
});

const behindOn = async (who: "admin" | "member" | "unknown") => {
  status.mockImplementation(() => Promise.resolve({ kind: "joined", found: FOUND }));
  macRead.mockImplementation(() => Promise.resolve(joinedRead({ hubBehind: { hubVersion: "0.0.0-edge.202611071720+6d5a250", macVersion: "0.0.0-edge.202611071744+f893086", who } })));
  await open();
  await settle();
};

it("a hub older than this Mac's build: an admin signed in here updates it from the window", async () => {
  await behindOn("admin");
  const line = host.querySelector("[data-hub-behind]");
  expect(line?.textContent).toContain("Your workspace runs an older fleetd than this Mac.");
  expect(line?.textContent).not.toMatch(/mismatch|0\.0\.0/u);
  await act(async () => {
    button("Update the workspace")?.click();
    await Promise.resolve();
  });
  await settle();
  expect(updateHub).toHaveBeenCalledWith("http://devbox.example.ts.net:4790");
  expect(host.querySelector("[data-hub-behind]")?.textContent).toContain("Your workspace is updating.");
  expect(button("Update the workspace")).toBeUndefined();
});

it("a hub older than this Mac's build: anyone else is told who updates it, and where", async () => {
  await behindOn("member");
  expect(host.querySelector("[data-hub-behind]")?.textContent).toContain("ask an admin of the workspace to press Update in Settings › Workspace › Machines › Updates");
  expect(button("Update the workspace")).toBeUndefined();
  act(() => root.unmount());
  root = createRoot(host);
  await behindOn("unknown");
  expect(host.querySelector("[data-hub-behind]")?.textContent).toContain("On your main machine, open Settings › Workspace › Machines › Updates and press Update.");
});

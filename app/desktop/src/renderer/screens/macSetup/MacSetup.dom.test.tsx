// @vitest-environment happy-dom
// Set up this Mac for agents' window: the code traded, then the join's steps as main reports each, every report heard
// for as long as the join runs, and again after Try again.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { JoinStep } from "../../../shared/joinHere";
import type { MacHealthRead, MacJoin, MacRedeemOutcome, MacSetupStatus } from "../../../shared/macSetup";
import { UiProvider } from "../../ui";
import { MacSetup } from "./MacSetup";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { listeners, joins, status, health, redeem, updateHub, appCheck } = vi.hoisted(() => {
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
      openPane: () => Promise.resolve({ ok: true }),
      restart: () => Promise.resolve({ ok: true }),
      status,
      cancel: () => Promise.resolve(),
      updateHub,
    },
  });
  return { listeners, joins, status, health, redeem, updateHub, appCheck };
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
});
afterEach(() => {
  vi.useRealTimers();
  act(() => root.unmount());
  host.remove();
});

const settle = () => act(async () => new Promise((r) => setTimeout(r, 0)));
const titles = ["download fleetd 0.9.0, the hub's own", "check it against the release's checksums", "put it in place", "join the hub and start the node in this login"];
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

it("opened again on a joined Mac, reads its checks one at a time: a read still out skips the tick", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  const found = { hubUrl: "http://devbox.example.ts.net:4790", hubName: "devbox", machineId: "mac", existing: true, here: { kind: "none" as const } };
  status.mockImplementation(() => Promise.resolve({ kind: "joined", found }));
  let answer: (read: MacHealthRead) => void = () => undefined;
  health.mockImplementation(() => new Promise((done) => (answer = done)));
  await open();
  expect(host.textContent).toContain("Checking this Mac");
  expect(health).toHaveBeenCalledTimes(1);
  // A hub slow to answer: three ticks pass with the first read still out, and none starts another.
  await act(async () => {
    vi.advanceTimersByTime(3500);
    await Promise.resolve();
  });
  expect(health).toHaveBeenCalledTimes(1);
  await act(async () => {
    answer({ health: null, writtenAt: null, checkedAt: null, now: Date.now(), hubAnswers: false, hubBehind: null });
    await Promise.resolve();
  });
  await settle();
  await act(async () => {
    vi.advanceTimersByTime(1000);
    await Promise.resolve();
  });
  expect(health).toHaveBeenCalledTimes(2);
});

it("opened again on a node that never reports its checks: Start over goes back to a new code", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
  const found = { hubUrl: "http://devbox.example.ts.net:4790", hubName: "devbox", machineId: "mac", existing: true, here: { kind: "node" as const, machineId: "mac", hub: "http://devbox.example.ts.net:4790" } };
  status.mockImplementation(() => Promise.resolve({ kind: "joined", found }));
  await open();
  expect(host.textContent).toContain("Waiting for its first checks…");
  expect(button("Start over with a new code")).toBeUndefined();
  await act(async () => {
    vi.advanceTimersByTime(46_000);
    await Promise.resolve();
  });
  expect(host.textContent).toContain("start over with a new code");
  expect(button("Restart the node")).toBeDefined();
  await act(async () => {
    button("Start over with a new code")?.click();
    await Promise.resolve();
  });
  await settle();
  expect(host.querySelector("[data-step='code']")).not.toBeNull();
  vi.useRealTimers();
  await typeCode();
  expect(redeem).toHaveBeenCalledTimes(1);
});

const button = (label: string) => [...host.querySelectorAll("button")].find((b) => b.textContent === label);

it("an app older than the hub says so in one line, with its Update button", async () => {
  redeem.mockImplementationOnce(() =>
    Promise.resolve({
      ok: false,
      failure: { message: "This app is older than your hub, so it can't set up this Mac.", fix: "Update the app, then type a new code from Add machine › A Mac for agents.", updateApp: true },
    }),
  );
  await open();
  await typeCode();
  const alert = host.querySelector("[role='alert']");
  expect(alert?.textContent).toContain("This app is older than your hub");
  expect(host.textContent.toLowerCase()).not.toContain("mismatch");
  await act(async () => {
    button("Update the app")?.click();
    await Promise.resolve();
  });
  expect(appCheck).toHaveBeenCalledTimes(1);
});

const behindOn = async (who: "admin" | "member" | "unknown") => {
  const found = { hubUrl: "http://devbox.example.ts.net:4790", hubName: "devbox", machineId: "mac", existing: true, here: { kind: "none" as const } };
  status.mockImplementation(() => Promise.resolve({ kind: "joined", found }));
  health.mockImplementation(() =>
    Promise.resolve({
      health: { user: "ada", checks: [{ id: "accessibility", state: "ok", message: "ok" }, { id: "screen_recording", state: "ok", message: "ok" }] },
      writtenAt: Date.now(),
      checkedAt: Date.now(),
      now: Date.now(),
      hubAnswers: true,
      hubBehind: { hubVersion: "0.0.0-edge.202611071720+6d5a250", macVersion: "0.0.0-edge.202611071744+f893086", who },
    }),
  );
  await open();
  await settle();
};

it("a hub older than this Mac's build: an admin signed in here updates it from the window", async () => {
  await behindOn("admin");
  const line = host.querySelector("[data-hub-behind]");
  expect(line?.textContent).toContain("Your hub runs an older fleetd than this Mac.");
  expect(line?.textContent).not.toMatch(/mismatch|0\.0\.0/u);
  await act(async () => {
    button("Update the hub")?.click();
    await Promise.resolve();
  });
  await settle();
  expect(updateHub).toHaveBeenCalledWith("http://devbox.example.ts.net:4790");
  expect(host.querySelector("[data-hub-behind]")?.textContent).toContain("Your hub is updating.");
  expect(button("Update the hub")).toBeUndefined();
});

it("a hub older than this Mac's build: anyone else is told who updates it, and where", async () => {
  await behindOn("member");
  expect(host.querySelector("[data-hub-behind]")?.textContent).toContain("ask an admin of the hub to press Update in Settings › Hub › Machines › Updates");
  expect(button("Update the hub")).toBeUndefined();
  act(() => root.unmount());
  root = createRoot(host);
  await behindOn("unknown");
  expect(host.querySelector("[data-hub-behind]")?.textContent).toContain("On your main machine, open Settings › Hub › Machines › Updates and press Update.");
});

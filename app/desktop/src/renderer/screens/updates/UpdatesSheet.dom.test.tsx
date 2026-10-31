// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UpdatePart, UpdateRun } from "../../../shared/contracts";
import { UiProvider } from "../../ui";
import type { Flow } from "./flow";
import { STALE_MS, updatesView } from "./model";
import { UpdatesSheet } from "./UpdatesSheet";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const OLDER = "0.0.0-edge.202610201030+0001111";
const NEXT = "0.0.0-edge.202610231030+def5678";
const p = (over: Partial<UpdatePart>): UpdatePart => ({ part: "node", name: "builder", from: OLDER, state: "done", ...over });
const run: UpdateRun = {
  id: "U1",
  channel: "edge",
  to: NEXT,
  startedAt: "2026-10-26T10:00:00.000Z",
  finishedAt: "2026-10-26T10:03:00.000Z",
  parts: [
    p({ part: "hub", name: "the hub" }),
    p({ machineId: "builder", name: "builder", state: "failed", stage: "download", message: "couldn't download `fleetd-darwin-arm64`: 503" }),
    p({ machineId: "devbox", name: "devbox" }),
  ],
};
const view = updatesView({
  app: { current: NEXT, app: { kind: "current" }, release: null },
  hub: { url: "http://devbox:4790", version: NEXT },
  machines: [
    { machineId: "builder", name: "builder", nodeVersion: OLDER, online: true },
    { machineId: "devbox", name: "devbox", nodeVersion: NEXT, online: true },
  ],
  run,
  flow: { phase: "finished", updated: false },
  now: Date.parse("2026-10-26T10:04:00.000Z"),
});

const text = (el: Element | null) => el?.textContent ?? "";

describe("the updates sheet", () => {
  it("shows one line per part, Retry on the failed one, and the steps only behind Details", () => {
    const onRetry = vi.fn();
    act(() =>
      root.render(
        <UiProvider>
          <UpdatesSheet view={view} onUpdate={vi.fn()} onStartOver={vi.fn()} onUpdateNow={vi.fn()} onRetry={onRetry} onApp={vi.fn()} />
        </UiProvider>,
      ),
    );
    const lines = [...host.querySelectorAll("[data-updates-line-of]")].map((l) => l.getAttribute("data-updates-line-of"));
    expect(lines).toEqual(["hub", "builder", "devbox", "app"]);
    expect(text(host.querySelector('[data-updates-line-of="builder"]'))).toBe("builderFailedCouldn't download the new buildRetry");
    expect(text(host.querySelector('[role="alert"]'))).toBe("Update failed: builder. The rest updated; Retry tries it again.");
    // One Retry, on the failed machine; the hub's words wait behind Details.
    const retry = [...host.querySelectorAll("button")].filter((b) => b.textContent === "Retry");
    expect(retry).toHaveLength(1);
    act(() => retry[0]?.click());
    expect(onRetry).toHaveBeenCalledWith({ kind: "machine", machineId: "builder" });
    expect(host.querySelector("[data-updates-details]")).toBeNull();

    const details = [...host.querySelectorAll("button")].find((b) => b.textContent === "Details");
    expect(details?.getAttribute("aria-expanded")).toBe("false");
    act(() => details?.click());
    expect(details?.getAttribute("aria-expanded")).toBe("true");
    expect(text(host.querySelector('[data-updates-row="builder"]'))).toContain("Failed while downloading: couldn't download fleetd-darwin-arm64: 503");
  });
});

/** The devbox's story: the hub updated, mac too, and the devbox waits on a session that will never end. */
const stuck: UpdateRun = {
  id: "U2",
  channel: "edge",
  to: NEXT,
  startedAt: "2026-10-26T11:00:00.000Z",
  parts: [
    p({ part: "hub", name: "the hub" }),
    p({ machineId: "devbox", name: "devbox", state: "waiting", message: "waits until it's idle: 1 live session can't carry on through a restart" }),
    p({ machineId: "mac", name: "mac" }),
  ],
};
const AT = Date.parse("2026-10-26T12:00:00.000Z");
const following = (flow: Partial<Extract<Flow, { phase: "following" }>>, r: UpdateRun = stuck) =>
  updatesView({
    app: { current: NEXT, app: { kind: "current" }, release: null },
    hub: { url: "http://devbox:4790", version: NEXT },
    machines: [
      { machineId: "devbox", name: "devbox", nodeVersion: OLDER, online: true },
      { machineId: "mac", name: "mac", nodeVersion: NEXT, online: true },
    ],
    run: r,
    flow: { phase: "following", reconnecting: false, since: AT, ...flow },
    now: AT + STALE_MS + 60_000,
  });

const startOverButton = () => [...host.querySelectorAll("button")].find((b) => b.textContent === "Start over");
const sheet = (v: ReturnType<typeof updatesView>, onStartOver = vi.fn(), onUpdateNow = vi.fn()) =>
  act(() =>
    root.render(
      <UiProvider>
        <UpdatesSheet view={v} onUpdate={vi.fn()} onStartOver={onStartOver} onUpdateNow={onUpdateNow} onRetry={vi.fn()} onApp={vi.fn()} />
      </UiProvider>,
    ),
  );

describe("Start over", () => {
  it("shows quietly beside a run that hasn't changed for a while, and starts a new one", () => {
    const onStartOver = vi.fn();
    sheet(following({}), onStartOver);
    expect(text(host.querySelector('[role="status"]'))).toBe("Updating the machines: 1 of 2 done");
    expect(text(host.querySelector("[data-updates-start-over]"))).toBe("Nothing has changed for 11 minutes. Start over ends this update and starts a new one.");
    expect(text(host.querySelector('[data-updates-line-of="devbox"]'))).toContain("Waiting");
    act(() => startOverButton()?.click());
    expect(onStartOver).toHaveBeenCalledOnce();
    // The one Update button stays away while the run goes on.
    expect([...host.querySelectorAll("button")].some((b) => b.textContent === "Update")).toBe(false);
  });

  it("shows at once when nothing in the hub drives the run any more", () => {
    sheet(following({ since: AT + STALE_MS, leftOver: true }));
    expect(text(host.querySelector("[data-updates-start-over]"))).toBe("Nothing in the hub drives this update any more. Start over ends it and starts a new one.");
    expect(startOverButton()).toBeDefined();
  });

  it("stays away from a run that moves, the hub's restart, and a run that ended", () => {
    sheet(following({ since: AT + STALE_MS }));
    expect(startOverButton()).toBeUndefined();
    sheet(following({ reconnecting: true, leftOver: true }));
    expect(startOverButton()).toBeUndefined();
    const restarting: UpdateRun = { ...stuck, parts: [p({ part: "hub", name: "the hub", state: "restarting" }), ...stuck.parts.slice(1)] };
    sheet(following({ leftOver: true }, restarting));
    expect(startOverButton()).toBeUndefined();
    sheet(following({ leftOver: true }, run));
    expect(startOverButton()).toBeUndefined();
    expect(host.querySelector("[data-updates-start-over]")).toBeNull();
  });
});

describe("Update now", () => {
  it("shows beside machines waiting for their agents' step, and ends the wait", () => {
    const draining: UpdateRun = {
      ...stuck,
      parts: [
        p({ part: "hub", name: "the hub" }),
        p({ machineId: "devbox", name: "devbox", state: "waiting", agents: 2, installsBy: "2026-10-26T12:10:00.000Z", message: "waits for 2 agents to finish their step" }),
        p({ machineId: "mac", name: "mac" }),
      ],
    };
    const onUpdateNow = vi.fn();
    sheet(following({ since: AT + STALE_MS }, draining), vi.fn(), onUpdateNow);
    expect(text(host.querySelector('[role="status"]'))).toMatch(/^Updating when agents finish their step \(2\), by \d\d:\d\d$/u);
    const now = host.querySelector<HTMLButtonElement>("[data-updates-now]");
    expect(now?.textContent).toBe("Update now");
    act(() => now?.click());
    expect(onUpdateNow).toHaveBeenCalledOnce();

    sheet(following({ since: AT + STALE_MS }, { ...draining, now: true }));
    expect(host.querySelector("[data-updates-now]")).toBeNull();
  });
});

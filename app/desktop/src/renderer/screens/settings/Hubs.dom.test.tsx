// @vitest-environment happy-dom
// Settings › You › Hubs & devices › Restart hub: an admin of the hub has the button on its row and a member has none; it asks
// first, saying what a restart does; confirmed, it calls hub_restart, the row says Restarting the hub… until the hub
// has been away and is back, then how many leads start again; a refusal shows with its fix; a hub that never goes away
// is said to be still up.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { CallOutcome, HubFrame } from "../../../shared/hub";
import { createDataLayer, type HubApi } from "../../src/data/queries";
import { DataProvider } from "../../src/data/react";
import { UiProvider } from "../../ui";
import { HubsSettings } from "./Hubs";
import { RESTART_WAIT_MS } from "./hubRestart";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.hoisted(() => {
  (globalThis as { fleetd?: unknown }).fleetd = { platform: "linux" };
});

const HUB = "http://devbox.tail1234.ts.net:4790";
const LIVE: HubFrame = { t: "state", state: { phase: "live", hub: HUB, protocol: 1 } };

let host: HTMLDivElement;
let root: Root;
let calls: string[];
let restart: () => Promise<CallOutcome>;
let send: (frame: HubFrame) => void;

beforeEach(() => {
  calls = [];
  restart = () => Promise.resolve({ ok: true, output: { leads: 0, next: "The hub restarts now." } });
  vi.stubGlobal("fleetd", { platform: "linux", fixture: null, pair: { store: () => Promise.resolve({ kind: "os" }) } });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const settle = () => act(async () => new Promise((r) => setTimeout(r, 0)));

/** Settings › You › Hubs & devices on a connected hub; `admin`: what hub_info says of this app's person. */
const render = async (admin: boolean) => {
  send = () => undefined;
  const hub: HubApi = {
    call: (tool) => {
      calls.push(tool);
      if (tool === "hub_info") return Promise.resolve({ ok: true, output: { version: "0.0.0", protocol: 1, busy: [], admin } });
      if (tool === "hub_restart") return restart();
      return Promise.resolve({ ok: true, output: {} });
    },
    subscribe: (l) => ((send = l), () => undefined),
    resync: () => Promise.resolve(),
    focus: () => Promise.resolve(),
    chat: () => Promise.resolve(),
  };
  await act(async () => {
    root.render(
      <UiProvider>
        <DataProvider layer={createDataLayer(hub)}>
          <HubsSettings />
        </DataProvider>
      </UiProvider>,
    );
    await Promise.resolve();
  });
  await act(async () => {
    send(LIVE);
    send({ t: "snapshot", snapshot: { cursor: 1, attention: [], machines: [], projects: [] } });
    await new Promise((r) => setTimeout(r, 0));
  });
  for (let i = 0; i < 3; i++) await settle();
};

const find = (text: string, within: ParentNode = document.body) => [...within.querySelectorAll("button")].find((x) => x.textContent.trim() === text);
const button = (text: string, within: ParentNode = document.body) => {
  const b = find(text, within);
  if (b === undefined) throw new Error(`no button ${text}`);
  return b;
};
const click = async (el: HTMLElement) => {
  await act(async () => {
    el.click();
    await Promise.resolve();
  });
  await settle();
};
const must = <T,>(found: T | null | undefined, what: string): T => {
  if (found === null || found === undefined) throw new Error(`no ${what}`);
  return found;
};
const row = () => must(host.querySelector<HTMLElement>("section[aria-label='Hub']"), "hub row");
const dialog = () => must(document.body.querySelector<HTMLElement>("[role='dialog'], [role='alertdialog']"), "dialog");
const alert = () => must(row().querySelector("[role='alert']"), "alert");
const state = async (frame: HubFrame) => {
  await act(async () => {
    send(frame);
    await Promise.resolve();
  });
  await settle();
};
const restarts = () => calls.filter((c) => c === "hub_restart").length;

it("shows Restart hub to an admin of the hub, and nothing of it to a member", async () => {
  await render(false);
  expect(row().textContent).toContain("Connected.");
  expect(find("Restart hub…")).toBeUndefined();
  expect(button("Disconnect and forget key")).toBeDefined();
  act(() => root.unmount());
  root = createRoot(host);
  await render(true);
  expect(button("Restart hub…", row())).toBeDefined();
});

it("asks first, then restarts: the row says so until the hub has been away and is back", async () => {
  await render(true);
  await click(button("Restart hub…"));
  const asked = dialog();
  expect(asked.textContent).toContain("Restart the hub?");
  expect(asked.textContent).toContain("It is back in about a second, and running agents carry on.");
  expect(asked.textContent).toContain("A lead whose profile changed since it started comes back on the current one");
  await click(button("Cancel", asked));
  expect(restarts()).toBe(0);
  expect(row().textContent).toContain("Connected.");

  restart = () => Promise.resolve({ ok: true, output: { leads: 2 } });
  await click(button("Restart hub…"));
  await click(button("Restart", dialog()));
  expect(restarts()).toBe(1);
  expect(row().textContent).toContain("Restarting the hub…");
  // No second restart while one goes.
  expect(button("Restart hub…").disabled).toBe(true);

  await state({ t: "state", state: { phase: "connecting", hub: HUB, attempt: 1, restarting: Date.now() } });
  expect(row().textContent).toContain("Restarting the hub…");
  await state(LIVE);
  expect(row().textContent).toContain("Restarted. Connected. 2 leads start again on the current lead profile, each once it is idle.");
  expect(button("Restart hub…").disabled).toBe(false);
});

it("counts a call the restart itself cut off as taken", async () => {
  await render(true);
  let answer: (out: CallOutcome) => void = () => undefined;
  restart = () => new Promise((done) => (answer = done));
  await click(button("Restart hub…"));
  await click(button("Restart", dialog()));
  expect(row().textContent).toContain("Restarting the hub…");
  // Away and back before the call's own end was read.
  await state({ t: "state", state: { phase: "connecting", hub: HUB, attempt: 1, restarting: Date.now() } });
  await state(LIVE);
  await act(async () => {
    answer({ ok: false, error: { code: "disconnected", message: "The hub connection closed before it answered." } });
    await Promise.resolve();
  });
  await settle();
  expect(row().textContent).toContain("Restarted. Connected.");
  expect(row().querySelector("[role='alert']")).toBeNull();
});

it("shows a refusal with its fix, and a hub older than the button", async () => {
  await render(true);
  restart = () =>
    Promise.resolve({
      ok: false,
      error: { code: "failed", message: "The hub doesn't run as the service `fleetd init` sets up, so it can't restart itself.", fix: "Restart it on its machine: stop `fleetd hub start` there and start it again." },
    });
  await click(button("Restart hub…"));
  await click(button("Restart", dialog()));
  expect(alert().textContent).toBe("The hub doesn't run as the service fleetd init sets up, so it can't restart itself. Restart it on its machine: stop fleetd hub start there and start it again.");
  // The connection's own line stays, and it can be tried again.
  expect(row().textContent).toContain("Connected.");
  expect(button("Restart hub…").disabled).toBe(false);

  restart = () => Promise.resolve({ ok: false, error: { code: "not_found", message: "No tool hub_restart." } });
  await click(button("Restart hub…"));
  await click(button("Restart", dialog()));
  expect(alert().textContent).toBe("This hub runs a fleetd from before Restart hub. Update fleetd on it first.");
});

it("says so when the hub took the restart but never went away", async () => {
  await render(true);
  vi.useFakeTimers();
  await act(async () => {
    button("Restart hub…").click();
    await Promise.resolve();
  });
  await act(async () => {
    button("Restart", dialog()).click();
    await vi.advanceTimersByTimeAsync(10);
  });
  expect(row().textContent).toContain("Restarting the hub…");
  await act(async () => {
    await vi.advanceTimersByTimeAsync(RESTART_WAIT_MS);
  });
  expect(alert().textContent).toBe("The hub took the restart but is still up. Try again, or restart its service on the hub's machine.");
});

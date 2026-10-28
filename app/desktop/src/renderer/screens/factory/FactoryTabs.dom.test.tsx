// @vitest-environment happy-dom
// The Factory's tabs: Output and Agent time, each its own route; a hub from before metrics has Agent time alone.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { HubError } from "../../../shared/hub";
import { createDataLayer, type HubApi } from "../../src/data/queries";
import { DataProvider } from "../../src/data/react";
import { live, snapshot } from "../../src/data/fixtures.test-util";
import { parseHash } from "../shell/routes";
import { FactoryTabs, type FactoryTab } from "./FactoryTabs";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.useFakeTimers();
  window.location.hash = "";
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
});

/** The tabs on `tab`, on a hub that answers the metrics probe with `answer`. */
const mount = async (tab: FactoryTab, answer: { ok: true; output: unknown } | { ok: false; error: HubError }) => {
  let send: Parameters<HubApi["subscribe"]>[0] = () => undefined;
  const hub: HubApi = {
    call: (tool) => Promise.resolve(tool === "metrics_get" ? answer : { ok: true, output: { at: "2026-10-19T09:03:00.000Z", orders: [], trains: [] } }),
    subscribe: (l) => ((send = l), () => undefined),
    resync: () => Promise.resolve(),
    focus: () => Promise.resolve(),
    chat: () => Promise.resolve(),
  };
  act(() => {
    root.render(
      <DataProvider layer={createDataLayer(hub)}>
        <FactoryTabs tab={tab} />
      </DataProvider>,
    );
  });
  await act(async () => {
    send(live());
    send(snapshot(1));
    await vi.advanceTimersByTimeAsync(0);
  });
};

const tabs = () => [...host.querySelectorAll<HTMLButtonElement>("button")];

it("switches between Output and Agent time by their routes", async () => {
  await mount("output", { ok: false, error: { code: "invalid", message: "invalid" } });
  expect(tabs().map((b) => [b.textContent, b.getAttribute("aria-pressed")])).toEqual([
    ["Output", "true"],
    ["Agent time", "false"],
  ]);
  act(() => tabs()[1]?.click());
  expect(window.location.hash).toBe("#/factory/time");
  expect(parseHash(window.location.hash)).toEqual({ id: "time", orderId: null });

  await mount("time", { ok: false, error: { code: "invalid", message: "invalid" } });
  act(() => tabs()[0]?.click());
  expect(parseHash(window.location.hash)).toEqual({ id: "factory", project: null });
});

it("shows no tabs on a hub from before metrics: its Factory is Agent time alone", async () => {
  await mount("time", { ok: false, error: { code: "not_found", message: "not_found" } });
  expect(tabs()).toEqual([]);
});

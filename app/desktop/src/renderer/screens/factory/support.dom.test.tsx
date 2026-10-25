// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { HubError } from "../../../shared/hub";
import { createDataLayer, type HubApi } from "../../src/data/queries";
import { DataProvider } from "../../src/data/react";
import { live, snapshot } from "../../src/data/fixtures.test-util";
import { metricsSupport, useMetricsSupport } from "./support";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.useFakeTimers();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
});

const error = (code: HubError["code"]): { ok: false; error: HubError } => ({ ok: false, error: { code, message: code } });

it("reads the probe: a hub with the tool refuses the empty input, one without has no such tool", () => {
  expect(metricsSupport({ ok: true })).toBe(true);
  expect(metricsSupport(error("invalid"))).toBe(true);
  expect(metricsSupport(error("not_found"))).toBe(false);
  // A timeout or a dropped link says nothing: ask again on the next connection.
  expect(metricsSupport(error("timeout"))).toBeUndefined();
  expect(metricsSupport(error("disconnected"))).toBeUndefined();
});

/** What useMetricsSupport says on a hub that answers metrics_get with `answer`, and what it was asked. */
const probe = async (answer: { ok: true; output: unknown } | { ok: false; error: HubError }) => {
  const inputs: unknown[] = [];
  let send: Parameters<HubApi["subscribe"]>[0] = () => undefined;
  const hub: HubApi = {
    call: (tool, input) => {
      if (tool === "metrics_get") inputs.push(input);
      return Promise.resolve(tool === "metrics_get" ? answer : { ok: true, output: { at: "2026-10-19T09:03:00.000Z", orders: [], trains: [] } });
    },
    subscribe: (l) => ((send = l), () => undefined),
    resync: () => Promise.resolve(),
    focus: () => Promise.resolve(),
    chat: () => Promise.resolve(),
  };
  let seen: boolean | undefined | "unset" = "unset";
  function Probe() {
    seen = useMetricsSupport();
    return null;
  }
  act(() => {
    root.render(
      <DataProvider layer={createDataLayer(hub)}>
        <Probe />
      </DataProvider>,
    );
  });
  // Before a connection nothing is asked, and the Factory stays.
  expect(seen).toBeUndefined();
  expect(inputs).toEqual([]);
  await act(async () => {
    send(live());
    send(snapshot(1));
    await vi.advanceTimersByTimeAsync(0);
  });
  return { seen, inputs };
};

it("hides the Factory on a hub that doesn't know metrics_get, asking once with an input that runs nothing", async () => {
  const { seen, inputs } = await probe(error("not_found"));
  expect(seen).toBe(false);
  expect(inputs).toEqual([{}]);
});

it("keeps it on a hub that has the tool, and when the hub couldn't say", async () => {
  expect((await probe(error("invalid"))).seen).toBe(true);
  act(() => root.unmount());
  root = createRoot(host);
  expect((await probe(error("timeout"))).seen).toBeUndefined();
});

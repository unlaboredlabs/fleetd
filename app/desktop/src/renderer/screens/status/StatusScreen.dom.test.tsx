// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ProjectStatusRow } from "../../../shared/contracts";
import { createDataLayer, type HubApi } from "../../src/data/queries";
import { DataProvider } from "../../src/data/react";
import { live, project, snapshot } from "../../src/data/fixtures.test-util";
import { TooltipProvider } from "../../ui/primitives/Tooltip";
import { StatusScreen } from "./StatusScreen";

// 23:59 local: a merge at 23:50 is "today" now and "yesterday" a minute later.
const START = new Date(2026, 9, 19, 23, 59).getTime();
const iso = (ms: number) => new Date(ms).toISOString();

const row: ProjectStatusRow = {
  projectRef: { ...project },
  title: "storefront",
  state: "idle",
  agentsRunning: 0,
  lastMerged: { title: "Receipt dates use Intl", prNumber: 214, at: iso(new Date(2026, 9, 19, 23, 50).getTime()) },
  stale: { since: iso(START - 9 * 60_000), reason: "no heartbeat from devbox" },
  asOf: iso(START),
};

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
const calls: string[] = [];

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(START);
  calls.length = 0;
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
});

type Send = Parameters<HubApi["subscribe"]>[0];

/** Status on a hub that answers once, already showing the row. Returns the hub's sender. */
const mount = async (): Promise<Send> => {
  let send: Send = () => undefined;
  const hub: HubApi = {
    call: (tool) => {
      calls.push(tool);
      return Promise.resolve({ ok: true, output: tool === "status_projects" ? { rows: [row] } : { at: iso(START), orders: [], trains: [] } });
    },
    subscribe: (l) => ((send = l), () => undefined),
    resync: () => Promise.resolve(),
    live: () => Promise.resolve(),
    chat: () => Promise.resolve(),
  };
  const layer = createDataLayer(hub);
  act(() => {
    root.render(
      <DataProvider layer={layer}>
        <TooltipProvider>
          <StatusScreen />
        </TooltipProvider>
      </DataProvider>,
    );
  });
  await act(async () => {
    send(live());
    send(snapshot(1));
    await vi.advanceTimersByTimeAsync(0);
  });
  return send;
};

const label = () => host.querySelector("a[aria-label^='storefront:']")?.getAttribute("aria-label") ?? "";

it("moves its day words and ages on with the clock, with no event and no refetch", async () => {
  await mount();
  expect(label()).toContain("last merged today 23:50");
  expect(label()).toContain("Out of date for 9m");
  const asked = calls.filter((c) => c === "status_projects").length;

  // The clock ticks just after each second turns.
  await act(() => vi.advanceTimersByTimeAsync(60_000 + 10));
  expect(label()).toContain("last merged yesterday 23:50");
  expect(label()).toContain("Out of date for 10m");

  await act(() => vi.advanceTimersByTimeAsync(3 * 3_600_000));
  expect(label()).toContain("Out of date for 3h");
  // The words moved on the clock alone: nothing asked the hub again.
  expect(calls.filter((c) => c === "status_projects").length).toBe(asked);
});

it("reads the day and the age on the hub's clock, not this machine's", async () => {
  const send = await mount();
  // The hub's clock runs two minutes ahead: past its midnight, while this machine still reads 23:59.
  await act(async () => {
    send({ t: "live", frame: { at: iso(START + 2 * 60_000), full: true, lanes: [] } });
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(label()).toContain("last merged yesterday 23:50");
  expect(label()).toContain("Out of date for 11m");
});

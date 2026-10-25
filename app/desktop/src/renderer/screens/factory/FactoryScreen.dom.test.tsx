// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { MetricsGetInput, MetricsGetOutput } from "../../../shared/contracts";
import { createDataLayer, type HubApi } from "../../src/data/queries";
import { DataProvider } from "../../src/data/react";
import { event, live, project, snapshot } from "../../src/data/fixtures.test-util";
import { TooltipProvider } from "../../ui/primitives/Tooltip";
import { FactoryScreen } from "./FactoryScreen";
import { metricsAnswer } from "./fixture";
import type { ProjectKey } from "../shell/routes";

const NOW = Date.parse("2026-10-19T09:03:00.000Z");
const projects = [{ ...project, title: "storefront" }];

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
let asked: MetricsGetInput[];

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  asked = [];
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

/** The screen on a hub whose metrics_get gives `answer(input)`. */
const mount = async (answer: (input: MetricsGetInput) => MetricsGetOutput, scope: ProjectKey | null = null): Promise<Send> => {
  let send: Send = () => undefined;
  const hub: HubApi = {
    call: (tool, input) => {
      if (tool === "metrics_get") {
        asked.push(input as MetricsGetInput);
        return Promise.resolve({ ok: true, output: answer(input as MetricsGetInput) });
      }
      return Promise.resolve({ ok: true, output: { at: new Date(NOW).toISOString(), orders: [], trains: [] } });
    },
    subscribe: (l) => ((send = l), () => undefined),
    resync: () => Promise.resolve(),
    focus: () => Promise.resolve(),
    chat: () => Promise.resolve(),
  };
  act(() => {
    root.render(
      <DataProvider layer={createDataLayer(hub)}>
        <TooltipProvider>
          <FactoryScreen project={scope} now={NOW} initialFilters={{ range: "month", compare: false }} />
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

const screen = () => host.querySelector("[data-screen]")?.getAttribute("data-screen");
const text = () => host.textContent;

it("shows the four tiles, the projects table and every merge for all projects", async () => {
  const out = metricsAnswer({ now: new Date(NOW).toISOString(), projects });
  await mount(() => out);
  expect(screen()).toBe("factory");
  for (const label of ["Merged per day", "Order to merged", "Your minutes per merged PR", "Through fleetd"]) {
    expect(host.querySelector(`[role="group"][aria-label="${label}"]`)).not.toBeNull();
  }
  expect(text()).toContain(`${out.tiles.merged.n} in 30 days`);
  expect(text()).toContain("Projects");
  expect(host.querySelectorAll("#factory-list ~ * tbody tr, section[aria-labelledby='factory-list'] tbody tr")).toHaveLength(Math.min(100, out.merges.length));
  expect(asked[0]).toMatchObject({ compare: false });
  expect(asked[0]?.projectRef).toBeUndefined();
});

it("asks for the route's project, and leaves out the projects table", async () => {
  await mount((input) => metricsAnswer({ now: new Date(NOW).toISOString(), projects, ...(input.projectRef === undefined ? {} : { project: input.projectRef }) }), project);
  expect(asked[0]?.projectRef).toEqual({ machineId: project.machineId, projectId: project.projectId });
  expect(host.querySelector("section[aria-labelledby='factory-repos']")).toBeNull();
});

it("says there were no merges in the range, and why a read stopped, never a silent zero", async () => {
  const out = metricsAnswer({ now: new Date(NOW).toISOString(), projects, none: true });
  out.coverage.stale.push({ repo: "github.com/acme/storefront", since: new Date(NOW - 3_600_000).toISOString(), reason: "fleetd hasn't read GitHub for acme/storefront since 08:03: gh is signed out" });
  await mount(() => out);
  expect(screen()).toBe("factory.empty");
  expect(text()).toContain("No merges in this range.");
  expect(text()).toContain("gh is signed out. Its figures stop there.");
  expect(host.querySelector("section[aria-labelledby='factory-list']")).toBeNull();
});

it("asks again when a merge lands", async () => {
  const send = await mount(() => metricsAnswer({ now: new Date(NOW).toISOString(), projects }));
  const before = asked.length;
  await act(async () => {
    send(event(2, "pr.merged", { repo: "acme/storefront", prNumber: 300 }));
    await vi.advanceTimersByTimeAsync(1_000);
  });
  expect(asked.length).toBeGreaterThan(before);
});

// @vitest-environment happy-dom
// Where a chip lands: a finished agent shows what it ended with (its title, how it ended, its PR, its last words), and
// an order shows its agents, at work and finished, and its PRs, never an empty page.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AgentLane, OrderCard, Task } from "../../../shared/contracts";
import { createDataLayer, type HubApi } from "../../src/data/queries";
import { DataProvider, useToolQuery } from "../../src/data/react";
import { AT, live, project, snapshot } from "../../src/data/fixtures.test-util";
import { preloadMarkdown } from "../../ui";
import { TooltipProvider } from "../../ui/primitives/Tooltip";
import { AgentsPane } from "./AgentsPane";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const finished: Task = {
  taskId: "T5945",
  title: "Get started home",
  kind: "write",
  state: "done",
  attempt: 1,
  createdAt: AT,
  endedAt: AT,
  projectRef: project,
  workstreamId: "W890",
  prompt: "Build it",
  pr: "https://github.com/acme/storefront/pull/41",
  result: { status: "done", tail: "Done: the home page shows the cloud's next step.", at: AT },
};
const lane = (laneId: string, title: string, status: AgentLane["status"]): AgentLane => ({ laneId, taskId: laneId, title, status, role: "implementer" });
const launch: OrderCard = {
  workstreamId: "W890",
  title: "Launch readiness",
  createdAt: AT,
  updatedAt: AT,
  lanes: [lane("T5946", "Pricing page", "working")],
  needsYou: 0,
  phase: "working",
  projectRef: project,
  prs: [{ changeId: "X1", number: 41, repo: "acme/storefront", reviewsDone: 1, reviewsNeeded: 1, state: "queued", url: "https://github.com/acme/storefront/pull/41" }],
  settled: 1,
  state: "open",
  total: 2,
};

// The panel reads the agents list whatever pane is open (panel/panes.tsx); an agent's view waits for it.
const ALL = {} as const;
function Panel({ agent }: { agent: string }) {
  useToolQuery("agents_list", ALL);
  return <AgentsPane project={project} agent={agent} />;
}

let host: HTMLDivElement;
let root: Root | undefined;
let send: Parameters<HubApi["subscribe"]>[0] = () => undefined;

beforeEach(() => {
  vi.stubGlobal("fleetd", { platform: "darwin", fixture: null });
  host = document.createElement("div");
  document.body.appendChild(host);
});
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  host.remove();
  vi.unstubAllGlobals();
});

const settle = async () => {
  for (let i = 0; i < 5; i++) await act(() => new Promise((done) => setTimeout(done, 0)));
};

const mount = async (agent: string) => {
  const hub: HubApi = {
    call: (tool, input) => {
      if (tool === "agents_list") return Promise.resolve({ ok: true, output: { at: AT, agents: [] } });
      if (tool === "orders_board") return Promise.resolve({ ok: true, output: { at: AT, orders: [launch], trains: [] } });
      if (tool === "task_get") {
        const id = (input as { taskId: string }).taskId;
        return Promise.resolve(id === finished.taskId ? { ok: true, output: { task: finished } } : { ok: false, error: { code: "not_found", message: `No task ${id}.` } });
      }
      if (tool === "order_get") return Promise.resolve({ ok: true, output: { order: launch, doneLanes: [lane("T5945", "Get started home", "done")], requests: [] } });
      return Promise.resolve({ ok: false, error: { code: "not_found", message: "none" } });
    },
    subscribe: (l) => ((send = l), () => undefined),
    resync: () => Promise.resolve(),
    focus: () => Promise.resolve(),
    chat: () => Promise.resolve(),
  };
  root = createRoot(host);
  act(() => {
    root?.render(
      <DataProvider layer={createDataLayer(hub)}>
        <TooltipProvider>
          <Panel agent={agent} />
        </TooltipProvider>
      </DataProvider>,
    );
  });
  act(() => {
    send(live());
    send(snapshot(1));
  });
  await settle();
};

it("shows a finished agent's title, how it ended, its PR and its last words", async () => {
  preloadMarkdown();
  await mount("T5945");
  await vi.waitFor(async () => {
    await settle();
    expect(host.querySelector("[data-screen='agents.work.finished']")?.textContent).toContain("the home page shows the cloud");
  });
  const view = host.querySelector("[data-screen='agents.work.finished']")?.textContent ?? "";
  expect(view).toContain("Get started home");
  expect(view).toContain("Finished");
  expect(view).toContain("PR #41");
  expect(view).not.toContain("isn’t running");
});

it("says plainly when the agent is gone", async () => {
  await mount("T404");
  expect(host.textContent).toContain("This agent isn’t here");
});

it("shows an order with its agents at work and finished, each opening it, and its PRs", async () => {
  await mount("W890");
  const view = host.querySelector("[data-screen='agents.order']");
  expect(view?.querySelector("h2")?.textContent).toBe("Launch readiness");
  const links = [...(view?.querySelectorAll("a") ?? [])].map((a) => [a.textContent, a.getAttribute("href")]);
  expect(links).toEqual([
    ["Pricing pageworking", "#/project/devbox/storefront/agents/T5946"],
    ["Get started homedone", "#/project/devbox/storefront/agents/T5945"],
    ["PR #41acme/storefront", "#/project/devbox/storefront/prs/acme/storefront/41"],
  ]);
});

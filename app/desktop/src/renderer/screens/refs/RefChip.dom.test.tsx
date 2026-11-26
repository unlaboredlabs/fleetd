// @vitest-environment happy-dom
// fleetd's ids in words a person reads show as chips with the thing's name as the workspace has it now, opening it;
// one that is gone says its plain word; the id stays in the tooltip and the menu, never the words.
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { OrderCard, Task } from "../../../shared/contracts";
import { createDataLayer, type HubApi } from "../../src/data/queries";
import { DataProvider } from "../../src/data/react";
import { AT, live, project, snapshot } from "../../src/data/fixtures.test-util";
import { Markdown, preloadMarkdown, RefsContext, RefText } from "../../ui";
import { TooltipProvider } from "../../ui/primitives/Tooltip";
import { renderRef } from "./RefChip";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const finished: Task = {
  taskId: "T5945",
  title: "Get started home",
  kind: "write",
  state: "done",
  attempt: 1,
  createdAt: AT,
  projectRef: project,
  workstreamId: "W890",
  prompt: "Build it",
};
const launch: OrderCard = {
  workstreamId: "W890",
  title: "Launch readiness",
  createdAt: AT,
  updatedAt: AT,
  lanes: [],
  needsYou: 0,
  phase: "working",
  projectRef: project,
  prs: [],
  settled: 0,
  state: "open",
  total: 0,
};

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

const mount = async (body: ReactNode) => {
  const hub: HubApi = {
    call: (tool, input) => {
      if (tool === "orders_board") return Promise.resolve({ ok: true, output: { at: AT, orders: [launch], trains: [] } });
      if (tool === "task_get") {
        const id = (input as { taskId: string }).taskId;
        return Promise.resolve(id === finished.taskId ? { ok: true, output: { task: finished } } : { ok: false, error: { code: "not_found", message: `No task ${id}.` } });
      }
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
          <RefsContext.Provider value={renderRef}>{body}</RefsContext.Provider>
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

const chips = () => [...host.querySelectorAll("[data-ref]")].map((c) => [c.getAttribute("data-ref"), c.textContent, c.getAttribute("href")]);

it("names an agent and an order in plain words, each opening it", async () => {
  await mount(<RefText text="T5945 finished its part of W890." />);
  expect(host.textContent).toBe("Get started home finished its part of Launch readiness.");
  expect(chips()).toEqual([
    ["T5945", "Get started home", "#/project/devbox/storefront/agents/T5945"],
    ["W890", "Launch readiness", "#/project/devbox/storefront/agents"],
  ]);
});

it("says a plain word for one that is gone, and never its id", async () => {
  await mount(<RefText text="T404 and W1 are gone. D742 stays" />);
  expect(host.textContent).toBe("An agent and an order are gone. A decision stays");
  // Gone, they open nothing; the decision opens the bot's decisions only on a project's screen.
  expect(host.querySelector("a")).toBeNull();
});

it("shows ids in a message's markdown as chips, a code span of one id too, and leaves code blocks alone", async () => {
  preloadMarkdown();
  await mount(<Markdown source={"Done: `T5945` and **W890**.\n\n```\nT5945\n```"} />);
  // The parser is its own chunk: under load it lands after a few turns, so wait for it rather than for one settle.
  await vi.waitFor(async () => {
    await settle();
    expect(chips().map((c) => c[1])).toEqual(["Get started home", "Launch readiness"]);
  });
  expect(host.querySelector("pre")?.textContent).toContain("T5945");
});

it("shows ids as written with no app around it", () => {
  root = createRoot(host);
  act(() => root?.render(<RefText text="T5945 finished" />));
  expect(host.textContent).toBe("T5945 finished");
});

// @vitest-environment happy-dom
// An agent block in the chat names its agent and its true state, read by its task id when no live list has it.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AgentRow, Task } from "../../../../shared/contracts";
import { createDataLayer, type HubApi } from "../../../src/data/queries";
import { DataProvider } from "../../../src/data/react";
import { AT, event, live, project, snapshot } from "../../../src/data/fixtures.test-util";
import { TooltipProvider } from "../../../ui/primitives/Tooltip";
import { AgentCard } from "./AgentCard";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// A read task in the project's second repo, continued by message_agent and woken by its own Monitors: between two of
// them it is `done`, and a Monitor wakes it back to `running` (T3842 on 2026-11-13).
const deploy: Task = {
  taskId: "T3842",
  title: "Cloud: the deploy to the three hosts, prepared and checked",
  kind: "read",
  state: "running",
  attempt: 8,
  createdAt: AT,
  startedAt: AT,
  projectRef: project,
  repoId: "R22",
  workstreamId: "W644",
  prompt: "Deploy",
  threadRef: { machineId: "devbox", threadId: "th-3842" },
  result: { status: "done", tail: "I'm watching deploy.log", endCause: "completed", at: AT },
};
const otherRow: AgentRow = { laneId: "T1", role: "implementer", status: "working", title: "Another agent", taskId: "T1", projectRef: project, projectTitle: "storefront" };

let tasks: Record<string, Task>;
let calls: string[];
let host: HTMLDivElement;
let root: Root | undefined;
let send: Parameters<HubApi["subscribe"]>[0] = () => undefined;

beforeEach(() => {
  // The agents list as the app last read it, before the Monitor woke the task: it lists no ended tasks.
  tasks = { T3842: deploy };
  calls = [];
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

const mount = async (taskId: string) => {
  const hub: HubApi = {
    call: (tool, input) => {
      calls.push(tool);
      if (tool === "agents_list") return Promise.resolve({ ok: true, output: { at: AT, agents: [otherRow] } });
      if (tool === "task_get") {
        const task = tasks[(input as { taskId: string }).taskId];
        return Promise.resolve(
          task === undefined
            ? { ok: false, error: { code: "not_found", message: `No task ${taskId}.` } }
            : { ok: true, output: { task, next: "" } },
        );
      }
      return Promise.resolve({ ok: true, output: {} });
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
          <AgentCard agent={{ taskId }} />
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

const card = () => host.querySelector("[data-block='agent']")?.textContent ?? "";

it("names a running task the live list doesn't hold, and says it runs", async () => {
  await mount("T3842");
  expect(card()).toContain("Cloud: the deploy to the three hosts, prepared and checked");
  expect(card()).toContain("Running.");
  expect(card()).not.toContain("Not running now");
  expect(card()).not.toContain("An agent");
});

it("follows the task as it ends a turn and its Monitor wakes it again", async () => {
  tasks = { T3842: { ...deploy, state: "done", endedAt: AT } };
  await mount("T3842");
  expect(card()).toContain("Finished.");
  tasks = { T3842: deploy };
  act(() => send(event(2, "task.started", { taskId: "T3842", workstreamId: "W644" })));
  await act(() => new Promise((done) => setTimeout(done, 400)));
  await settle();
  expect(card()).toContain("Running.");
});

it("says plainly when the hub has no such task", async () => {
  await mount("T9999");
  expect(card()).toContain("Agent T9999");
  expect(card()).toContain("This hub has no such task.");
  expect(card()).not.toContain("Not running now");
});

it("reads the agents list itself, with no other view open", async () => {
  await mount("T3842");
  expect(calls).toContain("agents_list");
});

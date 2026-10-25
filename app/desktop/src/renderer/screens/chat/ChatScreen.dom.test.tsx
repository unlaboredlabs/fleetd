// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ProjectStatusRow } from "../../../shared/contracts";
import { createDataLayer, type HubApi } from "../../src/data/queries";
import { DataProvider } from "../../src/data/react";
import { AT, live, project, snapshot } from "../../src/data/fixtures.test-util";
import { TooltipProvider } from "../../ui/primitives/Tooltip";
import { ChatScreen } from "./ChatScreen";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// Settings, which the chat's controls link to, reads the platform as it loads.
vi.hoisted(() => vi.stubGlobal("fleetd", { platform: "darwin", fixture: null }));

let host: HTMLDivElement;
let root: Root | undefined;
const calls: [string, unknown][] = [];

beforeEach(() => {
  calls.length = 0;
  window.localStorage.clear();
  host = document.createElement("div");
  document.body.appendChild(host);
});
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  host.remove();
});

/** The chat on a live hub whose Status row for the project is `row`. */
const mount = async (row: Partial<ProjectStatusRow>) => {
  let send: Parameters<HubApi["subscribe"]>[0] = () => undefined;
  const answers: Readonly<Record<string, unknown>> = {
    status_get: { rows: [{ projectRef: project, title: "storefront", asOf: AT, agentsRunning: 0, state: "idle", ...row }] },
    orders_board: { orders: [] },
    usage_resume: { resumed: 2, status: { machineId: project.machineId, breaker: { state: "closed" } } },
  };
  const hub: HubApi = {
    call: (tool, input) => {
      calls.push([tool, input]);
      return Promise.resolve({ ok: true, output: answers[tool] ?? {} } as never);
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
          <ChatScreen project={project} />
        </TooltipProvider>
      </DataProvider>,
    );
  });
  act(() => {
    send(live());
    send(snapshot(1));
  });
  for (let i = 0; i < 5; i++) await act(() => new Promise((done) => setTimeout(done, 0)));
};

const line = () => host.querySelector("[data-attention]")?.textContent ?? null;

it("says why the project is blocked above the box, in the hub's words", async () => {
  await mount({ state: "blocked", blockedReason: "main CI is red: rust (macos)" });
  expect(line()).toBe("Blocked: main CI is red: rust (macos)");
});

it("offers Resume on the blocked line when its machine's usage pause is why, and Resume calls usage_resume", async () => {
  await mount({ state: "blocked", blockedReason: "rate-limited by your proxy on devbox, checking again shortly", usagePausedOn: project.machineId });
  expect(line()).toBe("Blocked: rate-limited by your proxy on devbox, checking again shortly" + "Resume");
  const resume = host.querySelector<HTMLButtonElement>("[data-attention] button");
  await act(async () => {
    resume?.click();
    await new Promise((done) => setTimeout(done, 0));
  });
  expect(calls.filter(([tool]) => tool === "usage_resume")).toEqual([["usage_resume", { machineId: project.machineId }]]);
  // Another reason offers none.
  act(() => root?.unmount());
  await mount({ state: "blocked", blockedReason: "main CI is red: rust (macos)" });
  expect(host.querySelector("[data-attention] button")).toBeNull();
});

it("says only that it is blocked when the hub gave no reason, and nothing when it isn't", async () => {
  await mount({ state: "blocked" });
  expect(line()).toBe("Blocked");
  act(() => root?.unmount());
  await mount({ state: "working" });
  expect(line()).toBeNull();
});

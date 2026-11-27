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
import { InlineText } from "../chat/text";
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
// What each attachment_get asked for: a chip reads one byte for a file's name, never the file.
let fileReads: unknown[] = [];
let root: Root | undefined;
let send: Parameters<HubApi["subscribe"]>[0] = () => undefined;

beforeEach(() => {
  fileReads = [];
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
      if (tool === "decisions_list") return Promise.resolve({ ok: true, output: { decisions: [{ decisionId: "D5" }], orders: [] } });
      if (tool === "attachment_get") {
        fileReads.push(input);
        const id = (input as { attachmentId: string }).attachmentId;
        return Promise.resolve(id === "F2" ? { ok: true, output: { attachmentId: "F2", bytes: 10, dataB64: "", mime: "application/pdf", name: "brief.pdf" } } : { ok: false, error: { code: "not_found", message: `No file ${id}.` } });
      }
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
    ["W890", "Launch readiness", "#/project/devbox/storefront/agents/W890"],
  ]);
});

it("says a plain word for one that is gone, and never its id", async () => {
  await mount(<RefText text="T404 and W1 are gone." />);
  expect(host.textContent).toBe("An agent and an order are gone.");
  // Gone, they open nothing.
  expect(host.querySelector("a")).toBeNull();
});

it("makes a decision's or a file's id a chip only once the bot has it, and leaves anything else as written", async () => {
  window.location.hash = "#/project/devbox/storefront";
  await mount(<RefText text="D5 says so, F2 has it. Press F12, or use D1." />);
  await settle();
  expect(host.textContent).toBe("A decision says so, brief.pdf has it. Press F12, or use D1.");
  expect(chips()).toEqual([
    ["D5", "A decision", "#/project/devbox/storefront/decisions"],
    ["F2", "brief.pdf", null],
  ]);
  // Each file read is a one-byte piece from its start (offset and length), which the workspace reads alone.
  expect(fileReads.length).toBeGreaterThan(0);
  for (const read of fileReads) expect(read).toMatchObject({ offset: 0, length: 1 });
  window.location.hash = "";
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

it("shows a person fleetd names as their name, never an id in it as an agent, in words and in markdown", async () => {
  preloadMarkdown();
  const line = "Made stricter: Approvals: Ask me about everything. [Check T5945](person:p_ffffffff) asked for it. T5945 finished.";
  await mount(<RefText text={line} />);
  expect(host.textContent).toBe("Made stricter: Approvals: Ask me about everything. Check T5945 asked for it. Get started home finished.");
  expect(chips().map((c) => c[0])).toEqual(["T5945"]);
  act(() => root?.unmount());
  await mount(<Markdown source={line} />);
  await vi.waitFor(async () => {
    await settle();
    expect(host.textContent).toContain("Check T5945 asked for it. Get started home finished.");
  });
  expect(chips().map((c) => c[0])).toEqual(["T5945"]);
  expect(host.querySelector("a[href^='person:']")).toBeNull();
});

it("shows a person's machine-like name as their name in a chat row's one line, never markup or their id", async () => {
  await mount(<InlineText text="[ada.park](person:p_aaaaaaaa) stopped T5945. [Check T5945](person:p_b) asked." />);
  expect(host.textContent).toBe("ada.park stopped Get started home. Check T5945 asked.");
  expect(chips().map((c) => c[0])).toEqual(["T5945"]);
  expect(host.querySelector("code")).toBeNull();
});

it("shows ids as written with no app around it", () => {
  root = createRoot(host);
  act(() => root?.render(<RefText text="T5945 finished, [Check T6168](person:p_1) says" />));
  expect(host.textContent).toBe("T5945 finished, Check T6168 says");
});

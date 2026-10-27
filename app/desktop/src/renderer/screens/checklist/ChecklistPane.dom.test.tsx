// @vitest-environment happy-dom
// The Checklist tab against a hub that keeps the list in memory: a person deletes an item (its hover button or its
// right-click menu) and clears the done ones, each gone at once with Undo, and the hub hears only once Undo is gone:
// never while the pointer is on the toast, and at the next launch if the app quit first.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ChecklistRemoveInput, TodoItem } from "../../../shared/contracts";
import { createDataLayer, type HubApi } from "../../src/data/queries";
import { DataProvider } from "../../src/data/react";
import { AT, event, live, project, snapshot } from "../../src/data/fixtures.test-util";
import { UiProvider } from "../../ui";
import { ChecklistPane } from "./ChecklistPane";
import { flush, sendKept, UNDO_MS } from "./removal";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.hoisted(() => vi.stubGlobal("fleetd", { platform: "linux", fixture: null }));

const todo = (id: number, state: TodoItem["state"], text: string): TodoItem => ({ id, text, state, updatedAt: AT });

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  window.localStorage.clear();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
});

const settle = async () => {
  for (let i = 0; i < 5; i++) await act(() => (vi.isFakeTimers() ? vi.advanceTimersByTimeAsync(0) : new Promise((done) => setTimeout(done, 0))));
};
const wait = async (ms: number) => {
  await act(() => vi.advanceTimersByTimeAsync(ms));
  await settle();
};

/** A hub with `items` on storefront's list; checklist_remove takes them off and is kept. Unconnected with `offline`. */
async function mount(items: TodoItem[], { offline = false, launch }: { offline?: boolean; launch?: (layer: ReturnType<typeof createDataLayer>) => void } = {}) {
  const hub = { items, removes: [] as ChecklistRemoveInput[] };
  let send: Parameters<HubApi["subscribe"]>[0] = () => undefined;
  const api: HubApi = {
    call: (tool, input) => {
      if (tool === "checklist_get") return Promise.resolve({ ok: true, output: { projectRef: project, items: hub.items, updatedAt: AT } });
      if (tool === "checklist_remove") {
        const remove = input as ChecklistRemoveInput;
        hub.removes.push(remove);
        hub.items = hub.items.filter((i) => !remove.ids.includes(i.id));
        return Promise.resolve({ ok: true, output: { projectRef: project, items: hub.items, updatedAt: AT } });
      }
      return Promise.resolve({ ok: true, output: {} });
    },
    subscribe: (l) => ((send = l), () => undefined),
    resync: () => Promise.resolve(),
    focus: () => Promise.resolve(),
    chat: () => Promise.resolve(),
  };
  const layer = createDataLayer(api);
  launch?.(layer);
  act(() => {
    root.render(
      <UiProvider>
        <DataProvider layer={layer}>
          <ChecklistPane project={project} />
        </DataProvider>
      </UiProvider>,
    );
  });
  const connect = async () => {
    act(() => {
      send(live());
      send(snapshot(1));
    });
    await settle();
  };
  if (offline) return { hub, connect, send: (f: Parameters<typeof send>[0]) => act(() => send(f)) };
  await connect();
  // Done unfolded, so its rows are on screen.
  const fold = [...host.querySelectorAll("button")].find((b) => b.textContent.startsWith("Done"));
  if (fold?.getAttribute("aria-expanded") === "false") act(() => fold.click());
  return { hub, connect, send: (f: Parameters<typeof send>[0]) => act(() => send(f)) };
}

const rows = () => [...host.querySelectorAll<HTMLElement>("[data-item]")].map((r) => r.dataset["item"]);
const button = (name: string): HTMLButtonElement | undefined =>
  [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === name || b.getAttribute("aria-label") === name);
const click = async (name: string) => {
  const b = button(name);
  if (b === undefined) throw new Error(`no button ${name} in: ${document.body.textContent}`);
  act(() => b.click());
  await settle();
};
/** The Undo window ends, as its timer would. */
const undoGone = async () => {
  act(() => flush());
  await settle();
};

const LIST = [todo(1, "done", "Receipts"), todo(2, "doing", "Dark mode"), todo(3, "todo", "Release notes"), todo(4, "done", "Gift cards")];

it("deletes an item from its hover button at once, and Undo puts it back without the hub hearing", async () => {
  const { hub } = await mount(LIST);
  expect(rows()).toEqual(["2", "3", "1", "4"]);
  await click("Delete “Release notes”");
  expect(rows()).toEqual(["2", "1", "4"]);
  expect(host.textContent).toContain("2 of 3 done");
  expect(document.body.textContent).toContain("Deleted “Release notes”");
  await click("Undo");
  expect(rows()).toEqual(["2", "3", "1", "4"]);
  await undoGone();
  expect(hub.removes).toEqual([]);

  // Without Undo, the hub takes it off once the Undo is gone, and the list stays as it is.
  await click("Delete “Release notes”");
  expect(hub.removes).toEqual([]);
  await undoGone();
  expect(hub.removes).toEqual([{ projectRef: project, ids: [3] }]);
  expect(rows()).toEqual(["2", "1", "4"]);
});

it("deletes from an item's right-click menu", async () => {
  const { hub } = await mount(LIST);
  act(() => {
    host.querySelector("[data-item='2']")?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }));
  });
  const items = [...document.querySelectorAll<HTMLElement>("[role='menuitem']")];
  expect(items.map((i) => i.textContent)).toEqual(["Delete"]);
  act(() => items[0]?.click());
  await settle();
  expect(rows()).toEqual(["3", "1", "4"]);
  await undoGone();
  expect(hub.removes).toEqual([{ projectRef: project, ids: [2] }]);
});

it("clears every done item at once from the header, Undo puts them back, and a second removal sends the first", async () => {
  const { hub, send } = await mount(LIST);
  await click("Clear done");
  expect(rows()).toEqual(["2", "3"]);
  expect(document.body.textContent).toContain("Cleared 2 done items");
  // Nothing done is left, so the button goes.
  expect(button("Clear done")).toBeUndefined();
  await click("Undo");
  expect(rows()).toEqual(["2", "3", "1", "4"]);
  expect(button("Clear done")).toBeDefined();

  await click("Clear done");
  // The lead changes the list meanwhile: the cleared items stay off while their Undo waits.
  hub.items = [...hub.items, todo(5, "todo", "Ship it")];
  send(event(2, "checklist.changed", { projectRef: project, done: 2, total: 5, by: "lead:devbox/storefront" }));
  await act(() => new Promise((done) => setTimeout(done, 150)));
  await settle();
  expect(rows()).toEqual(["2", "3", "5"]);
  // Deleting another sends the clear now, then waits on its own Undo.
  await click("Delete “Ship it”");
  expect(hub.removes).toEqual([{ projectRef: project, ids: [1, 4] }]);
  expect(rows()).toEqual(["2", "3"]);
  await undoGone();
  expect(hub.removes).toEqual([
    { projectRef: project, ids: [1, 4] },
    { projectRef: project, ids: [5] },
  ]);
});

it("shows no Clear done while nothing is done", async () => {
  await mount([todo(2, "doing", "Dark mode"), todo(3, "todo", "Release notes")]);
  expect(rows()).toEqual(["2", "3"]);
  expect(button("Clear done")).toBeUndefined();
});

it("holds Undo while the pointer is on its toast, and sends once it leaves and the time left runs out", async () => {
  const { hub } = await mount(LIST);
  vi.useFakeTimers();
  await click("Delete “Release notes”");
  const toastEl = [...document.querySelectorAll("li")].find((li) => li.textContent.includes("Deleted “Release notes”"));
  const region = toastEl?.closest("[role='region']");
  if (toastEl === undefined || region == null) throw new Error("no toast");
  await wait(UNDO_MS - 2_000);
  act(() => {
    toastEl.dispatchEvent(new PointerEvent("pointermove", { bubbles: true }));
  });
  // Long past its time, still there under the pointer, and nothing sent.
  await wait(UNDO_MS * 2);
  expect(hub.removes).toEqual([]);
  expect(button("Undo")).toBeDefined();
  act(() => {
    region.dispatchEvent(new PointerEvent("pointerleave"));
  });
  await wait(1_000);
  expect(hub.removes).toEqual([]);
  await wait(1_500);
  expect(hub.removes).toEqual([{ projectRef: project, ids: [3] }]);
  expect(rows()).toEqual(["2", "1", "4"]);
});

it("keeps a removal until the hub has it, so one the app quit within its Undo goes at the next launch", async () => {
  const stored = () => JSON.parse(window.localStorage.getItem("fleetd.checklistRemovals") ?? "[]") as unknown;
  const first = await mount(LIST);
  await click("Delete “Release notes”");
  expect(stored()).toEqual([{ projectRef: project, ids: [3] }]);
  // Undone: nothing kept. Sent: kept until the hub answers.
  await click("Undo");
  expect(stored()).toEqual([]);
  await click("Clear done");
  expect(stored()).toEqual([{ projectRef: project, ids: [1, 4] }]);
  await undoGone();
  expect(first.hub.removes).toEqual([{ projectRef: project, ids: [1, 4] }]);
  expect(stored()).toEqual([]);

  // The app quits within a removal's Undo, as an earlier run left it: the next launch sends it once connected.
  window.localStorage.setItem("fleetd.checklistRemovals", JSON.stringify([{ projectRef: project, ids: [3] }]));
  act(() => root.unmount());
  root = createRoot(host);
  const next = await mount(LIST, { offline: true, launch: (layer) => sendKept(() => layer) });
  await settle();
  expect(next.hub.removes).toEqual([]);
  await next.connect();
  expect(next.hub.removes).toEqual([{ projectRef: project, ids: [3] }]);
  expect(stored()).toEqual([]);
  expect(rows()).toEqual(["2", "1", "4"]);
});

it("a session's window never sends a removal the app's window is still waiting out the Undo of", async () => {
  const { hub } = await mount(LIST);
  await click("Delete “Release notes”");
  // A session's window opens meanwhile: the same storage, its own layer and connection.
  const calls: string[] = [];
  const other: HubApi = {
    call: (tool) => {
      calls.push(tool);
      return Promise.resolve({ ok: true, output: { projectRef: project, items: [], updatedAt: AT } });
    },
    subscribe: (l) => {
      l(live());
      l(snapshot(1));
      return () => undefined;
    },
    resync: () => Promise.resolve(),
    focus: () => Promise.resolve(),
    chat: () => Promise.resolve(),
  };
  const layer = createDataLayer(other);
  const stop = layer.start();
  expect(layer.store.getState().fresh).toBe(true);
  sendKept(() => layer, "#/session/devbox/storefront/B1");
  await settle();
  expect(calls).toEqual([]);
  // The app's window sends it, as at the next launch.
  sendKept(() => layer, "#/project/devbox/storefront");
  await settle();
  expect(calls).toEqual(["checklist_remove"]);
  stop();

  // Undo in the app's window: back on its list, and its own hub never heard.
  await click("Undo");
  expect(rows()).toEqual(["2", "3", "1", "4"]);
  await undoGone();
  expect(hub.removes).toEqual([]);
});

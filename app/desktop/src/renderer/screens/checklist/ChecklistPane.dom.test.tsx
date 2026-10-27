// @vitest-environment happy-dom
// The Checklist tab against a hub that keeps the list in memory: a person deletes an item (its hover button or its
// right-click menu) and clears the done ones, each gone at once with Undo, and the hub hears only once Undo is gone.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ChecklistRemoveInput, TodoItem } from "../../../shared/contracts";
import { createDataLayer, type HubApi } from "../../src/data/queries";
import { DataProvider } from "../../src/data/react";
import { AT, event, live, project, snapshot } from "../../src/data/fixtures.test-util";
import { UiProvider } from "../../ui";
import { ChecklistPane } from "./ChecklistPane";
import { flush } from "./removal";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.hoisted(() => vi.stubGlobal("fleetd", { platform: "linux", fixture: null }));

const todo = (id: number, state: TodoItem["state"], text: string): TodoItem => ({ id, text, state, updatedAt: AT });

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const settle = async () => {
  for (let i = 0; i < 5; i++) await act(() => new Promise((done) => setTimeout(done, 0)));
};

/** A hub with `items` on storefront's list; checklist_remove takes them off and is kept. */
async function mount(items: TodoItem[]) {
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
  act(() => {
    root.render(
      <UiProvider>
        <DataProvider layer={createDataLayer(api)}>
          <ChecklistPane project={project} />
        </DataProvider>
      </UiProvider>,
    );
  });
  act(() => {
    send(live());
    send(snapshot(1));
  });
  await settle();
  // Done unfolded, so its rows are on screen.
  const fold = [...host.querySelectorAll("button")].find((b) => b.textContent.startsWith("Done"));
  if (fold?.getAttribute("aria-expanded") === "false") act(() => fold.click());
  return { hub, send: (f: Parameters<typeof send>[0]) => act(() => send(f)) };
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

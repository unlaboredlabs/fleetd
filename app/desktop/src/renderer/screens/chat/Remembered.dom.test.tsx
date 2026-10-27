// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ChatMessage, MemoryRefreshed } from "../../../shared/contracts";
import { createDataLayer, type HubApi } from "../../src/data/queries";
import { DataProvider } from "../../src/data/react";
import { UiProvider } from "../../ui";
import { RefreshedChanges } from "./Remembered";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const project = { machineId: "devbox", projectId: "shop" };
const refreshed: MemoryRefreshed = {
  items: [
    { scope: "project", text: "Staging deploys need the VPN." },
    { scope: "project", text: "No npm: use pnpm.", replaced: "Use npm." },
    { scope: "project", topic: "deploys", text: "Deploys freeze on Fridays.", forgotten: true, reason: "The freeze ended.", undone: true },
  ],
};
const message = {
  messageId: "m9",
  projectRef: project,
  seq: 9,
  author: "system",
  text: "Memory refreshed: +1 ~1 −1",
  createdAt: "2026-10-27T04:30:00.000Z",
  state: "final",
  attachments: [],
  memoryRefreshed: refreshed,
} as ChatMessage;

let host: HTMLDivElement;
let root: Root;
let calls: { tool: string; input: unknown }[];

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  calls = [];
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const render = async () => {
  const hub: HubApi = {
    call: (tool, input) => {
      calls.push({ tool, input });
      return Promise.resolve({ ok: true, output: { ok: true } });
    },
    subscribe: () => () => undefined,
    resync: () => Promise.resolve(),
    focus: () => Promise.resolve(),
    chat: () => Promise.resolve(),
  };
  await act(async () => {
    root.render(
      <UiProvider>
        <DataProvider layer={createDataLayer(hub)}>
          <RefreshedChanges project={project} message={message} refreshed={refreshed} />
        </DataProvider>
      </UiProvider>,
    );
    await Promise.resolve();
  });
};

const buttons = (text: string) => [...document.querySelectorAll("button")].filter((b) => b.textContent.trim() === text);
const nth = (text: string, n: number) => {
  const b = buttons(text)[n];
  if (b === undefined) throw new Error(`no button ${text} ${n}`);
  return b;
};

const click = async (el: HTMLElement) => {
  await act(async () => {
    el.click();
    await Promise.resolve();
  });
};

describe("the Memory refreshed line", () => {
  it("lists each change with its file and reason, Undo on each one still undoable, and Undo all", async () => {
    await render();
    const items = [...document.querySelectorAll('[role="listitem"]')].map((i) => i.textContent);
    expect(items).toEqual([
      "+ MEMORY.md: Staging deploys need the VPN. Undo",
      "~ MEMORY.md: No npm: use pnpm. (was: Use npm.) Undo",
      "− deploys.md: Deploys freeze on Fridays. (The freeze ended.) Undone",
    ]);
    const undo = buttons("Undo");
    expect(undo).toHaveLength(2);
    await click(nth("Undo", 1));
    expect(calls).toEqual([{ tool: "memory_undo", input: { projectRef: project, messageId: "m9", item: 1 } }]);
    await click(nth("Undo all", 0));
    expect(calls[1]).toEqual({ tool: "memory_undo", input: { projectRef: project, messageId: "m9" } });
  });
});

describe("a Memory refreshed line with more changes than it lists", () => {
  it("says how many more, and Undo all takes them back too", async () => {
    const big: MemoryRefreshed = { items: [{ scope: "project", text: "Rule 0." }], total: 205 };
    const hub: HubApi = {
      call: (tool, input) => {
        calls.push({ tool, input });
        return Promise.resolve({ ok: true, output: { ok: true } });
      },
      subscribe: () => () => undefined,
      resync: () => Promise.resolve(),
      focus: () => Promise.resolve(),
      chat: () => Promise.resolve(),
    };
    await act(async () => {
      root.render(
        <UiProvider>
          <DataProvider layer={createDataLayer(hub)}>
            <RefreshedChanges project={project} message={{ ...message, memoryRefreshed: big }} refreshed={big} />
          </DataProvider>
        </UiProvider>,
      );
      await Promise.resolve();
    });
    expect(document.body.textContent).toContain("and 204 more");
    await click(nth("Undo all", 0));
    expect(calls).toEqual([{ tool: "memory_undo", input: { projectRef: project, messageId: "m9" } }]);
  });

  it("keeps Undo all while a change it doesn't list is left, after each listed one was undone", async () => {
    const shown = (line: MemoryRefreshed) =>
      act(async () => {
        root.render(
          <UiProvider>
            <DataProvider layer={createDataLayer({ call: () => Promise.resolve({ ok: true, output: { ok: true } }), subscribe: () => () => undefined, resync: () => Promise.resolve(), focus: () => Promise.resolve(), chat: () => Promise.resolve() })}>
              <RefreshedChanges project={project} message={{ ...message, memoryRefreshed: line }} refreshed={line} />
            </DataProvider>
          </UiProvider>,
        );
        await Promise.resolve();
      });
    // Its one listed change undone on its own: the 204 past it are still there.
    await shown({ items: [{ scope: "project", text: "Rule 0.", undone: true }], total: 205, undone: 1 });
    expect(buttons("Undo")).toHaveLength(0);
    expect(buttons("Undo all")).toHaveLength(1);
    // One of those left.
    await shown({ items: [{ scope: "project", text: "Rule 0.", undone: true }], total: 205, undone: 204 });
    expect(buttons("Undo all")).toHaveLength(1);
    // All of them undone.
    await shown({ items: [{ scope: "project", text: "Rule 0.", undone: true }], total: 205, undone: 205 });
    expect(buttons("Undo all")).toHaveLength(0);
  });
});

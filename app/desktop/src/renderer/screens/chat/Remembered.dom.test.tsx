// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ChatMessage, MemoryRefreshed } from "../../../shared/contracts";
import { createDataLayer, type HubApi } from "../../src/data/queries";
import { DataProvider } from "../../src/data/react";
import { UiProvider } from "../../ui";
import { RefreshedChanges, tidied } from "./Remembered";

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
          <RefreshedChanges project={project} message={message} refreshed={refreshed} at="04:30" />
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

const summary = () => {
  const b = [...document.querySelectorAll("button")].find((x) => x.textContent.startsWith("Memory tidied"));
  if (b === undefined) throw new Error("no summary");
  return b;
};
const rows = () => [...document.querySelectorAll('[role="listitem"]')];
const entry = (row: Element) => {
  const b = row.querySelector("button[aria-expanded]");
  if (!(b instanceof HTMLElement)) throw new Error("no entry");
  return b;
};

describe("the Memory refreshed line", () => {
  it("is one summary line with Undo all, its changes folded away", async () => {
    await render();
    expect(summary().textContent).toBe("Memory tidied: 1 added, 1 updated, 1 removed");
    expect(summary().getAttribute("aria-expanded")).toBe("false");
    expect(document.querySelector('[role="list"]')).toBeNull();
    expect(buttons("Undo all")).toHaveLength(1);
    expect(buttons("Undo")).toHaveLength(0);
  });

  it("opens to one row per change: what kind, the file past MEMORY.md, the entry, and Undo or Undone", async () => {
    await render();
    await click(summary());
    expect(summary().getAttribute("aria-expanded")).toBe("true");
    expect(rows().map((r) => r.textContent)).toEqual([
      "AddedStaging deploys need the VPN.Undo",
      "UpdatedNo npm: use pnpm.Undo",
      "Removeddeploys.md: Deploys freeze on Fridays.Undone",
    ]);
    // Folded again.
    await click(summary());
    expect(rows()).toHaveLength(0);
  });

  it("shows an update's old wording and a removal's reason only once its row is opened", async () => {
    await render();
    await click(summary());
    expect(document.body.textContent).not.toContain("Use npm.");
    expect(document.body.textContent).not.toContain("The freeze ended.");
    const [, updated, removed] = rows();
    if (updated === undefined || removed === undefined) throw new Error("no rows");
    expect(entry(updated).getAttribute("title")).toBe("No npm: use pnpm.");
    await click(entry(updated));
    expect(entry(updated).getAttribute("aria-expanded")).toBe("true");
    expect(updated.textContent).toContain("Was: Use npm.");
    await click(entry(removed));
    expect(removed.textContent).toContain("Why: The freeze ended.");
    await click(entry(updated));
    expect(updated.textContent).not.toContain("Was: Use npm.");
  });

  it("undoes one change by its place in the line, and all of them with Undo all", async () => {
    await render();
    await click(summary());
    expect(buttons("Undo")).toHaveLength(2);
    await click(nth("Undo", 1));
    expect(calls).toEqual([{ tool: "memory_undo", input: { projectRef: project, messageId: "m9", item: 1 } }]);
    await click(nth("Undo all", 0));
    expect(calls[1]).toEqual({ tool: "memory_undo", input: { projectRef: project, messageId: "m9" } });
  });
});

describe("the summary's counts", () => {
  it("come from the hub's line, which counts the changes past those listed too", () => {
    expect(tidied("Memory refreshed: +200 −5", { items: [{ scope: "project", text: "Rule 0." }], total: 205 })).toBe("Memory tidied: 200 added, 5 removed");
  });
  it("fall back to the listed changes when the line says none", () => {
    expect(tidied("Memory refreshed", refreshed)).toBe("Memory tidied: 1 added, 1 updated, 1 removed");
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
            <RefreshedChanges project={project} message={{ ...message, memoryRefreshed: big }} refreshed={big} at="04:30" />
          </DataProvider>
        </UiProvider>,
      );
      await Promise.resolve();
    });
    await click(summary());
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
              <RefreshedChanges project={project} message={{ ...message, memoryRefreshed: line }} refreshed={line} at="04:30" />
            </DataProvider>
          </UiProvider>,
        );
        await Promise.resolve();
      });
    // Its one listed change undone on its own: the 204 past it are still there.
    await shown({ items: [{ scope: "project", text: "Rule 0.", undone: true }], total: 205, undone: 1 });
    await click(summary());
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

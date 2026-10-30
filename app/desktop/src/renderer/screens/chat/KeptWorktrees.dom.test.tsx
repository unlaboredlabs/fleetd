// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage, WorktreesKept } from "../../../shared/contracts";
import { UiProvider } from "../../ui";
import { KeptWorktrees } from "./KeptWorktrees";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const project = { machineId: "devbox", projectId: "shop" };
const kept: WorktreesKept = {
  items: [
    { title: "Agents can read their brief", unsaved: "1 unpushed commit", machineId: "devbox", path: "/home/dev/.fleetd/node/worktrees/p1/t1" },
    { title: "Try it: tailnet port proxy", unsaved: "uncommitted changes", machineId: "laptop", path: "/home/dev/.fleetd/node/worktrees/p1/t2" },
  ],
};
const message = {
  messageId: "m9",
  projectRef: project,
  seq: 9,
  author: "system",
  text: "Cleanup kept 2 worktrees with unsaved work",
  createdAt: "2026-10-30T04:00:00.000Z",
  state: "final",
  attachments: [],
  worktreesKept: kept,
} as ChatMessage;

let host: HTMLDivElement;
let root: Root;
let copied: string[];

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  copied = [];
  vi.stubGlobal("fleetd", { copy: (text: string) => (copied.push(text), Promise.resolve()) });
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

const render = async () => {
  await act(async () => {
    root.render(
      <UiProvider>
        <KeptWorktrees message={message} kept={kept} at="05:00" />
      </UiProvider>,
    );
    await Promise.resolve();
  });
};

const click = async (el: Element | null | undefined) => {
  if (!(el instanceof HTMLElement)) throw new Error("nothing to click");
  await act(async () => {
    el.click();
    await Promise.resolve();
  });
};

const summary = () => document.querySelector("button[aria-expanded]");
const rows = () => [...document.querySelectorAll('[role="listitem"]')];

describe("the Cleanup kept line", () => {
  it("is one folded summary line", async () => {
    await render();
    expect(summary()?.textContent).toBe("Cleanup kept 2 worktrees with unsaved work");
    expect(summary()?.getAttribute("aria-expanded")).toBe("false");
    expect(rows()).toHaveLength(0);
    expect(host.textContent).toContain("05:00");
  });

  it("opens to each worktree's title, what is unsaved and its path, without task ids", async () => {
    await render();
    await click(summary());
    expect(rows().map((r) => r.querySelector("span")?.textContent)).toEqual([
      "Agents can read their brief · 1 unpushed commit",
      // Another machine than the project's is named.
      "Try it: tailnet port proxy · uncommitted changes on laptop",
    ]);
    expect(rows().map((r) => r.querySelector("code")?.textContent)).toEqual(["/home/dev/.fleetd/node/worktrees/p1/t1", "/home/dev/.fleetd/node/worktrees/p1/t2"]);
    expect(host.textContent).not.toMatch(/\bT\d+\b/u);
  });

  it("copies a worktree's path", async () => {
    await render();
    await click(summary());
    await click(rows()[1]?.querySelector('button[aria-label="Copy the path of Try it: tailnet port proxy"]'));
    expect(copied).toEqual(["/home/dev/.fleetd/node/worktrees/p1/t2"]);
    expect(rows()[1]?.textContent).toContain("Copied");
  });
});

// @vitest-environment happy-dom
// A bubble's right-click menu: copy its words plain or as written, and on the lead's, reply to it or react.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ChatItem } from "../../src/data/chat";
import { createDataLayer, type HubApi } from "../../src/data/queries";
import { DataProvider } from "../../src/data/react";
import { TooltipProvider } from "../../ui/primitives/Tooltip";
import { BubbleActionsContext, type BubbleActions, type ReplyTarget } from "./actions";
import { MessageView } from "./Bubble";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const copy = vi.fn((_text: string) => Promise.resolve());
const PROJECT = { machineId: "devbox", projectId: "storefront" };
const TEXT = "**Merged** the fix. Shall I release it?";

let host: HTMLDivElement;
let root: Root;
const reply = vi.fn((_target: ReplyTarget) => undefined);
let actions: BubbleActions;

beforeEach(() => {
  vi.stubGlobal("fleetd", { platform: "linux", fixture: null, copy });
  copy.mockClear();
  window.localStorage.clear();
  reply.mockClear();
  actions = { project: PROJECT, waitedOn: undefined, send: () => undefined, reply, show: () => undefined };
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

const HUB: HubApi = {
  call: () => Promise.resolve({ ok: true, output: {} }),
  subscribe: () => () => undefined,
  resync: () => Promise.resolve(),
  focus: () => Promise.resolve(),
  chat: () => Promise.resolve(),
};

const item = (author: "lead" | "human"): ChatItem => ({ id: "m1", author, kind: "message", text: TEXT, at: "2026-10-26T09:00:00.000Z", attachments: [], state: "sent" });

const mount = async (author: "lead" | "human") => {
  const i = item(author);
  act(() =>
    root.render(
      <DataProvider layer={createDataLayer(HUB)}>
        <TooltipProvider>
          <BubbleActionsContext.Provider value={actions}>
            <MessageView row={{ kind: "message", key: i.id, item: i, run: true, end: true, head: false, history: false }} mineLatest={false} />
          </BubbleActionsContext.Provider>
        </TooltipProvider>
      </DataProvider>,
    ),
  );
  await act(() => new Promise((done) => setTimeout(done, 0)));
};

const bubble = (): HTMLElement => {
  const found = host.querySelector<HTMLElement>("[data-bubble]");
  if (found === null) throw new Error("no bubble");
  return found;
};
const rightClick = (target: Element) => {
  act(() => {
    target.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }));
  });
};
const items = () => [...document.querySelectorAll("[role='menu'] [role='menuitem']")].map((i) => i.textContent);
const choose = async (label: string) => {
  const found = [...document.querySelectorAll<HTMLElement>("[role='menuitem']")].find((i) => i.textContent === label);
  if (found === undefined) throw new Error(`no ${label}`);
  act(() => found.click());
  await act(() => Promise.resolve());
};

it("the lead's bubble copies its words plain or as markdown, and replies", async () => {
  await mount("lead");
  rightClick(bubble());
  expect(items()).toEqual(["Copy text", "Copy as Markdown", "Reply", "React"]);
  await choose("Copy text");
  expect(copy).toHaveBeenLastCalledWith("Merged the fix. Shall I release it?");
  rightClick(bubble());
  await choose("Copy as Markdown");
  expect(copy).toHaveBeenLastCalledWith(TEXT);
  rightClick(bubble());
  await choose("Reply");
  expect(reply).toHaveBeenCalledWith({ id: "m1", part: 0, quote: "Merged the fix. Shall I release it?" });
});

it("React puts a tapback on the lead's bubble", async () => {
  await mount("lead");
  rightClick(bubble());
  const react = [...document.querySelectorAll<HTMLElement>("[role='menuitem']")].find((i) => i.textContent === "React");
  if (react === undefined) throw new Error("no React");
  act(() => {
    react.focus();
    react.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
  });
  await act(() => new Promise((done) => setTimeout(done, 0)));
  await choose("👍Like");
  expect(host.querySelector("[aria-label='You reacted: Like']")?.textContent).toBe("👍");
});

it("your own bubble copies, and neither replies nor reacts", async () => {
  await mount("human");
  rightClick(bubble());
  expect(items()).toEqual(["Copy text", "Copy as Markdown"]);
});

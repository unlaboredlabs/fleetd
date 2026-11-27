// @vitest-environment happy-dom
// A bubble's right-click menu: copy its words plain or as written, and on the lead's, reply to it. Reactions are gone.
import { act, useEffect, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ChatItem } from "../../src/data/chat";
import { createDataLayer, type HubApi } from "../../src/data/queries";
import { DataProvider } from "../../src/data/react";
import o from "../../ui/primitives/Overlay.module.css";
import { TooltipProvider } from "../../ui/primitives/Tooltip";
import { BubbleActionsContext, type BubbleActions, type ReplyTarget } from "./actions";
import { MessageView } from "./Bubble";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// A fade on a closed surface, which happy-dom never ends: as in the app when the surface's entrance went unseen, a
// closed menu left to Radix would wait for it and stay on screen.
const fade = document.createElement("style");
fade.textContent = `.${o.surface}[data-state="closed"] { animation-name: fade; animation-duration: 120ms; }`;
document.head.appendChild(fade);

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
  actions = { project: PROJECT, send: () => undefined, reply, show: () => undefined };
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
  expect(items()).toEqual(["Copy text", "Copy as Markdown", "Reply"]);
  await choose("Copy text");
  expect(copy).toHaveBeenLastCalledWith("Merged the fix. Shall I release it?");
  rightClick(bubble());
  await choose("Copy as Markdown");
  expect(copy).toHaveBeenLastCalledWith(TEXT);
  rightClick(bubble());
  await choose("Reply");
  expect(reply).toHaveBeenCalledWith({ id: "m1", part: 0, quote: "Merged the fix. Shall I release it?" });
});

it("Reply leaves the cursor in the box, where the reply goes, once the menu has closed", async () => {
  // As ChatScreen and its composer do: Reply sets the reply, and the box takes the focus for it.
  const i = item("lead");
  function Chat() {
    const [to, setTo] = useState<ReplyTarget>();
    const box = useRef<HTMLTextAreaElement>(null);
    useEffect(() => {
      if (to !== undefined) box.current?.focus();
    }, [to]);
    return (
      <BubbleActionsContext.Provider value={{ ...actions, reply: setTo }}>
        <MessageView row={{ kind: "message", key: i.id, item: i, run: true, end: true, head: false, history: false }} mineLatest={false} />
        <textarea ref={box} />
      </BubbleActionsContext.Provider>
    );
  }
  act(() =>
    root.render(
      <DataProvider layer={createDataLayer(HUB)}>
        <TooltipProvider>
          <Chat />
        </TooltipProvider>
      </DataProvider>,
    ),
  );
  await act(() => new Promise((done) => setTimeout(done, 0)));
  rightClick(bubble());
  await choose("Reply");
  for (let n = 0; n < 3; n++) await act(() => new Promise((done) => setTimeout(done, 0)));
  expect(document.activeElement).toBe(host.querySelector("textarea"));
});

it("a lead's bubble has no reactions: no React in its menu, no reaction button beside it", async () => {
  await mount("lead");
  expect(host.querySelector("button[aria-label='Tapback']")).toBeNull();
  expect([...host.querySelectorAll("button")].map((b) => b.getAttribute("aria-label"))).toEqual(["Reply"]);
  rightClick(bubble());
  expect(items()).not.toContain("React");
});

it("your own bubble copies, and doesn't reply", async () => {
  await mount("human");
  rightClick(bubble());
  expect(items()).toEqual(["Copy text", "Copy as Markdown"]);
});

it("the menu leaves the page once a pick closes it", async () => {
  await mount("lead");
  rightClick(bubble());
  await choose("Copy text");
  expect(document.querySelector("[role='menu']")).toBeNull();
});

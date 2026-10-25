// @vitest-environment happy-dom
// Show, on the waiting-on-you line (and chat.showWaiting, from the palette and the live strip): it marks the exact
// bubble the lead waits on and moves focus to it, and with more than one it steps to the next on each press.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import type { ChatMessage } from "../../src/data/chat-contract";
import { createDataLayer, type HubApi } from "../../src/data/queries";
import { DataProvider } from "../../src/data/react";
import { AT, live, project, snapshot } from "../../src/data/fixtures.test-util";
import { TooltipProvider } from "../../ui/primitives/Tooltip";
import { runCommand } from "../palette";
import { ChatScreen } from "./ChatScreen";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.hoisted(() => vi.stubGlobal("fleetd", { platform: "darwin", fixture: null }));

// happy-dom has no layout: the list is 2000 px tall, so every row renders; a row is 40 px.
const heightOf = (el: Element) => (el.getAttribute("role") === "list" ? 2000 : el instanceof HTMLElement && el.dataset["index"] !== undefined ? 40 : 0);
const proto = HTMLElement.prototype;
const realRect = proto.getBoundingClientRect.bind(proto);

let host: HTMLDivElement;
let root: Root | undefined;
// The markdown parser, loaded once up front as the app's first opening would.
beforeAll(async () => {
  await import("../../ui/markdown/MarkdownBody");
});
beforeEach(() => {
  window.localStorage.clear();
  vi.spyOn(proto, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const h = heightOf(this);
    return h ? new DOMRect(0, 0, 600, h) : realRect.call(this);
  });
  Object.defineProperty(proto, "clientHeight", { configurable: true, get: function (this: HTMLElement) { return heightOf(this); } });
  Object.defineProperty(proto, "clientWidth", { configurable: true, get: () => 600 });
  host = document.createElement("div");
  document.body.appendChild(host);
});
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  host.remove();
  vi.restoreAllMocks();
});

const KEY = "devbox/storefront";
const msg = (seq: number, patch: Partial<ChatMessage> = {}): ChatMessage => ({
  messageId: `m${String(seq)}`,
  projectRef: project,
  seq,
  author: "lead",
  state: "final",
  text: `message ${String(seq)}`,
  createdAt: AT,
  ...patch,
});
/** A lead message the hub split into bubbles, one per piece of text. */
const split = (seq: number, pieces: readonly string[]): ChatMessage => {
  let start = 0;
  const parts = pieces.map((p) => ({ start, end: (start += p.length) }));
  return msg(seq, { text: pieces.join(""), parts });
};

const settle = async () => {
  for (let i = 0; i < 5; i++) await act(() => new Promise((done) => setTimeout(done, 0)));
};

/** The chat on a live hub, waiting on you, with `messages` as its newest page. */
const mount = async (messages: ChatMessage[]) => {
  let send: Parameters<HubApi["subscribe"]>[0] = () => undefined;
  const page = { messages, moreBefore: false, moreAfter: false, state: { projectRef: project, needsYou: true, leadWorking: false, lastSeq: messages.at(-1)?.seq ?? 0 } };
  const hub: HubApi = {
    call: (tool) => Promise.resolve({ ok: true, output: tool === "chat_history" ? page : tool === "status_get" ? { rows: [] } : {} }),
    subscribe: (l) => ((send = l), () => undefined),
    resync: () => Promise.resolve(),
    focus: () => Promise.resolve(),
    chat: () => Promise.resolve(),
  };
  const layer = createDataLayer(hub);
  root = createRoot(host);
  act(() => {
    root?.render(
      <DataProvider layer={layer}>
        <TooltipProvider>
          <ChatScreen project={project} />
        </TooltipProvider>
      </DataProvider>,
    );
  });
  act(() => {
    send(live());
    send(snapshot(1));
    layer.chat.open(KEY);
  });
  await settle();
  // A loaded machine takes longer than a few ticks to draw the page.
  await vi.waitFor(() => {
    expect(host.querySelectorAll("[data-bubble]")).toHaveLength(messages.reduce((n, m) => n + (m.parts?.length ?? 1), 0));
    expect(host.querySelector("[aria-busy]")).toBeNull();
  });
};

const line = () => host.querySelector("[data-attention]")?.textContent ?? null;
const show = async () => {
  const button = [...host.querySelectorAll<HTMLButtonElement>("[data-attention] button")].find((b) => b.textContent === "Show");
  expect(button).toBeDefined();
  act(() => button?.click());
  await settle();
};
/** The bubbles marked as what Show went to. */
const marked = () => [...host.querySelectorAll<HTMLElement>("[data-shown]")].map((el) => el.textContent);
const focused = () => (document.activeElement instanceof HTMLElement ? document.activeElement.textContent : null);

it("marks the bubble that asks, not the message around it, and moves focus to it", async () => {
  await mount([msg(1, { author: "human", text: "ship it" }), split(2, ["Built and tested on staging.", "Merge #12 now?"])]);
  expect(line()).toContain("1 question");
  expect(marked()).toEqual([]);
  await show();
  expect(marked()).toEqual(["Merge #12 now?"]);
  expect(focused()).toBe("Merge #12 now?");
  // One place to go: nothing to count.
  expect(line()).not.toContain(" of ");
});

it("steps through each thing it waits on, press by press, and says which", async () => {
  await mount([split(1, ["Two things before I ship.", "Merge #12 now?", "And tag v2.4 after?"])]);
  await show();
  expect(marked()).toEqual(["Merge #12 now?"]);
  expect(line()).toContain("1 of 2");
  // The palette and the live strip reach the same Show.
  act(() => void runCommand("chat.showWaiting"));
  await settle();
  expect(marked()).toEqual(["And tag v2.4 after?"]);
  expect(focused()).toBe("And tag v2.4 after?");
  expect(line()).toContain("2 of 2");
  await show();
  expect(marked()).toEqual(["Merge #12 now?"]);
  expect(focused()).toBe("Merge #12 now?");
  expect(line()).toContain("1 of 2");
});

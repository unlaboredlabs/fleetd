// @vitest-environment happy-dom
// Show, on the waiting-on-you line (and chat.showWaiting, from the palette and the live strip): it marks the exact
// bubble the lead waits on and moves focus to it, and with more than one it steps to the next on each press.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import type { ChatMessage, ProjectChatState } from "../../src/data/chat-contract";
import { createDataLayer, type HubApi } from "../../src/data/queries";
import { DataProvider } from "../../src/data/react";
import { AT, live, project, snapshot } from "../../src/data/fixtures.test-util";
import { TooltipProvider } from "../../ui/primitives/Tooltip";
import { runCommand } from "../palette";
import { ChatScreen } from "./ChatScreen";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.hoisted(() => vi.stubGlobal("fleetd", { platform: "darwin", fixture: null }));

// happy-dom has no layout, so this lays it out: the list `view` px tall, each row `row` px at its place in the list
// (as scrolled), and a message's bubbles `step` px apart in it, 20 px each. By default every row renders, 40 px.
const LAYOUT = { view: 2000, row: (_: HTMLElement) => 40, step: 0 };
let layout = LAYOUT;
const isList = (el: Element): boolean => el.getAttribute("role") === "list";
const isRow = (el: HTMLElement): boolean => el.dataset["index"] !== undefined;
const list = () => host.querySelector<HTMLElement>("[role=list]");
const heightOf = (el: HTMLElement) => (isList(el) ? layout.view : isRow(el) ? layout.row(el) : 0);
const rectOf = (el: HTMLElement): DOMRect | undefined => {
  if (isList(el)) return new DOMRect(0, 0, 600, layout.view);
  if (isRow(el)) return new DOMRect(0, Number(/translateY\(([-\d.]+)px\)/.exec(el.style.transform)?.[1] ?? 0) - (list()?.scrollTop ?? 0), 600, layout.row(el));
  const row = el.closest<HTMLElement>("[data-index]");
  const part = el.dataset["part"];
  if (row === null || part === undefined) return undefined;
  const top = rectOf(row)?.top ?? 0;
  return new DOMRect(0, top + Number(part) * layout.step, 300, 20);
};
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
  layout = LAYOUT;
  vi.spyOn(proto, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    return rectOf(this) ?? realRect.call(this);
  });
  Object.defineProperty(proto, "clientHeight", { configurable: true, get: function (this: HTMLElement) { return heightOf(this); } });
  Object.defineProperty(proto, "scrollHeight", {
    configurable: true,
    get: function (this: HTMLElement) {
      return isList(this) ? Number.parseFloat((this.firstElementChild as HTMLElement | null)?.style.height ?? "0") : 0;
    },
  });
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

/**
 * The chat on a live hub, waiting on you, with `messages` as its newest page; `older`, the pages before it, newest
 * first, one per request, once `hold` has settled.
 */
const mount = async (
  messages: ChatMessage[],
  opts: { older?: ChatMessage[][]; openItems?: ProjectChatState["openItems"]; hold?: Promise<void> } = {},
) => {
  const older = [...(opts.older ?? [])];
  let send: Parameters<HubApi["subscribe"]>[0] = () => undefined;
  const state = { projectRef: project, needsYou: true, leadWorking: false, lastSeq: messages.at(-1)?.seq ?? 0, openItems: opts.openItems };
  const page = { messages, moreBefore: older.length > 0, moreAfter: false, state };
  const before = () => ({ messages: older.shift() ?? [], moreBefore: older.length > 0, moreAfter: true, state });
  const hub: HubApi = {
    call: async (tool, input) => {
      if (tool !== "chat_history") return { ok: true, output: tool === "status_get" ? { rows: [] } : tool === "requests_list" ? { requests: [] } : {} };
      if ((input as { before?: number }).before === undefined) return { ok: true, output: page };
      await opts.hold;
      return { ok: true, output: before() };
    },
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
  // The count's live region is there, empty, before the first press, so a screen reader announces "1 of 2".
  const status = host.querySelector("[data-attention] [role=status]");
  expect(status?.textContent).toBe("");
  await show();
  expect(host.querySelector("[data-attention] [role=status]")).toBe(status);
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

/** Whether the bubble with these words is all inside the list's view. */
const inView = (words: string) => {
  const bubble = [...host.querySelectorAll<HTMLElement>("[data-part]")].find((el) => el.textContent === words);
  const r = bubble?.getBoundingClientRect();
  return r !== undefined && r.top >= 0 && r.bottom <= layout.view;
};

it("brings the bubble itself into view in a message taller than the view, and the next one in it on the next press", async () => {
  // The lead's message is 1600 px in a 300 px view, its bubbles 500 px apart: centring the message shows neither.
  layout = { view: 300, row: (el) => (el.textContent.includes("Merge") ? 1600 : 40), step: 500 };
  await mount([msg(1, { author: "human", text: "go ahead" }), split(2, ["Here is the table of results.", "Ship it?", "Merge #12 now?"])]);
  await show();
  expect(marked()).toEqual(["Ship it?"]);
  expect(inView("Ship it?")).toBe(true);
  await show();
  expect(marked()).toEqual(["Merge #12 now?"]);
  expect(inView("Merge #12 now?")).toBe(true);
  expect(inView("Ship it?")).toBe(false);
});

it("counts an approval on a page not loaded yet, and Show goes to it once that page is in", async () => {
  const approval = msg(1, {
    text: "",
    item: { kind: "command_approval", requestId: "Q1", machineId: "devbox", state: "open", gated: { argv: ["./deploy.sh", "prod"], class: "irreversible", reason: "prod deploy", timeoutSec: 600 } },
  });
  let release: () => void = () => undefined;
  const hold = new Promise<void>((done) => (release = done));
  await mount([msg(2, { author: "human", text: "ship it" }), msg(3, { text: "Done. Over to you." })], {
    older: [[approval]],
    openItems: [{ messageId: "m1", kind: "command_approval" }],
    hold,
  });
  // The newest page asks nothing; the hub's list says what still waits.
  expect(line()).toContain("1 command to approve");
  expect(host.textContent).not.toContain("./deploy.sh");
  await show();
  act(() => release());
  await vi.waitFor(() => expect(marked().join("")).toContain("./deploy.sh"));
  expect(focused()).toContain("./deploy.sh");
});

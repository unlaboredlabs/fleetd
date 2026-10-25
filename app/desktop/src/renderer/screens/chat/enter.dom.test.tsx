// @vitest-environment happy-dom
// Bubbles enter once, as they come in: a lead reply and your send do; what the chat opens with and what a reconnect
// reads back show still.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { HubFrame } from "../../../shared/hub";
import type { ChatMessage } from "../../src/data/chat-contract";
import { createDataLayer, type HubApi } from "../../src/data/queries";
import { DataProvider } from "../../src/data/react";
import { AT, live, project, snapshot } from "../../src/data/fixtures.test-util";
import { TooltipProvider } from "../../ui/primitives/Tooltip";
import { ChatScreen } from "./ChatScreen";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.hoisted(() => vi.stubGlobal("fleetd", { platform: "darwin", fixture: null }));

// happy-dom has no layout: the list is 2000 px tall, so every row renders; a row is 40 px.
const heightOf = (el: Element) => (el.getAttribute("role") === "list" ? 2000 : el instanceof HTMLElement && el.dataset["index"] !== undefined ? 40 : 0);
const proto = HTMLElement.prototype;
const realRect = proto.getBoundingClientRect.bind(proto);

let host: HTMLDivElement;
let root: Root | undefined;
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
  text: `message ${String(seq)}!`,
  createdAt: AT,
  ...patch,
});
const page = (messages: ChatMessage[]) => ({
  messages,
  moreBefore: false,
  moreAfter: false,
  state: { projectRef: project, needsYou: false, leadWorking: false, lastSeq: messages.at(-1)?.seq ?? 0 },
});
const messageEvent = (seq: number, m: ChatMessage): HubFrame => ({
  t: "event",
  event: { seq, at: AT, type: "chat.message", summary: "chat.message", data: { projectRef: project, messageId: m.messageId, seq: m.seq, author: m.author, state: m.state, message: m } },
});

const settle = async () => {
  for (let i = 0; i < 5; i++) await act(() => new Promise((done) => setTimeout(done, 0)));
};

/** The chat on a live hub; `pages` answers its chat_history reads in turn. */
const mount = async (pages: ChatMessage[][]) => {
  let send: Parameters<HubApi["subscribe"]>[0] = () => undefined;
  const hub: HubApi = {
    call: (tool) => {
      if (tool === "chat_history") return Promise.resolve({ ok: true, output: page(pages.shift() ?? []) });
      if (tool === "chat_send") return new Promise(() => undefined);
      return Promise.resolve({ ok: true, output: tool === "status_get" ? { rows: [] } : {} });
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
    // The shell opens the chat on screen.
    layer.chat.open(KEY);
  });
  await settle();
  return { send: (f: HubFrame) => act(() => send(f)), layer };
};

/** Each message's words, and whether its bubble enters. */
const shown = () =>
  [...host.querySelectorAll<HTMLElement>("[data-entry=message]")].map((m) => {
    const line = m.querySelector<HTMLElement>("[data-bubble]")?.parentElement;
    return [m.textContent.match(/message \d+(?=!)|hello/)?.[0], line?.style.getPropertyValue("--enter-since") !== ""] as const;
  });

it("opens still, and enters a lead reply and your send once each", async () => {
  const { send, layer } = await mount([[msg(1), msg(2)]]);
  expect(shown()).toEqual([
    ["message 1", false],
    ["message 2", false],
  ]);
  send(messageEvent(10, msg(3)));
  await settle();
  expect(shown()).toEqual([
    ["message 1", false],
    ["message 2", false],
    ["message 3", true],
  ]);
  act(() => void layer.chat.send(KEY, { text: "hello" }));
  await settle();
  expect(shown().at(-1)).toEqual(["hello", true]);
});

it("shows what a reconnect reads back still", async () => {
  const { send } = await mount([[msg(1)], [msg(1), msg(2), msg(3)]]);
  send({ t: "state", state: { phase: "retrying", hub: "devbox:4710", reason: "closed", retryAt: 1 } });
  send(live());
  send(snapshot(5));
  await settle();
  expect(shown()).toEqual([
    ["message 1", false],
    ["message 2", false],
    ["message 3", false],
  ]);
  send(messageEvent(10, msg(4)));
  await settle();
  expect(shown().at(-1)).toEqual(["message 4", true]);
});

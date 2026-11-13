// @vitest-environment happy-dom
// The tagged chat on screen (a project's trial): with it off, the chat is today's whatever the messages carry; on,
// a tag opens a lens on its order (Esc and × close it), what you send there is about it, About… moves a bubble, and a
// closed order's fold opens under its line.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import type { ChatMessage, FleetStatus, OrderCard } from "../../../../shared/contracts";
import { createDataLayer, type HubApi } from "../../../src/data/queries";
import { DataProvider } from "../../../src/data/react";
import { AT, live, project, snapshot } from "../../../src/data/fixtures.test-util";
import { TooltipProvider } from "../../../ui/primitives/Tooltip";
import { ChatScreen } from "../ChatScreen";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.hoisted(() => vi.stubGlobal("fleetd", { platform: "darwin", fixture: null }));

// happy-dom has no layout: the list is 2000 px tall and every row 40 px, so every row renders.
const isList = (el: Element): boolean => el.getAttribute("role") === "list";
const proto = HTMLElement.prototype;

let host: HTMLDivElement;
let root: Root | undefined;
beforeAll(async () => {
  await import("../../../ui/markdown/MarkdownBody");
});
beforeEach(() => {
  window.localStorage.clear();
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  Object.defineProperty(proto, "clientHeight", { configurable: true, get: function (this: HTMLElement) { return isList(this) ? 2000 : this.dataset["index"] !== undefined ? 40 : 0; } });
  Object.defineProperty(proto, "clientWidth", { configurable: true, get: () => 600 });
  host = document.createElement("div");
  document.body.appendChild(host);
});
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.stubGlobal("fleetd", { platform: "darwin", fixture: null });
});

const SAM = { personId: "P1", name: "Sam Rivera" };
const DANA = { personId: "P2", name: "Dana Park" };
const VAT = { workstreamId: "W1", title: "Receipts show the VAT number" };
const PAY = { workstreamId: "W2", title: "Apple Pay" };
const SEARCH = { workstreamId: "W3", title: "Search speed" };

const msg = (seq: number, patch: Partial<ChatMessage>): ChatMessage => ({
  messageId: `m${String(seq)}`,
  projectRef: project,
  seq,
  author: "lead",
  state: "final",
  text: `message ${String(seq)}`,
  createdAt: AT,
  ...patch,
});
const MESSAGES = [
  msg(1, { author: "human", person: DANA, about: VAT, text: "Receipts should show the VAT number." }),
  msg(2, { for: DANA, about: VAT, text: "Small fix, one writer on it." }),
  msg(3, { author: "human", person: SAM, about: PAY, text: "Can we add Apple Pay?" }),
  msg(4, { for: SAM, about: PAY, text: "On it: one writer at checkout." }),
  msg(5, { author: "human", person: DANA, about: SEARCH, text: "Search feels slow on my phone." }),
  msg(6, { for: DANA, about: SEARCH, text: "Looking: an agent is timing search." }),
  msg(7, { for: DANA, about: VAT, fold: { ...VAT, state: "done", count: 3 }, text: "Receipts show the VAT number now." }),
];

const card = (o: typeof PAY): OrderCard => ({
  ...o,
  projectRef: project,
  createdAt: AT,
  updatedAt: AT,
  phase: "working",
  phaseDetail: "1 working",
  state: "open",
  lanes: [],
  prs: [],
  needsYou: 0,
  settled: 0,
  total: 1,
});

/** The chat with MESSAGES, as Sam, on a project whose trial is `on`; what it called, by tool. */
const mount = async (on: boolean) => {
  let send: Parameters<HubApi["subscribe"]>[0] = () => undefined;
  const calls: Array<{ tool: string; input: Record<string, unknown> }> = [];
  const page = { messages: MESSAGES, moreBefore: false, moreAfter: false, state: { projectRef: project, needsYou: false, leadWorking: false, lastSeq: 7 } };
  const info = { busy: [], me: { ...SAM, role: "owner", createdAt: AT } };
  const hub: HubApi = {
    call: (tool, input) => {
      calls.push({ tool, input: input as Record<string, unknown> });
      const output =
        tool === "chat_history"
          ? page
          : tool === "hub_info"
            ? info
            : tool === "people_list"
              ? { people: [SAM, DANA] }
              : tool === "requests_list"
                ? { requests: [] }
                : tool === "orders_board"
                  ? { orders: [card(PAY), card(SEARCH)], trains: [], at: AT }
                  : tool === "chat_send"
                    ? { message: msg(8, { author: "human", person: SAM, text: String((input as { text: string }).text) }) }
                    : tool === "chat_about_set"
                      ? { message: { ...MESSAGES[5], about: PAY, updatedAt: "2026-10-19T10:05:00.000Z" } }
                      : {};
      return Promise.resolve({ ok: true, output } as never);
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
  const snap = snapshot(1) as { t: "snapshot"; snapshot: FleetStatus };
  const first = snap.snapshot.projects[0];
  if (first !== undefined && on) first.chatTags = true;
  act(() => {
    send(live());
    send(snap);
    layer.chat.open("devbox/storefront");
  });
  for (let i = 0; i < 5; i++) await act(() => new Promise((done) => setTimeout(done, 0)));
  await vi.waitFor(() => expect(host.querySelectorAll('[data-entry="message"]').length).toBeGreaterThan(0));
  if (on) await vi.waitFor(() => expect(host.querySelector("[data-tag]")).not.toBeNull());
  return calls;
};

/** Each message's words as shown, with its line over it in brackets (its parts joined by the dot CSS draws). */
const shown = () =>
  [...host.querySelectorAll<HTMLElement>('[data-entry="message"]')].map((el) => {
    const line = el.querySelector("[data-tag]");
    const tag = line === null ? el.querySelector("[data-head]")?.textContent : [...line.children].map((c) => c.textContent).join("·");
    const words = el.querySelector("[data-bubble]")?.textContent ?? "";
    return tag === undefined || tag === "" ? words : `[${tag}] ${words}`;
  });
const button = (name: string, within: ParentNode = document): HTMLElement => {
  const found = [...within.querySelectorAll<HTMLElement>("button")].find((b) => b.getAttribute("aria-label") === name || b.textContent === name);
  if (found === undefined) throw new Error(`no button ${name}`);
  return found;
};
const settle = async () => {
  for (let i = 0; i < 3; i++) await act(() => new Promise((done) => setTimeout(done, 0)));
};
const rightClick = (target: Element) =>
  act(() => {
    target.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }));
  });
const menuItems = () => [...document.querySelectorAll("[role='menu'] [role='menuitem']")].map((i) => i.textContent);

it("is today's chat with the trial off, whatever the messages carry", async () => {
  await mount(false);
  expect(host.querySelector("[data-tag]")).toBeNull();
  expect(host.querySelector('[data-entry="fold"]')).toBeNull();
  expect(shown()).toHaveLength(7);
  const bubble = [...host.querySelectorAll("[data-bubble]")].find((b) => b.textContent === "Looking: an agent is timing search.");
  if (bubble === undefined) throw new Error("no bubble");
  rightClick(bubble);
  expect(menuItems()).not.toContain("About…");
});

it("tags each run, folds the closed order, and opens the fold under its line", async () => {
  await mount(true);
  expect(shown()).toEqual([
    "[Apple Pay] Can we add Apple Pay?",
    "[Apple Pay] On it: one writer at checkout.",
    "[Dana Park·Search speed] Search feels slow on my phone.",
    "[to Dana·Search speed] Looking: an agent is timing search.",
  ]);
  const fold = host.querySelector<HTMLButtonElement>('[data-entry="fold"] button');
  expect(fold?.textContent).toBe("Receipts show the VAT number3 messages");
  act(() => fold?.click());
  await settle();
  expect(fold?.getAttribute("aria-expanded")).toBe("true");
  expect(shown().slice(4)).toEqual(["[Dana Park] Receipts should show the VAT number.", "[to Dana] Small fix, one writer on it.", "Receipts show the VAT number now."]);
});

it("opens a lens from a tag: only its order, sent about it, and Esc goes back to the whole chat", async () => {
  const calls = await mount(true);
  act(() => button("Only Search speed").click());
  await settle();
  expect(shown()).toEqual(["[Dana Park] Search feels slow on my phone.", "[to Dana] Looking: an agent is timing search."]);
  // Its capsule goes in the window's top row, which this test has none of (the screen checks shoot it).
  const box = host.querySelector("textarea");
  if (box === null) throw new Error("no composer");
  expect(box.placeholder).toBe("Message the lead about Search speed");
  act(() => {
    box.focus();
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(box, "and on the cart page");
    box.dispatchEvent(new Event("input", { bubbles: true }));
  });
  act(() => {
    box.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  });
  await settle();
  expect(calls.find((c) => c.tool === "chat_send")?.input).toMatchObject({ text: "and on the cart page", about: "W3" });
  act(() => {
    box.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  });
  await settle();
  expect(shown()[0]).toBe("[Apple Pay] Can we add Apple Pay?");
});

it("moves a bubble to another open order from its menu's About…", async () => {
  const calls = await mount(true);
  const bubble = [...host.querySelectorAll("[data-bubble]")].find((b) => b.textContent === "Looking: an agent is timing search.");
  if (bubble === undefined) throw new Error("no bubble");
  rightClick(bubble);
  const about = [...document.querySelectorAll<HTMLElement>("[role='menuitem']")].find((i) => i.textContent === "About…");
  if (about === undefined) throw new Error("no About…");
  act(() => {
    about.focus();
    about.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
  });
  await settle();
  // The open orders, a check on its own, then Nothing.
  expect(menuItems().slice(-3)).toEqual(["Apple Pay", "Search speed", "Nothing"]);
  const pay = [...document.querySelectorAll<HTMLElement>("[role='menuitem']")].find((i) => i.textContent === "Apple Pay");
  act(() => pay?.click());
  await settle();
  expect(calls.find((c) => c.tool === "chat_about_set")?.input).toEqual({ projectRef: project, messageId: "m6", workstreamId: "W2" });
  await vi.waitFor(() => expect(shown()).toContain("[to Dana·Apple Pay] Looking: an agent is timing search."));
});

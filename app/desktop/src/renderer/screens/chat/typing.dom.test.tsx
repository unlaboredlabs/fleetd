// @vitest-environment happy-dom
// Typing renders the composer and nothing else: not the chat's list, its bubbles, the lead's activity or the screen
// around them. A key that renders more than the box does work the animations wait for (W95).
import { renders } from "../../ui/lib/renders.test-util";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { HubApi } from "../../src/data/queries";
import { createDataLayer } from "../../src/data/queries";
import { DataProvider } from "../../src/data/react";
import { AT, live, liveLane, project, snapshot } from "../../src/data/fixtures.test-util";
import { leadLaneId } from "../../src/data/selectors";
import { projectKey } from "../../src/data/store";
import { TooltipProvider } from "../../ui/primitives/Tooltip";
import { ChatScreen } from "./ChatScreen";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.hoisted(() => vi.stubGlobal("fleetd", { platform: "darwin", fixture: null }));

/** What a key may render: the box's own component and its words under the tools. */
const COMPOSER = new Set(["ChatComposer", "Text"]);
/** Rendered as the screen mounts, and never again for a key. */
const EXPENSIVE = ["ChatScreen", "AttentionLine", "ChatList", "RowView", "MessageView", "Markdown", "LeadActivity"];

let root: Root | undefined;
const host = document.createElement("div");
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  vi.restoreAllMocks();
});

// happy-dom has no layout: the list's scroller is 600 px tall and each row 50 px, so every row renders.
const layout = () => {
  const heightOf = (el: Element) => (el.getAttribute("role") === "list" ? 600 : el instanceof HTMLElement && el.dataset["index"] !== undefined ? 50 : 0);
  const proto = HTMLElement.prototype;
  const realRect = proto.getBoundingClientRect.bind(proto);
  vi.spyOn(proto, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const h = heightOf(this);
    return h ? new DOMRect(0, 0, 400, h) : realRect.call(this);
  });
  vi.spyOn(proto, "clientHeight", "get").mockImplementation(function (this: HTMLElement) {
    return heightOf(this);
  });
};

/** The chat of a project whose lead is at work, with a few messages either way. */
const mount = async () => {
  let send: Parameters<HubApi["subscribe"]>[0] = () => undefined;
  const messages = Array.from({ length: 8 }, (_, i) => ({
    messageId: `m${i + 1}`,
    projectRef: project,
    seq: i + 1,
    author: i % 2 === 0 ? "human" : "lead",
    state: "final",
    text: i % 2 === 0 ? `Round the cart totals, step ${i + 1}.` : `On it: the writers split step ${i} into **three** PRs.`,
    createdAt: AT,
  }));
  const answers: Readonly<Record<string, unknown>> = {
    status_get: { rows: [{ projectRef: project, title: "storefront", asOf: AT, agentsRunning: 3, state: "working" }] },
    orders_board: { orders: [] },
    chat_history: { messages, moreBefore: false, moreAfter: false, state: { projectRef: project, needsYou: false, leadWorking: true, lastSeq: messages.length } },
  };
  const hub: HubApi = {
    call: (tool) => Promise.resolve({ ok: true, output: answers[tool] ?? {} } as never),
    subscribe: (l) => ((send = l), () => undefined),
    resync: () => Promise.resolve(),
    focus: () => Promise.resolve(),
    chat: () => Promise.resolve(),
  };
  const layer = createDataLayer(hub);
  layer.chat.open(projectKey(project));
  document.body.appendChild(host);
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
    send({ t: "live", frame: { at: AT, full: true, lanes: [liveLane(leadLaneId(project), "working")] } });
  });
  for (let i = 0; i < 5; i++) await act(() => new Promise((done) => setTimeout(done, 0)));
};

const type = (box: HTMLTextAreaElement, text: string) => {
  for (const key of text) {
    act(() => {
      box.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(box, box.value + key);
      box.selectionStart = box.selectionEnd = box.value.length;
      box.dispatchEvent(new Event("input", { bubbles: true }));
      box.dispatchEvent(new KeyboardEvent("keyup", { key, bubbles: true }));
    });
  }
};

it("renders the composer and nothing else while you type", async () => {
  layout();
  renders.reset();
  await mount();
  // The screen is all there, so a render of any of it below would count.
  for (const name of EXPENSIVE) expect(renders.counts.get(name), name).toBeGreaterThan(0);
  expect(host.querySelectorAll("[data-index]").length).toBeGreaterThanOrEqual(8);
  expect(host.querySelector("[data-entry='activity'][data-turn='running']")).not.toBeNull();

  const box = host.querySelector<HTMLTextAreaElement>("textarea[aria-label='Message the lead']");
  if (box === null) throw new Error("no composer");
  // The first key makes the message sendable, which draws Send enabled once.
  type(box, "T");
  renders.reset();
  const words = "he writer ran the tests again";
  type(box, words);
  expect(box.value).toBe(`T${words}`);

  const rendered = Object.fromEntries(renders.counts);
  for (const name of EXPENSIVE) expect(rendered[name], `${name} rendered while you typed`).toBeUndefined();
  expect(Object.keys(rendered).filter((name) => !COMPOSER.has(name)), "rendered while you typed, besides the composer").toEqual([]);
  // One render of the box per key, two at most (an echo of the caret).
  expect(rendered["ChatComposer"] ?? 0).toBeLessThanOrEqual(words.length * 2);
});

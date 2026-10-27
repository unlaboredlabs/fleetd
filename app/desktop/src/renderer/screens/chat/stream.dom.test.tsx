// @vitest-environment happy-dom
// A streamed reply renders its own message and nothing else: not the bubbles above it, with or without something to
// look at in the top bar (W96). Every word of a reply would otherwise draw the whole chat again.
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
import { AppFrame, TopBar } from "../../ui/layout/Layout";
import { ChatScreen } from "./ChatScreen";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.hoisted(() => vi.stubGlobal("fleetd", { platform: "darwin", fixture: null }));


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
const mount = async (nudges: boolean) => {
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
  // The lead's reply, still streaming.
  messages.push({ messageId: "m9", projectRef: project, seq: 9, author: "lead", state: "streaming", text: "Reading", createdAt: AT });
  // Flagged a minute ago: the test runs on the real clock, and a flag fades after a day.
  const look = nudges ? { nudges: [{ messageId: "m2", reason: "the three PRs", at: new Date(Date.now() - 60_000).toISOString() }] } : {};
  const answers: Readonly<Record<string, unknown>> = {
    status_get: { rows: [{ projectRef: project, title: "storefront", asOf: AT, agentsRunning: 3, state: "working" }] },
    orders_board: { orders: [] },
    chat_history: { messages, moreBefore: false, moreAfter: false, state: { projectRef: project, needsYou: false, leadWorking: true, lastSeq: messages.length, ...look } },
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
          {/* In the window's frame, as in the app: the screen's title and what needs you sit in its top bar. */}
          <AppFrame topBar={<TopBar />}>
            <ChatScreen project={project} />
          </AppFrame>
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
  return send;
};


for (const nudges of [false, true]) {
  it(`renders only the streaming message for each word${nudges ? ", with something to look at" : ""}`, async () => {
    layout();
    renders.reset();
    const send = await mount(nudges);
    expect(renders.counts.get("MessageView") ?? 0).toBeGreaterThanOrEqual(9);
    if (nudges) expect(host.textContent).toContain("1 to look at");
    renders.reset();
    let text = "Reading";
    for (const word of [" the", " proposal", " and", " the", " tests"]) {
      act(() => send({ t: "chat_delta", delta: { projectRef: project, messageId: "m9", seq: 9, offset: text.length, append: word } }));
      text += word;
    }
    // One message a word: the one streaming. The others, their bubbles and their markdown stay as they were.
    expect(renders.counts.get("MessageView") ?? 0).toBeLessThanOrEqual(5);
    expect(renders.counts.get("BubbleLine")).toBeUndefined();
    expect(renders.counts.get("Markdown")).toBeUndefined();
  });
}

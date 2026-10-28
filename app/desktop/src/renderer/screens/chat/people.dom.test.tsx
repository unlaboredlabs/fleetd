// @vitest-environment happy-dom
// A project chat the team shares: another person's message shows their name over it and draws as theirs; yours, and
// every human message on a hub from before people, still read as yours.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import type { ChatMessage } from "../../src/data/chat-contract";
import { createDataLayer, type HubApi } from "../../src/data/queries";
import { DataProvider } from "../../src/data/react";
import { AT, live, project, snapshot } from "../../src/data/fixtures.test-util";
import { TooltipProvider } from "../../ui/primitives/Tooltip";
import { ChatScreen } from "./ChatScreen";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.hoisted(() => vi.stubGlobal("fleetd", { platform: "darwin", fixture: null }));

// happy-dom has no layout: the list is 2000 px tall and every row 40 px, so every row renders.
const isList = (el: Element): boolean => el.getAttribute("role") === "list";
const proto = HTMLElement.prototype;

let host: HTMLDivElement;
let root: Root | undefined;
beforeAll(async () => {
  await import("../../ui/markdown/MarkdownBody");
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

const SAM = { personId: "P1", name: "Sam Ortiz" };
const PRIYA = { personId: "P2", name: "Priya Nair" };
const msg = (seq: number, patch: Partial<ChatMessage>): ChatMessage => ({
  messageId: `m${String(seq)}`,
  projectRef: project,
  seq,
  author: "human",
  state: "final",
  text: `message ${String(seq)}`,
  createdAt: AT,
  ...patch,
});
const MESSAGES = [
  msg(1, { person: SAM, text: "Can shoppers save their cart?" }),
  msg(2, { person: PRIYA, text: "And keep it on the iPhone app too." }),
  msg(3, { author: "lead", text: "Sam, Priya: both in one order." }),
];

/** The chat with MESSAGES, on a hub whose hub_info names `me` (a hub from before people names no one). */
const mount = async (me: typeof SAM | undefined) => {
  let send: Parameters<HubApi["subscribe"]>[0] = () => undefined;
  const page = { messages: MESSAGES, moreBefore: false, moreAfter: false, state: { projectRef: project, needsYou: false, leadWorking: false, lastSeq: 3 } };
  const info = { busy: [], ...(me === undefined ? {} : { me: { ...me, role: "member", createdAt: AT } }) };
  const hub: HubApi = {
    call: (tool) => {
      const output = tool === "chat_history" ? page : tool === "hub_info" ? info : tool === "requests_list" ? { requests: [] } : {};
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
  act(() => {
    send(live());
    send(snapshot(1));
    layer.chat.open("devbox/storefront");
  });
  for (let i = 0; i < 5; i++) await act(() => new Promise((done) => setTimeout(done, 0)));
  await vi.waitFor(() => expect(host.querySelectorAll('[data-entry="message"]').length).toBe(3));
};

/** Each message as the chat draws it: the name over it (or -), and whether it is on your side. */
const shown = () =>
  [...host.querySelectorAll<HTMLElement>('[data-entry="message"]')].map(
    (el) => `${el.querySelector("[data-head]")?.textContent ?? "-"}:${el.hasAttribute("data-mine") ? "mine" : "theirs"}`,
  );

it("names another person over their message and draws it as theirs; yours stay yours", async () => {
  await mount(SAM);
  await vi.waitFor(() => expect(shown()).toEqual(["-:mine", "Priya Nair:theirs", "-:theirs"]));
});

it("reads every human message as yours on a hub from before people", async () => {
  await mount(undefined);
  expect(shown()).toEqual(["-:mine", "-:mine", "-:theirs"]);
  expect(host.textContent).not.toContain("Priya Nair");
});

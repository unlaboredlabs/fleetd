// @vitest-environment happy-dom
// What there is to look at, in the top bar after the chat's title: a message the lead nudged you about, or an
// agent's Try it suggestion. "1 to look at" with its reason, below what the lead waits on you for; Show goes to it,
// marks it and clears it as seen; Dismiss clears it; kept in view for a moment while the window has focus, it is
// seen too.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import type { ChatMessage, ProjectChatState } from "../../src/data/chat-contract";
import { createDataLayer, type HubApi } from "../../src/data/queries";
import { DataProvider } from "../../src/data/react";
import { AT, event, live, project, snapshot } from "../../src/data/fixtures.test-util";
import { TooltipProvider } from "../../ui/primitives/Tooltip";
import { AppFrame, TopBar } from "../../ui/layout/Layout";
import { ChatScreen } from "./ChatScreen";
import { LOOK_MS } from "./looked";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.hoisted(() => vi.stubGlobal("fleetd", { platform: "darwin", fixture: null }));

// happy-dom has no layout: the list is 2000 px tall and every row 40 px, so every row renders.
const isList = (el: Element): boolean => el.getAttribute("role") === "list";
const proto = HTMLElement.prototype;

/** The intersection observers the chat made, by the element each watches, to say what is in view. */
let watched: { el: Element; cb: IntersectionObserverCallback }[] = [];
let focused = true;

let host: HTMLDivElement;
let root: Root | undefined;
beforeAll(async () => {
  await import("../../ui/markdown/MarkdownBody");
});
beforeEach(() => {
  window.localStorage.clear();
  watched = [];
  focused = true;
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      constructor(private readonly cb: IntersectionObserverCallback) {}
      observe(el: Element) {
        watched.push({ el, cb: this.cb });
      }
      disconnect() {
        watched = watched.filter((w) => w.cb !== this.cb);
      }
    },
  );
  vi.spyOn(document, "hasFocus").mockImplementation(() => focused);
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

const KEY = "devbox/storefront";
const HOUR = 3600_000;
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
/** Flagged `ago` ms before now. */
const nudge = (seq: number, reason: string, ago = HOUR) => ({ messageId: `m${String(seq)}`, reason, at: new Date(Date.now() - ago).toISOString() });

const settle = async () => {
  for (let i = 0; i < 5; i++) await act(() => new Promise((done) => setTimeout(done, 0)));
};

/** What the chat asked the hub to clear: message id, and whether dismissed. */
let clears: { messageId: string; dismissed?: boolean }[] = [];

/** The chat with `messages` and chat state `state`, the project's Status row `row`; `say` tells it a new chat state. */
const mount = async (messages: ChatMessage[], state: Partial<ProjectChatState>, row: Record<string, unknown> = {}) => {
  clears = [];
  let send: Parameters<HubApi["subscribe"]>[0] = () => undefined;
  const base = { projectRef: project, needsYou: false, leadWorking: false, lastSeq: messages.at(-1)?.seq ?? 0 };
  const page = { messages, moreBefore: false, moreAfter: false, state: { ...base, ...state } };
  const rows = { rows: [{ projectRef: project, title: "storefront", asOf: AT, agentsRunning: 0, state: "idle", ...row }] };
  const hub: HubApi = {
    call: (tool, input) => {
      if (tool === "chat_nudge_clear") clears.push(input as (typeof clears)[number]);
      const output = tool === "chat_history" ? page : tool === "status_get" ? rows : tool === "requests_list" ? { requests: [] } : { ok: true };
      return Promise.resolve({ ok: true, output });
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
          {/* The frame's top row, where the chat's title and what needs you show. */}
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
    layer.chat.open(KEY);
  });
  await settle();
  await vi.waitFor(() => expect(host.querySelectorAll("[data-entry]").length).toBeGreaterThanOrEqual(messages.length));
  let seq = 100;
  return { say: (next: Partial<ProjectChatState>) => send(event(++seq, "chat.waiting", { ...base, ...next })) };
};

const line = () => host.querySelector("[data-attention]")?.textContent ?? null;
const press = async (words: string) => {
  const button = [...host.querySelectorAll<HTMLButtonElement>("[data-attention] button")].find((b) => b.textContent === words);
  expect(button).toBeDefined();
  act(() => button?.click());
  await settle();
};
const marked = () => [...host.querySelectorAll<HTMLElement>("[data-shown]")].map((el) => el.textContent);
const cleared = () => clears.map((c) => [c.messageId, c.dismissed === true ? "dismissed" : "seen"]);

/** Says the row holding `words` is `ratio` in view, as its observer would. */
const view = (words: string, ratio: number) => {
  const w = watched.find((x) => x.el.textContent.includes(words));
  expect(w).toBeDefined();
  act(() => {
    w?.cb(
      [{ isIntersecting: ratio > 0, intersectionRatio: ratio, intersectionRect: new DOMRect(0, 0, 600, 40 * ratio), rootBounds: new DOMRect(0, 0, 600, 2000) } as unknown as IntersectionObserverEntry],
      {} as IntersectionObserver,
    );
  });
};

it("says what there is to look at, and Show goes to it, marks it and counts as seeing it", async () => {
  await mount([msg(1, { author: "human", text: "how is the redesign?" }), msg(2, { text: "The Machines page redesign is up." }), msg(3, { text: "Also: CI is green." })], {
    nudges: [nudge(2, "the Machines page redesign")],
  });
  expect(line()).toContain("1 to look at: the Machines page redesign");
  expect(marked()).toEqual([]);
  await press("Show");
  expect(marked()).toEqual(["The Machines page redesign is up."]);
  expect(document.activeElement?.textContent).toBe("The Machines page redesign is up.");
  expect(cleared()).toEqual([["m2", "seen"]]);
  // Seen, it no longer waits: the line goes, while the mark fades.
  expect(host.querySelector("[data-attention]")).toBeNull();
});

it("ranks below what the lead waits on you for", async () => {
  await mount([msg(1, { text: "The new checkout is up." }), msg(2, { text: "1. Ship it today?" })], {
    needsYou: true,
    nudges: [nudge(1, "the new checkout")],
  });
  expect(line()).toContain("Waiting on you: 1 question");
  expect(line()).not.toContain("to look at");
});

it("keeps a red main in view after it", async () => {
  await mount([msg(1, { text: "The new checkout is up." })], { nudges: [nudge(1, "the new checkout")] }, { state: "working", warning: "`rust (macos)` is red on main" });
  expect(line()).toMatch(/1 to look at: the new checkout.*Show.*Dismiss.*rust \(macos\) is red on main/);
});

it("shows one again when the lead flags it again after you saw it", async () => {
  const layer = await mount([msg(1, { text: "The pricing page draft." }), msg(2, { text: "More." })], { nudges: [nudge(1, "the pricing page", 2 * HOUR)] });
  await press("Show");
  expect(cleared()).toEqual([["m1", "seen"]]);
  expect(host.querySelector("[data-attention]")).toBeNull();
  // The lead flags it again: the hub lists it with a new time.
  act(() => layer.say({ nudges: [nudge(1, "the pricing page, now with prices")] }));
  await settle();
  expect(line()).toContain("1 to look at: the pricing page, now with prices");
});

it("counts every one waiting, names the oldest, and Dismiss clears that one", async () => {
  await mount([msg(1, { text: "Pricing page draft." }), msg(2, { text: "Billing migration risk." })], {
    nudges: [nudge(1, "the pricing page", 2 * HOUR), nudge(2, "a risk in the billing migration")],
  });
  expect(line()).toContain("2 to look at: the pricing page");
  await press("Dismiss");
  expect(cleared()).toEqual([["m1", "dismissed"]]);
  expect(line()).toContain("1 to look at: a risk in the billing migration");
});

it("lets one a day old fade on its own", async () => {
  await mount([msg(1, { text: "Old showcase." })], { nudges: [nudge(1, "an old showcase", 25 * HOUR)] });
  expect(host.querySelector("[data-attention]")).toBeNull();
});

it("clears one once half of it stays in view for a moment while the window has focus", async () => {
  await mount([msg(1, { text: "The onboarding flow is ready to try." }), msg(2, { text: "Nothing else." })], {
    nudges: [nudge(1, "the onboarding flow")],
  });
  // The chat's own timers only from here: the look's moment passes when the test says.
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const wait = (ms: number) => act(() => void vi.advanceTimersByTime(ms));
  try {
    // A glimpse is not a look.
    view("onboarding flow is ready", 0.2);
    wait(LOOK_MS);
    expect(cleared()).toEqual([]);
    // Nor is a row the list passes on its way to where it opens.
    view("onboarding flow is ready", 1);
    wait(LOOK_MS / 2);
    view("onboarding flow is ready", 0);
    wait(LOOK_MS);
    expect(cleared()).toEqual([]);
    // Nor a message in view while you are in another window.
    focused = false;
    view("onboarding flow is ready", 1);
    wait(LOOK_MS);
    expect(cleared()).toEqual([]);
    // Back to the window, it is still there: seen, a moment on.
    focused = true;
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    wait(LOOK_MS);
    expect(cleared()).toEqual([["m1", "seen"]]);
  } finally {
    vi.useRealTimers();
  }
  await settle();
  expect(host.querySelector("[data-attention]")).toBeNull();
});

it("shows an agent's Try it suggestion as one to look at, and Show goes to its line", async () => {
  const suggestion = {
    projectRef: project,
    of: { kind: "pr" as const, repo: "acme/storefront", number: 14 },
    by: "#14's writer",
    why: "the checkout's buttons read differently in German",
    at: AT,
  };
  await mount(
    [
      msg(1, { text: "Checkout copy is in review." }),
      msg(2, { author: "agent", text: "#14's writer suggests trying #14: the checkout's buttons read differently in German", previewSuggestion: suggestion }),
    ],
    { nudges: [nudge(2, "Try #14: the checkout's buttons read differently in German")] },
  );
  expect(line()).toContain("1 to look at: Try #14: the checkout's buttons read differently in German");
  await press("Show");
  expect(marked().join("")).toContain("suggests trying it");
  expect(cleared()).toEqual([["m2", "seen"]]);
});

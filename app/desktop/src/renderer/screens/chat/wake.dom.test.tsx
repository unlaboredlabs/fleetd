// @vitest-environment happy-dom
// A cloud bot waking (W792): while its computer starts, its bot stands in the reply's place with the step's word, and
// the island over the composer doesn't say it again; once its lead thinks, the bot says so, then its step in plain words
// for the rest of the turn (W949), never typing dots; a failed try says why, and Try again asks the hub to start now.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { Activity } from "../../../shared/contracts";
import { HOLD_MS } from "../../../shared/steady";
import type { HubApi } from "../../src/data/queries";
import { createDataLayer } from "../../src/data/queries";
import { DataProvider } from "../../src/data/react";
import { AT, event, live, liveLane, project, snapshot } from "../../src/data/fixtures.test-util";
import { leadLaneId } from "../../src/data/selectors";
import { projectKey } from "../../src/data/store";
import { AppFrame, TopBar } from "../../ui/layout/Layout";
import { TooltipProvider } from "../../ui/primitives/Tooltip";
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

const ASK = { messageId: "m1", projectRef: project, seq: 1, author: "human", state: "final", text: "Why is checkout slow on phones?", createdAt: AT };
const later = (s: number) => new Date(Date.parse(AT) + s * 1000).toISOString();
const flush = async () => {
  for (let i = 0; i < 5; i++) await act(() => new Promise((done) => setTimeout(done, 0)));
};

/** The chat of a cloud bot whose lead's computer starts: you asked, and its lead is at work. */
const mount = async (
  startNow: { ok: true; output: unknown } | { ok: false; error: { code: string; message: string } } = { ok: true, output: { started: true } },
  chatState: Record<string, unknown> = { leadWorking: true },
) => {
  let send: Parameters<HubApi["subscribe"]>[0] = () => undefined;
  const calls: string[] = [];
  const answers: Readonly<Record<string, unknown>> = {
    status_get: { rows: [{ projectRef: project, title: "storefront", asOf: AT, agentsRunning: 0, state: "working" }] },
    orders_board: { orders: [] },
    chat_history: { messages: [ASK], moreBefore: false, moreAfter: false, state: { projectRef: project, needsYou: false, lastSeq: 1, ...chatState } },
  };
  const hub: HubApi = {
    call: (tool) => {
      calls.push(tool);
      if (tool === "chat_start_now") return Promise.resolve(startNow as never);
      return Promise.resolve({ ok: true, output: answers[tool] ?? {} } as never);
    },
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
  });
  await flush();
  const lead = async (activity: Activity, at = AT) => {
    act(() => send({ t: "live", frame: { at, full: true, lanes: [liveLane(leadLaneId(project), "working", { activity: { activity, since: at } })] } }));
    await flush();
  };
  return { send, calls, lead };
};

const wake = () => host.querySelector<HTMLElement>("[data-wake]");

it("the bot stands in the reply's place while its computer starts, and the island doesn't say it again", async () => {
  layout();
  const n = await mount();
  await n.lead({ kind: "starting", text: "Starting its computer at boat.dev", step: "box", startedAt: AT });
  expect(wake()?.dataset["wake"]).toBe("waking");
  expect(wake()?.textContent).toContain("Waking up");
  expect(host.textContent).not.toContain("Starting its computer at boat.dev");
  await n.lead({ kind: "starting", text: "Putting its files on its computer", step: "files", startedAt: AT });
  expect(wake()?.textContent).toContain("Getting its files");
  // Its lead thinks: the bot says so.
  await n.lead({ kind: "thinking" });
  expect(wake()?.dataset["wake"]).toBe("thinking");
  expect(wake()?.getAttribute("aria-label")).toBe("Thinking");
  // Its first words stream: the bot says it writes, and no dots stand in for them.
  act(() => n.send(event(2, "chat.message", { projectRef: project, messageId: "m2", seq: 2, author: "lead", state: "streaming", message: { ...ASK, messageId: "m2", seq: 2, author: "lead", state: "streaming", text: "" } })));
  await n.lead({ kind: "writing" });
  expect(wake()?.dataset["wake"]).toBe("writing");
  expect(wake()?.getAttribute("aria-label")).toBe("Writing");
  expect(host.querySelector("[data-typing]")).toBeNull();
  // The reply lands, and the lead works on after it: the bot stays under the reply, saying what the lead does.
  const reply = { ...ASK, messageId: "m2", seq: 2, author: "lead", state: "final", text: "The photos load at full size on phones." };
  act(() => n.send(event(3, "chat.message", { projectRef: project, messageId: "m2", seq: 2, author: "lead", state: "final", message: reply })));
  await n.lead({ kind: "read", path: "src/checkout/photos.ts" });
  expect(host.textContent).toContain("The photos load at full size on phones.");
  expect(wake()?.dataset["wake"]).toBe("working");
  // The line holds a second at least before the next (shared/steady.ts).
  await act(() => new Promise((done) => setTimeout(done, HOLD_MS + 100)));
  expect(wake()?.getAttribute("aria-label")).toBe("Reading photos.ts");
  expect(host.querySelector("[data-island]")).toBeNull();
  expect(host.textContent).not.toContain("Starting its computer");
});

it("a failed try says why, counts down to its retry, and Try again asks the hub to start now", async () => {
  layout();
  const n = await mount();
  await n.lead({ kind: "starting", text: "Starting its computer at boat.dev: …", step: "box", startedAt: AT, failed: { reason: "No computer was free", retryAt: later(9) } });
  expect(wake()?.dataset["wake"]).toBe("failed");
  expect(wake()?.textContent).toContain("Couldn’t wake up. No computer was free.");
  const button = [...host.querySelectorAll("button")].find((b) => b.textContent.startsWith("Try again"));
  expect(button?.textContent).toMatch(/^Try again · \d+s$/u);
  act(() => button?.click());
  await flush();
  expect(n.calls).toContain("chat_start_now");
});

it("a start its team's billing holds says so plainly, with no Try again: no try fixes it", async () => {
  layout();
  const n = await mount();
  await n.lead({ kind: "starting", text: "…", step: "box", startedAt: AT, failed: { reason: "This workspace reached its spend cap" } });
  expect(wake()?.dataset["wake"]).toBe("held");
  expect(wake()?.textContent).toContain("The lead can’t start now: this workspace reached its spend cap.");
  expect(wake()?.textContent).not.toContain("Couldn’t wake up");
  expect([...host.querySelectorAll("button")].some((b) => b.textContent.startsWith("Try again"))).toBe(false);
});

it("Try again that starts nothing says why in the row: the hub's word, or that nothing waited, or the error", async () => {
  layout();
  const cases: [Parameters<typeof mount>[0], string][] = [
    [{ ok: true, output: { started: false, next: "Your workspace is out of credits. It goes on by itself once that is done." } }, "Your workspace is out of credits."],
    [{ ok: true, output: { started: false } }, "Nothing to retry"],
    [{ ok: false, error: { code: "offline", message: "The workspace isn't connected." } }, "Couldn’t try again: The workspace isn't connected"],
  ];
  for (const [answer, says] of cases) {
    const n = await mount(answer);
    await n.lead({ kind: "starting", text: "…", step: "box", startedAt: AT, failed: { reason: "No computer was free", retryAt: later(9) } });
    const button = [...host.querySelectorAll("button")].find((b) => b.textContent.startsWith("Try again"));
    act(() => button?.click());
    await flush();
    expect(wake()?.textContent).toContain(says);
    act(() => root?.unmount());
    root = undefined;
  }
});

// W852, W949: an awake bot's turn on your message has the bot in the reply's place too, its step in plain words beside
// it: one sign that the lead is on it, so the island says nothing of the lead. Pressed, the line opens the turn's steps.
it("an awake bot's turn on your message: the bot with its step in words, and nothing of it in the island", async () => {
  layout();
  const n = await mount();
  await n.lead({ kind: "edit", path: "src/a.ts" });
  expect(wake()?.dataset["wake"]).toBe("working");
  expect(wake()?.querySelector("[data-typing]")).toBeNull();
  await act(() => new Promise((done) => setTimeout(done, HOLD_MS + 100)));
  const line = wake()?.querySelector("button");
  expect(wake()?.getAttribute("aria-label")).toBe("Editing a.ts");
  expect(host.querySelector("[data-island]")).toBeNull();
  act(() => line?.click());
  await flush();
  expect(line?.getAttribute("aria-expanded")).toBe("true");
  expect(document.querySelector("[aria-label='The lead’s steps this turn'][role='dialog']")).not.toBeNull();
});

it("opened after a quiet turn ended while the app was away: the hub's leadIdleAt says so, and no bot waits", async () => {
  layout();
  await mount(undefined, { leadWorking: false, leadIdleAt: later(5) });
  await flush();
  expect(wake()).toBeNull();
});

it("goes when the lead's turn ends without a reply, a quiet one, and stays gone", async () => {
  layout();
  const n = await mount();
  await n.lead({ kind: "thinking" });
  expect(wake()?.dataset["wake"]).toBe("thinking");
  act(() => n.send(event(2, "chat.waiting", { projectRef: project, needsYou: false, leadWorking: false, lastSeq: 1 })));
  act(() => n.send({ t: "live", frame: { at: later(2), full: true, lanes: [liveLane(leadLaneId(project), "idle")] } }));
  await flush();
  expect(wake()).toBeNull();
  expect(host.querySelector("[data-typing]")).toBeNull();
});

// W791 (F1520): Claude overloaded mid-turn, and the bot in the reply's place showed typing dots alone for minutes.
it("past 20 s of Claude's retries, a plain line beside the bot says so; gone once it writes", async () => {
  layout();
  const n = await mount();
  const retrying = (since: string, at: string) => {
    act(() =>
      n.send({ t: "live", frame: { at, full: true, lanes: [liveLane(leadLaneId(project), "working", { activity: { activity: { kind: "retrying", attempt: 5, of: 10, reason: "overloaded" }, since } })] } }),
    );
    return flush();
  };
  // A blip: the bot at work, nothing more said.
  await retrying(AT, later(5));
  expect(wake()?.dataset["wake"]).toBe("working");
  expect(wake()?.getAttribute("aria-label")).toBe("Working");
  await retrying(AT, later(25));
  expect(wake()?.textContent).toBe("Claude is overloaded, retrying…");
  // Claude answers: the line goes, and the bot says it thinks.
  await n.lead({ kind: "thinking" }, later(30));
  expect(wake()?.getAttribute("aria-label")).toBe("Thinking");
});

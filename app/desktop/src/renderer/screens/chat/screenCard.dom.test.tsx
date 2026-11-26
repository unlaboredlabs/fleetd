// @vitest-environment happy-dom
// A screen's card in the chat: live, its picture (from the hub's screen_thumb), its now-line and Watch; asking, why and
// Take over, which takes it and opens it in the panel; ended, how long it ran and Replay. And the strip over the
// composer while one asks, gone once none does. The pictures come only while a card of a live screen shows.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDataLayer, type HubApi } from "../../src/data/queries";
import { DataProvider } from "../../src/data/react";
import { AT, live, project, snapshot } from "../../src/data/fixtures.test-util";
import { TooltipProvider } from "../../ui/primitives/Tooltip";
import { ScreenAsk, ScreenCard } from "./ScreenCard";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const row = (sessionId: string, more: Record<string, unknown>) => ({
  sessionId,
  projectRef: project,
  threadId: "s-lead",
  purpose: "Read the Web browser intro on Wikipedia",
  state: "live",
  control: "agent",
  startedAt: AT,
  ...more,
});
let sessions: unknown[] = [];
let controls: unknown[] = [];
let sent: unknown[] = [];
let thumbs: boolean[] = [];
let host: HTMLDivElement;
let root: Root | undefined;
let send: Parameters<HubApi["subscribe"]>[0] = () => undefined;

beforeEach(() => {
  controls = [];
  sent = [];
  thumbs = [];
  vi.stubGlobal("fleetd", {
    platform: "darwin",
    fixture: null,
    hub: {
      watch: () => Promise.resolve(),
      thumbs: (_hub: string, on: boolean) => {
        thumbs.push(on);
        return Promise.resolve();
      },
    },
  });
  host = document.createElement("div");
  document.body.appendChild(host);
  location.hash = "";
});
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  host.remove();
  vi.unstubAllGlobals();
});

const settle = async () => {
  for (let i = 0; i < 8; i++) await act(() => new Promise((done) => setTimeout(done, 0)));
};

const mount = async (node: React.ReactNode) => {
  const hub: HubApi = {
    call: (tool, input) => {
      if (tool === "browser_sessions") return Promise.resolve({ ok: true, output: { sessions, retention: { retentionDays: 30, maxGbPerProject: 20 } } });
      if (tool === "browser_download_send") {
        sent.push(input);
        return Promise.resolve({ ok: true, output: { attachmentId: "F9", messageId: "m9" } });
      }
      if (tool === "browser_control") {
        controls.push(input);
        const id = (input as { sessionId: string }).sessionId;
        return Promise.resolve({ ok: true, output: { session: row(id, { control: "human" }) } });
      }
      return Promise.resolve({ ok: true, output: tool === "agents_list" ? { at: AT, agents: [] } : {} });
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
        <TooltipProvider>{node}</TooltipProvider>
      </DataProvider>,
    );
  });
  act(() => {
    send(live(["browser_sessions", "screen_thumbs"]));
    send(snapshot(1));
  });
  await settle();
};

const buttons = () => [...host.querySelectorAll("button")].map((b) => b.textContent);

it("shows a live screen with its picture, what it does now, and Watch; the pictures come while it shows", async () => {
  sessions = [row("bs-live", { step: { seq: 2, offsetMs: 2_000, tool: "agent-browser", args: { command: "agent-browser open https://en.wikipedia.org/wiki/Web_browser" }, ok: true } })];
  await mount(<ScreenCard project={project} sessionId="bs-live" />);
  expect(host.querySelector("[data-screen-card]")?.textContent).toContain("’s browser");
  expect(host.textContent).toContain("live");
  expect(buttons()).toEqual(["Watch"]);
  expect(thumbs).toEqual([true]);
  act(() => send({ t: "screen_thumb", thumb: { sessionId: "bs-live", jpegB64: "AAAA", width: 640, height: 400, at: AT } }));
  await settle();
  expect(host.querySelector("[data-screen-card] img")?.getAttribute("src")).toBe("data:image/jpeg;base64,AAAA");
  act(() => root?.unmount());
  root = undefined;
  expect(thumbs).toEqual([true, false]);
});

it("while it asks: why, and Take over, which takes it and opens it in the panel", async () => {
  sessions = [row("bs-ask", { takeoverReason: "Scroll the page to the bottom, then hand it back." })];
  await mount(
    <>
      <ScreenCard project={project} sessionId="bs-ask" />
      <ScreenAsk project={project} />
    </>,
  );
  const card = host.querySelector("[data-screen-card]");
  expect(card?.getAttribute("data-state")).toBe("asking");
  expect(card?.textContent).toContain("needs you");
  expect(card?.textContent).toContain("Scroll the page to the bottom, then hand it back.");
  expect(host.querySelector("[data-screen-ask]")?.textContent).toContain("needs you");
  const take = card?.querySelector("button");
  expect(take?.textContent).toBe("Take over");
  act(() => take?.click());
  await settle();
  expect(controls).toEqual([{ sessionId: "bs-ask", control: "human" }]);
  expect(location.hash).toContain("sessions");
  expect(location.hash).toContain("bs-ask");
});

it("once ended: how long it ran and Replay, no pictures asked for; the strip says nothing while none asks", async () => {
  sessions = [row("bs-done", { state: "recorded", endedAt: "2026-10-19T10:02:00.000Z", startedAt: "2026-10-19T10:00:00.000Z", files: [{ file: "actions", bytes: 1 }] })];
  await mount(
    <>
      <ScreenCard project={project} sessionId="bs-done" />
      <ScreenAsk project={project} />
    </>,
  );
  expect(host.textContent).toContain("Ended · 2:00");
  expect(buttons()).toEqual(["Replay"]);
  expect(host.querySelector("[data-screen-ask]")).toBeNull();
  expect(thumbs).toEqual([]);
});

it("once ended, lists what its browser downloaded that the chat doesn't have, each with Send to chat", async () => {
  const downloads = [
    { name: "dummy.pdf", bytes: 13_264, at: "2026-10-19T10:01:00.000Z" },
    { name: "summary.md", bytes: 900, at: "2026-10-19T10:01:30.000Z" },
  ];
  // An hour ago: its machine keeps its downloads a day.
  const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
  sessions = [row("bs-done", { state: "recorded", endedAt: ago(60), startedAt: ago(62), files: [{ file: "actions", bytes: 1 }], downloads })];
  await mount(<ScreenCard project={project} sessionId="bs-done" inChat={["summary.md"]} />);
  const list = host.querySelector("ul[aria-label='Downloaded on this screen']");
  expect(list?.textContent).toContain("dummy.pdf");
  expect(list?.textContent).not.toContain("summary.md");
  const send = [...(list?.querySelectorAll("button") ?? [])].find((b) => b.textContent === "Send to chat");
  act(() => send?.click());
  await settle();
  expect(sent).toEqual([{ sessionId: "bs-done", name: "dummy.pdf" }]);
  // Sent: it says so, until its message comes in and takes it off the list.
  expect(send?.textContent).toBe("Sent");
  expect(send?.disabled).toBe(true);
});

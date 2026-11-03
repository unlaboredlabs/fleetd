// @vitest-environment happy-dom
// The Screens page (D305): what asks for you on top, then the live ones as pictures with their kind, machine and the
// agent's latest step, then the ended ones; the hub's pictures come only while the page shows.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDataLayer, type HubApi } from "../../src/data/queries";
import { DataProvider } from "../../src/data/react";
import { AT, live, project, snapshot } from "../../src/data/fixtures.test-util";
import { TooltipProvider } from "../../ui/primitives/Tooltip";
import { ScreensPage } from "./ScreensPage";
import { THUMB_EVERY_MS } from "./data";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const at = (agoMs: number) => new Date(Date.parse(AT) - agoMs).toISOString();
const row = (sessionId: string, purpose: string, startedAgoMs: number, more: Record<string, unknown> = {}) => ({
  sessionId,
  projectRef: project,
  threadId: `th-${sessionId}`,
  purpose,
  state: "live",
  control: "agent",
  startedAt: at(startedAgoMs),
  machineId: "devbox",
  ...more,
});
const SESSIONS = [
  row("B-new", "Check the new cart drawer", 10_000, { step: { seq: 3, at: AT, offsetMs: 9_000, tool: "agent-browser", args: { command: "agent-browser click @e3" }, ok: true, durationMs: 40 } }),
  row("B-old", "Run the cart fix on the iOS simulator", 60_000, { kind: "mac", machineId: "mac" }),
  row("B-asks", "Download the payouts report", 30_000, { takeoverReason: "Enter the code sent to the phone" }),
  row("B-android", "Android emulator opened by Sam", 20_000, { kind: "android", machineId: "buildbox", control: "human", openedBy: { personId: "p_sam", name: "Sam" } }),
  row("B-ended-long-ago", "Reproduce the 404", 7_200_000, { state: "recorded", endedAt: at(7_000_000) }),
  row("B-ended-just-now", "Compare the home page copy", 600_000, { state: "lost", endedAt: at(5_000) }),
];

let host: HTMLDivElement;
let root: Root | undefined;
let send: Parameters<HubApi["subscribe"]>[0] = () => undefined;
let thumbs: boolean[] = [];
let lists = 0;
let hidden = false;

beforeEach(() => {
  thumbs = [];
  lists = 0;
  hidden = false;
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => (hidden ? "hidden" : "visible") });
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
});
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  host.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const settle = async () => {
  for (let i = 0; i < 8; i++) await act(() => vi.advanceTimersByTimeAsync(0));
};

const mount = async (features: readonly string[] = ["browser_sessions", "screen_open", "screen_thumbs"]) => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout"] });
  const hub: HubApi = {
    call: (tool) => {
      if (tool === "browser_sessions") {
        lists++;
        return Promise.resolve({ ok: true, output: { sessions: SESSIONS, waits: [], retention: { retentionDays: 30, maxGbPerProject: 20 } } });
      }
      return Promise.resolve({ ok: true, output: tool === "agents_list" ? { at: AT, agents: [] } : tool === "machine_roles" ? { machines: [] } : {} });
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
          <ScreensPage open={null} />
        </TooltipProvider>
      </DataProvider>,
    );
  });
  act(() => {
    send(live([...features]));
    send(snapshot(1));
  });
  await settle();
};

const group = (name: string) => host.querySelector<HTMLElement>(`section[aria-label="${name}"]`);
/** The screens a group shows, by what each is for, in order. */
const listed = (name: string) => [...(group(name)?.querySelectorAll("a[href^='#/screens/'][data-state]") ?? [])].map((a) => a.querySelector("[class*='purpose']")?.textContent);

it("puts what asks for you on top, the rest live oldest first, then the ended newest first", async () => {
  await mount();
  expect([...host.querySelectorAll("section")].map((s) => s.getAttribute("aria-label"))).toEqual(["Needs you", "Live", "Recent"]);
  expect(group("Needs you")?.textContent).toContain("Download the payouts report");
  expect(group("Needs you")?.textContent).toContain("Enter the code sent to the phone");
  expect(group("Needs you")?.querySelector("button")?.textContent).toBe("Take over");
  expect(listed("Live")).toEqual(["Run the cart fix on the iOS simulator", "Android emulator opened by Sam", "Check the new cart drawer"]);
  expect(listed("Recent")).toEqual(["Compare the home page copy", "Reproduce the 404"]);
});

it("names each live screen's kind and machine and its agent's latest step, and opens one on the page's own route", async () => {
  await mount();
  const tiles = [...(group("Live")?.querySelectorAll("a") ?? [])];
  expect(tiles.map((t) => t.querySelector("[class*='label']")?.textContent)).toEqual(["storefrontAgents’ Mac", "storefrontAndroid · buildbox", "storefrontBrowser · devbox"]);
  expect(tiles[2]?.textContent).toContain("Clicked @e3");
  expect(tiles[1]?.textContent).toContain("Yours to drive");
  expect(tiles[2]?.getAttribute("href")).toBe("#/screens/devbox/storefront/B-new");
});

it("shows a live screen's picture once the hub sends it, and none for an ended one", async () => {
  await mount();
  expect(group("Live")?.querySelectorAll("img")).toHaveLength(0);
  act(() => {
    send({ t: "screen_thumb", thumb: { sessionId: "B-new", jpegB64: "AAAA", width: 640, height: 400, at: AT } });
    send({ t: "screen_thumb", thumb: { sessionId: "B-ended-long-ago", jpegB64: "AAAA", width: 640, height: 400, at: AT } });
  });
  const pictures = [...(group("Live")?.querySelectorAll("img") ?? [])];
  expect(pictures.map((i) => i.getAttribute("src"))).toEqual(["data:image/jpeg;base64,AAAA"]);
  expect(group("Recent")?.querySelectorAll("img")).toHaveLength(0);
});

it("asks for pictures only while the page shows: hidden, or left, it stops, and the steps stop being read again", async () => {
  await mount();
  expect(thumbs).toEqual([true]);
  const before = lists;
  await act(() => vi.advanceTimersByTimeAsync(THUMB_EVERY_MS));
  await settle();
  expect(lists).toBeGreaterThan(before);
  // The window hidden: the feed stops; shown again, it starts again.
  hidden = true;
  act(() => {
    document.dispatchEvent(new Event("visibilitychange"));
  });
  expect(thumbs).toEqual([true, false]);
  const quiet = lists;
  await act(() => vi.advanceTimersByTimeAsync(3 * THUMB_EVERY_MS));
  await settle();
  expect(lists).toBe(quiet);
  hidden = false;
  act(() => {
    document.dispatchEvent(new Event("visibilitychange"));
  });
  expect(thumbs).toEqual([true, false, true]);
  // The page left: off.
  act(() => root?.unmount());
  root = undefined;
  expect(thumbs).toEqual([true, false, true, false]);
});

it("asks a hub too old to send pictures for none", async () => {
  await mount(["browser_sessions"]);
  expect(thumbs).toEqual([]);
  expect(group("Live")).not.toBeNull();
});

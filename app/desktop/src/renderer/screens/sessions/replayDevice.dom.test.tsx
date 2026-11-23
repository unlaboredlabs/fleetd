// @vitest-environment happy-dom
// A phone's recording in its device (W859): the replay's video is made once and kept, whether the device shows in 3D
// or flat and when one gives way to the other (a stage that finds no WebGL, a person's switch), and the view's own
// re-renders as it plays never set its picture's watch up again.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDataLayer, type HubApi } from "../../src/data/queries";
import { DataProvider } from "../../src/data/react";
import { AT, live, project, snapshot } from "../../src/data/fixtures.test-util";
import { TooltipProvider } from "../../ui/primitives/Tooltip";
import { SessionView } from "./SessionView";

// A window that says it has a graphics card: the device starts in 3D. This DOM can't make the stage, so it then shows
// flat: the switch the replay must come through with its video.
vi.mock("./webgl", () => ({ webgl: () => "gpu" }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SESSION = {
  sessionId: "bs-duo-ended",
  projectRef: project,
  threadId: "s-T3",
  taskId: "T3",
  purpose: "iPhone Duo · Ada",
  kind: "ios",
  model: "iPhone Duo",
  state: "recorded",
  control: "agent",
  startedAt: AT,
  endedAt: "2026-10-19T10:00:09.000Z",
  files: [
    { file: "actions", bytes: 1 },
    { file: "video_mp4", bytes: 4 },
  ],
};
const ACTIONS = new TextEncoder().encode(`${JSON.stringify({ seq: 0, offsetMs: 0, tool: "session_start", args: { purpose: "x" }, ok: true })}\n`);

let host: HTMLDivElement;
let root: Root | undefined;

if (!("fromBase64" in Uint8Array)) {
  Object.defineProperty(Uint8Array, "fromBase64", { value: (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)), configurable: true });
}

beforeEach(() => {
  vi.stubGlobal("fleetd", { platform: "darwin", fixture: null, hub: { watch: () => Promise.resolve(), input: () => Promise.resolve() } });
  host = document.createElement("div");
  document.body.appendChild(host);
});
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  host.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const settle = async () => {
  for (let i = 0; i < 12; i++) await act(() => new Promise((done) => setTimeout(done, 0)));
};

const mount = async () => {
  let send: Parameters<HubApi["subscribe"]>[0] = () => undefined;
  const hub: HubApi = {
    call: (tool, input) => {
      if (tool === "browser_sessions") return Promise.resolve({ ok: true, output: { sessions: [SESSION], retention: { retentionDays: 30, maxGbPerProject: 20 } } });
      if (tool === "browser_recording_get") {
        const bytes = (input as { file?: string }).file === "video_mp4" ? new Uint8Array([0, 0, 0, 0]) : ACTIONS;
        return Promise.resolve({ ok: true, output: { dataB64: btoa(String.fromCharCode(...bytes)), done: true } });
      }
      return Promise.resolve({ ok: true, output: tool === "agents_list" ? { at: AT, agents: [] } : {} });
    },
    subscribe: (l) => ((send = l), () => undefined),
    resync: () => Promise.resolve(),
    focus: () => Promise.resolve(),
    chat: () => Promise.resolve(),
  };
  root = createRoot(host);
  act(() => {
    root?.render(
      <DataProvider layer={createDataLayer(hub)}>
        <TooltipProvider>
          <SessionView project={project} id={SESSION.sessionId} />
        </TooltipProvider>
      </DataProvider>,
    );
  });
  act(() => {
    send(live(["browser_sessions"]));
    send(snapshot(1));
  });
  await settle();
};

it("keeps a replay's video through 3D giving way to flat, with its source, in a Duo", async () => {
  // Every video put in the page, from the first render on.
  const made: Node[] = [];
  const watch = new MutationObserver((records) => {
    for (const r of records) for (const n of r.addedNodes) if (n instanceof HTMLElement) made.push(...(n.tagName === "VIDEO" ? [n] : n.querySelectorAll("video")));
  });
  watch.observe(host, { childList: true, subtree: true });
  await mount();
  watch.disconnect();
  // The stage couldn't start here: the device shows flat, a Duo.
  expect(host.querySelector("[data-mode='flat'] [data-kind='duo']")).not.toBeNull();
  const videos = host.querySelectorAll("video");
  expect(videos).toHaveLength(1);
  // One video, the one put in first, playing from its recording.
  expect(made).toHaveLength(1);
  expect(videos[0]).toBe(made[0]);
  expect(videos[0]?.getAttribute("src")).toMatch(/^blob:/u);
});

it("sets up a replay's picture once, however often the view renders as it plays", async () => {
  const added = vi.spyOn(HTMLVideoElement.prototype, "addEventListener");
  await mount();
  const video = host.querySelector("video");
  if (video === null) throw new Error("no video");
  // The surface's watch and the player's own onPlay.
  const plays = () => added.mock.calls.filter(([type]) => type === "play").length;
  const before = plays();
  expect(before).toBeGreaterThan(0);
  // Each time update renders the player again (its clock): nothing is set up anew.
  for (let i = 0; i < 5; i++) {
    act(() => {
      Object.defineProperty(video, "currentTime", { value: i, configurable: true });
      video.dispatchEvent(new Event("timeupdate"));
    });
  }
  await settle();
  expect(plays()).toBe(before);
});

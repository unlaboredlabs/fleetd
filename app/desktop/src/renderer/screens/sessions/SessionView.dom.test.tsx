// @vitest-environment happy-dom
// One screen in the panel: live, its page the full width with no Steps beside it (a phone's, standing up, as tall as
// fits); ended, its recording the full width, its steps behind Steps, closed until opened, and closed again by it.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDataLayer, type HubApi } from "../../src/data/queries";
import { DataProvider } from "../../src/data/react";
import { AT, live, project, snapshot } from "../../src/data/fixtures.test-util";
import { TooltipProvider } from "../../ui/primitives/Tooltip";
import { SessionView } from "./SessionView";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const row = (sessionId: string, more: Record<string, unknown>) => ({
  sessionId,
  projectRef: project,
  threadId: "s-T3",
  taskId: "T3",
  purpose: "Check the order summary takes the SAVE10 code on staging",
  state: "live",
  control: "agent",
  startedAt: AT,
  ...more,
});
const SESSIONS = [
  row("bs-live", {}),
  row("bs-ended", { state: "recorded", endedAt: "2026-10-19T10:00:09.000Z", files: [{ file: "actions", bytes: 1 }], note: "no video: this machine has no ffmpeg" }),
];
// Its steps, as actions.jsonl has them.
const ACTIONS = [
  { seq: 0, offsetMs: 0, tool: "session_start", args: { purpose: "x" }, ok: true },
  { seq: 1, offsetMs: 2_000, tool: "agent-browser", args: { command: "agent-browser open https://staging.shop.example.com" }, ok: true },
  { seq: 2, offsetMs: 9_000, tool: "session_end", ok: true },
]
  .map((a) => JSON.stringify(a))
  .join("\n");

let host: HTMLDivElement;
let root: Root | undefined;
let send: Parameters<HubApi["subscribe"]>[0] = () => undefined;

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
});

const settle = async () => {
  for (let i = 0; i < 8; i++) await act(() => new Promise((done) => setTimeout(done, 0)));
};

const mount = async (id: string) => {
  const hub: HubApi = {
    call: (tool) => {
      if (tool === "browser_sessions") return Promise.resolve({ ok: true, output: { sessions: SESSIONS, retention: { retentionDays: 30, maxGbPerProject: 20 } } });
      if (tool === "browser_recording_get") return Promise.resolve({ ok: true, output: { dataB64: btoa(ACTIONS), done: true } });
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
        <TooltipProvider>
          <SessionView project={project} id={id} />
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

const stepsToggle = () => [...host.querySelectorAll("button")].find((b) => b.textContent === "Steps");
const stepsList = () => host.querySelector("ol[aria-label^='Its steps']");

it("shows a live screen's page the full width, with no Steps beside it", async () => {
  await mount("bs-live");
  expect(host.querySelector("[data-screen='sessions.live']")).not.toBeNull();
  expect(host.textContent).toContain("The agent is driving");
  expect(host.querySelector("button")?.textContent).not.toBe("Steps");
  expect(stepsToggle()).toBeUndefined();
  expect(stepsList()).toBeNull();
  expect(host.textContent).not.toContain("Its steps show here");
});

it("plays an ended screen's recording the full width, its steps behind Steps, closed until opened and closed again", async () => {
  await mount("bs-ended");
  expect(host.querySelector("[data-screen='sessions.replay']")).not.toBeNull();
  const toggle = stepsToggle();
  expect(toggle?.getAttribute("aria-pressed")).toBe("false");
  expect(stepsList()).toBeNull();

  act(() => toggle?.click());
  expect(stepsToggle()?.getAttribute("aria-pressed")).toBe("true");
  const steps = [...(stepsList()?.querySelectorAll("li") ?? [])].map((li) => li.textContent);
  expect(steps).toHaveLength(3);
  expect(steps[0]).toContain("Started a fresh browser");
  expect(steps[2]).toContain("Ended the screen");

  act(() => stepsToggle()?.click());
  expect(stepsToggle()?.getAttribute("aria-pressed")).toBe("false");
  expect(stepsList()).toBeNull();
});

it("keeps a phone's screen, standing up, to the view's height, and a browser's page the full width", async () => {
  await mount("bs-live");
  const frame = (width: number, height: number) =>
    act(() => send({ t: "browser_frame", frame: { sessionId: "bs-live", seq: width, jpegB64: "", width, height, control: "agent" } }));
  frame(480, 1039);
  await settle();
  const shown = host.querySelector<HTMLElement>("[data-control='agent']");
  expect(shown?.dataset["shape"]).toBe("portrait");
  expect(shown?.style.getPropertyValue("--aspect")).toBe(String(480 / 1039));
  frame(960, 600);
  await settle();
  expect(host.querySelector<HTMLElement>("[data-control='agent']")?.dataset["shape"]).toBeUndefined();
});

// @vitest-environment happy-dom
// One screen in the panel: one line above it (back, what it is, who has it, how long, its controls); live, its page as
// large as fits with no Steps beside it (a phone's standing up in its bezel, a browser's in a plain window); ended, its
// recording in the same frame, its steps behind Steps, closed until opened, and closed again by it.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDataLayer, type DataLayer, type HubApi } from "../../src/data/queries";
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
const DUO_CONTROLS = ["rotate_left", "rotate_right", "home", "lock", "shake", "appearance", "location", "screenshot", "fold"];
/** The device controls pressed (screen_control), in order. */
let pressed: unknown[] = [];
const SESSIONS = [
  row("bs-live", {}),
  row("bs-yours", { control: "human" }),
  row("bs-ios-yours", { kind: "ios", control: "human" }),
  row("bs-ios", { kind: "ios" }),
  // A person's own iPhone Duo, its strip's controls as the Mac reports them; one on its side.
  row("bs-duo", { kind: "ios", control: "human", openedBy: { personId: "p_adaadaad", name: "Ada" }, controls: DUO_CONTROLS, orientation: "portrait", fold: "closed", folds: ["closed", "half-open", "open"], appearance: "light" }),
  row("bs-duo-left", { kind: "ios", control: "human", openedBy: { personId: "p_adaadaad", name: "Ada" }, controls: DUO_CONTROLS, orientation: "landscape_left", fold: "closed", folds: ["closed", "open"] }),
  row("bs-duo-agent", { kind: "ios", controls: DUO_CONTROLS, orientation: "portrait" }),
  row("bs-ended", { state: "recorded", endedAt: "2026-10-19T10:00:09.000Z", files: [{ file: "actions", bytes: 1 }], note: "no video: this machine has no ffmpeg" }),
];
// Its steps, as actions.jsonl has them.
const ACTIONS = [
  { seq: 0, offsetMs: 0, tool: "session_start", args: { purpose: "x" }, ok: true },
  { seq: 1, offsetMs: 2_000, tool: "agent-browser", args: { command: "agent-browser open https://shop.example/café" }, ok: true },
  { seq: 2, offsetMs: 9_000, tool: "session_end", ok: true },
]
  .map((a) => JSON.stringify(a))
  .join("\n");
const ACTION_BYTES = new TextEncoder().encode(ACTIONS);

let host: HTMLDivElement;
let root: Root | undefined;
let send: Parameters<HubApi["subscribe"]>[0] = () => undefined;
let inputs: unknown[] = [];

// The app's Electron has Uint8Array.fromBase64, which the recording is read with; Node 24 (these tests) doesn't yet.
if (!("fromBase64" in Uint8Array)) {
  Object.defineProperty(Uint8Array, "fromBase64", { value: (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)), configurable: true });
}

beforeEach(() => {
  inputs = [];
  vi.stubGlobal("fleetd", {
    platform: "darwin",
    fixture: null,
    hub: {
      watch: () => Promise.resolve(),
      input: (_hub: string, session: string, input: unknown) => {
        inputs.push({ session, input });
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
  vi.unstubAllGlobals();
});

const settle = async () => {
  for (let i = 0; i < 8; i++) await act(() => new Promise((done) => setTimeout(done, 0)));
};

/** The view of `id`, on `reused`'s data layer (as the app keeps one while a person moves between screens) or a fresh one. */
const mount = async (id: string, features: readonly string[] = ["browser_sessions", "browser_navigate"], reused?: DataLayer): Promise<DataLayer> => {
  const hub: HubApi = {
    call: (tool, input) => {
      if (tool === "browser_sessions") return Promise.resolve({ ok: true, output: { sessions: SESSIONS, retention: { retentionDays: 30, maxGbPerProject: 20 } } });
      if (tool === "screen_control") {
        pressed.push(input);
        return Promise.resolve({ ok: true, output: {} });
      }
      if (tool === "browser_recording_get") {
        // A byte a piece, so every character past ASCII is split between two pieces.
        const offset = (input as { offset?: number }).offset ?? 0;
        const piece = ACTION_BYTES.slice(offset, offset + 1);
        return Promise.resolve({ ok: true, output: { dataB64: btoa(String.fromCharCode(...piece)), done: offset + 1 >= ACTION_BYTES.length } });
      }
      return Promise.resolve({ ok: true, output: tool === "agents_list" ? { at: AT, agents: [] } : {} });
    },
    subscribe: (l) => ((send = l), () => undefined),
    resync: () => Promise.resolve(),
    focus: () => Promise.resolve(),
    chat: () => Promise.resolve(),
  };
  const layer = reused ?? createDataLayer(hub);
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
    send(live([...features]));
    send(snapshot(1));
  });
  await settle();
  return layer;
};

const stepsToggle = () => [...host.querySelectorAll("button")].find((b) => b.textContent === "Steps");
const stepsList = () => host.querySelector("ol[aria-label^='Its steps']");

it("shows a live screen's page the full width, with no Steps beside it", async () => {
  await mount("bs-live");
  expect(host.querySelector("[data-screen='sessions.live']")).not.toBeNull();
  // The line says it is live; what the agent does is one line under the page.
  expect(host.querySelector("h2")?.textContent).toBe("Check the order summary takes the SAVE10 code on staging");
  expect(host.textContent).toContain("live");
  expect(host.textContent).toContain("Working in the page");
  expect(host.querySelector("button")?.textContent).not.toBe("Steps");
  expect(stepsToggle()).toBeUndefined();
  expect(stepsList()).toBeNull();
  expect(host.textContent).not.toContain("Its steps show here");
});

it("waits for a live screen's first frame quietly, then says what it waits for: a browser's page, an iOS screen's simulator", async () => {
  await mount("bs-live");
  expect(host.querySelector("[data-screen='sessions.live']")).not.toBeNull();
  expect(host.textContent).not.toContain("Waiting for");
  await act(() => new Promise((done) => setTimeout(done, 1_050)));
  expect(host.textContent).toContain("Waiting for the page…");
  // A page's frame is the same shape before its first frame as after: nothing moves when it comes.
  expect(host.querySelector<HTMLElement>("[data-control='agent']")?.dataset["shape"]).toBeUndefined();
  act(() => root?.unmount());
  root = undefined;
  await mount("bs-ios");
  // A phone's stands up from the start.
  expect(host.querySelector<HTMLElement>("[data-control='agent']")?.dataset["shape"]).toBe("portrait");
  await act(() => new Promise((done) => setTimeout(done, 1_050)));
  expect(host.textContent).toContain("Waiting for the simulator…");
  expect(host.textContent).not.toContain("Waiting for the page");
});

it("shows a screen it showed before at once, its last frame, until the live one comes", async () => {
  await mount("bs-live");
  act(() => send({ t: "browser_frame", frame: { sessionId: "bs-live", seq: 7, jpegB64: "AAAA", width: 1280, height: 800, control: "agent" } }));
  await settle();
  expect(host.querySelector("img")?.dataset["seq"]).toBe("7");
  act(() => root?.unmount());
  root = undefined;
  // A fresh data layer, as after switching away: no frame in its store yet.
  await mount("bs-live");
  expect(host.querySelector("img")?.dataset["seq"]).toBe("7");
  act(() => send({ t: "browser_frame", frame: { sessionId: "bs-live", seq: 8, jpegB64: "AAAB", width: 1280, height: 800, control: "agent" } }));
  await settle();
  expect(host.querySelector("img")?.dataset["seq"]).toBe("8");
});

it("says over the last picture that it waits for the screen's machine while that's away, and clears it with the next frame", async () => {
  await mount("bs-live");
  act(() => send({ t: "browser_frame", frame: { sessionId: "bs-live", seq: 3, jpegB64: "AAAA", width: 1280, height: 800, control: "agent" } }));
  await settle();
  act(() => send({ t: "browser_waiting", sessionId: "bs-live", machineId: "box-7" }));
  await settle();
  // The last picture stays; one quiet line over it, the machine by its id when the hub names none.
  expect(host.querySelector("img")?.dataset["seq"]).toBe("3");
  const status = host.querySelector("[role='status']");
  expect(status?.textContent).toBe("Waiting for box-7…");
  // Over the H.264 canvas too, which fills the frame once it draws: after it, so painted above it.
  const canvas = host.querySelector("canvas");
  expect(canvas).not.toBeNull();
  expect((canvas?.compareDocumentPosition(status as Node) ?? 0) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  act(() => send({ t: "browser_frame", frame: { sessionId: "bs-live", seq: 1, jpegB64: "AAAB", width: 1280, height: 800, control: "agent", link: 2 } }));
  await settle();
  expect(host.querySelector("[role='status']")).toBeNull();
  expect(host.querySelector("img")?.dataset["seq"]).toBe("1");
});

it("never says it waits over a picture its own peer carries live, and says it again once the peer is gone", async () => {
  const layer = await mount("bs-live");
  // The window's peer carries the screen; then the hub restarts, so the machine isn't linked to it a moment.
  act(() => send({ t: "browser_frame", frame: { sessionId: "bs-live", seq: 4, jpegB64: "AAAA", width: 1280, height: 800, control: "agent" }, rtc: true }));
  act(() => send({ t: "browser_waiting", sessionId: "bs-live", machineId: "box-7" }));
  await settle();
  expect(host.querySelector("[role='status']")).toBeNull();
  // The peer goes too: the picture is no longer live, and the line is up.
  act(() => layer.store.setState({ browserRtc: undefined }));
  await settle();
  expect(host.querySelector("[role='status']")?.textContent).toBe("Waiting for box-7…");
});

it("drops a wait said to an earlier view of a screen when it's watched again, until the hub says it again", async () => {
  const layer = await mount("bs-live");
  act(() => send({ t: "browser_frame", frame: { sessionId: "bs-live", seq: 5, jpegB64: "AAAA", width: 1280, height: 800, control: "agent" } }));
  act(() => send({ t: "browser_waiting", sessionId: "bs-live", machineId: "box-7" }));
  await settle();
  expect(host.querySelector("[role='status']")).not.toBeNull();
  // The person goes elsewhere and back, on the same data layer: a new watch, and nothing said of it yet.
  act(() => root?.unmount());
  root = undefined;
  await mount("bs-live", undefined, layer);
  expect(host.querySelector("img")?.dataset["seq"]).toBe("5");
  expect(host.querySelector("[role='status']")).toBeNull();
  act(() => send({ t: "browser_waiting", sessionId: "bs-live", machineId: "box-7" }));
  await settle();
  expect(host.querySelector("[role='status']")?.textContent).toBe("Waiting for box-7…");
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
  // Read whole across the pieces: a split é would come out as U+FFFD (%EF%BF%BD).
  expect(steps[1]).toContain("shop.example/caf%C3%A9");
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

const address = () => host.querySelector<HTMLInputElement>("input[aria-label='Address']");
const type = (el: HTMLInputElement, value: string) => {
  act(() => {
    // As typing sets it: past React's own value tracking, so its change handler hears it.
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
};

it("gives a browser that is yours an address bar: where it is, Enter goes elsewhere, back, forward and reload", async () => {
  await mount("bs-yours");
  act(() => send({ t: "browser_frame", frame: { sessionId: "bs-yours", seq: 1, jpegB64: "AAAA", width: 1280, height: 800, control: "human", url: "https://staging.shop.example.com/cart" } }));
  await settle();
  const bar = address();
  expect(bar?.value).toBe("https://staging.shop.example.com/cart");
  expect(host.textContent).toContain("you’re in control");
  if (bar === null) throw new Error("no address bar");
  act(() => bar.focus());
  type(bar, "example.com/docs");
  expect(bar.value).toBe("example.com/docs");
  act(() => {
    bar.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  });
  expect(inputs).toEqual([{ session: "bs-yours", input: { kind: "navigate", url: "https://example.com/docs" } }]);
  // The page takes the keys again, and the bar shows where the page is until its next frame says where it went.
  expect(document.activeElement?.getAttribute("role")).toBe("application");
  expect(bar.value).toBe("https://staging.shop.example.com/cart");
  inputs = [];
  for (const label of ["Back", "Forward", "Reload"]) act(() => host.querySelector<HTMLButtonElement>(`button[aria-label='${label}']`)?.click());
  expect(inputs.map((i) => (i as { input: { kind: string } }).input.kind)).toEqual(["back", "forward", "reload"]);
});

it("puts the page's address back on Escape, and shows a blank page's as empty", async () => {
  await mount("bs-yours");
  act(() => send({ t: "browser_frame", frame: { sessionId: "bs-yours", seq: 1, jpegB64: "AAAA", width: 1280, height: 800, control: "human", url: "about:blank" } }));
  await settle();
  const bar = address();
  if (bar === null) throw new Error("no address bar");
  expect(bar.value).toBe("");
  expect(bar.placeholder).toBe("Type an address");
  act(() => bar.focus());
  type(bar, "example.com");
  act(() => {
    bar.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  });
  expect(bar.value).toBe("");
  expect(inputs).toEqual([]);
});

it("has no address bar from a hub that doesn't relay it", async () => {
  await mount("bs-yours", ["browser_sessions"]);
  expect(host.textContent).toContain("you’re in control");
  expect(address()).toBeNull();
  expect(host.querySelector("button[aria-label='Back']")).toBeNull();
});

it("has no address bar while the agent drives, nor on a device's screen", async () => {
  await mount("bs-live");
  expect(address()).toBeNull();
  expect(host.querySelector("button[aria-label='Back']")).toBeNull();
  act(() => root?.unmount());
  root = undefined;
  await mount("bs-ios-yours");
  expect(host.textContent).toContain("you’re in control");
  expect(address()).toBeNull();
});

it("puts a phone in its bezel, the island over its screen, and its page takes your clicks through the island", async () => {
  await mount("bs-ios-yours");
  act(() => send({ t: "browser_frame", frame: { sessionId: "bs-ios-yours", seq: 1, jpegB64: "AAAA", width: 603, height: 1311, control: "human" } }));
  await settle();
  const phone = host.querySelector<HTMLElement>("[data-kind='ios']");
  expect(phone?.dataset["shape"]).toBe("portrait");
  expect(phone?.querySelector("[role='application']")).not.toBeNull();
  // The island is drawn over the screen, outside it: the page's own element takes the pointer.
  const island = phone?.querySelector("[aria-hidden='true']:not(img)");
  expect(island?.closest("[role='application']")).toBeNull();
  // No browser bar on a device, and nothing in the line but its words and its one control.
  expect(host.querySelector("input[aria-label='Address']")).toBeNull();
  expect(host.textContent).not.toContain("started");
});

const strip = () => host.querySelector("[role='toolbar'][aria-label='Device']");

it("gives a phone of yours a slim strip of the controls its machine says work, each press one screen_control", async () => {
  pressed = [];
  await mount("bs-duo");
  act(() => send({ t: "browser_frame", frame: { sessionId: "bs-duo", seq: 1, jpegB64: "AAAA", width: 1398, height: 2034, control: "human" } }));
  await settle();
  // Icons only, named by their tooltips: no words in the strip.
  const buttons = [...(strip()?.querySelectorAll("button") ?? [])];
  expect(buttons.map((b) => b.getAttribute("aria-label"))).toEqual(["Rotate left", "Rotate right", "Fold", "Home", "Lock", "Shake", "Dark appearance", "Location", "Screenshot"]);
  expect(strip()?.textContent).toBe("");
  act(() => buttons[0]?.click());
  act(() => buttons.find((b) => b.getAttribute("aria-label") === "Dark appearance")?.click());
  await settle();
  expect(pressed).toEqual([
    { sessionId: "bs-duo", control: "rotate_left" },
    { sessionId: "bs-duo", control: "appearance", value: "dark" },
  ]);
});

it("shows a phone's frame at its own shape, its island along the edge its top turned to, and no strip on a screen the agent drives", async () => {
  await mount("bs-duo-left");
  // A turned iPhone's frame comes on its side: nothing turns it again.
  act(() => send({ t: "browser_frame", frame: { sessionId: "bs-duo-left", seq: 1, jpegB64: "AAAA", width: 2622, height: 1206, control: "human" } }));
  await settle();
  const phone = host.querySelector<HTMLElement>("[data-kind='ios']");
  expect(phone?.style.transform ?? "").toBe("");
  expect(phone?.dataset["island"]).toBe("left");
  act(() => root?.unmount());
  root = undefined;
  await mount("bs-duo-agent");
  expect(strip()).toBeNull();
});

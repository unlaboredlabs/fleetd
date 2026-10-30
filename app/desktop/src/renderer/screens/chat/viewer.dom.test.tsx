// @vitest-environment happy-dom
// A chat image opens large when clicked: the lead's image blocks and the images you send. The viewer shows the
// caption, closes with Esc, a click beside the image or the X, and steps through a message's images with ← and →.
// A clip still plays where it is.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ChatItem } from "../../src/data/chat";
import { createDataLayer, type HubApi } from "../../src/data/queries";
import { DataProvider } from "../../src/data/react";
import { live, project as PROJECT, snapshot } from "../../src/data/fixtures.test-util";
import { TooltipProvider } from "../../ui/primitives/Tooltip";
import { BubbleActionsContext, type BubbleActions } from "./actions";
import { MessageView } from "./Bubble";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAF0lEQVR4nGPwqr3x4t0nhhfvPnnV3gAAPIAIz2Y7aggAAAAASUVORK5CYII=";
const FILES: Record<string, { name: string; mime: string }> = {
  F1: { name: "receipt.png", mime: "image/png" },
  F2: { name: "checkout.png", mime: "image/png" },
  F3: { name: "demo.mp4", mime: "video/mp4" },
  F4: { name: "cart.png", mime: "image/png" },
};

let host: HTMLDivElement;
let root: Root;
const actions: BubbleActions = { project: PROJECT, waitedOn: undefined, send: () => undefined, reply: () => undefined, show: () => undefined };

beforeEach(() => {
  vi.stubGlobal("fleetd", { platform: "linux", fixture: null });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

let send: Parameters<HubApi["subscribe"]>[0] = () => undefined;
const HUB: HubApi = {
  call: (tool, input) => {
    const id = (input as { attachmentId?: string }).attachmentId ?? "";
    const file = FILES[id];
    return Promise.resolve(tool === "attachment_get" && file !== undefined ? { ok: true, output: { attachmentId: id, bytes: 68, dataB64: PNG, ...file } } : { ok: true, output: {} });
  },
  subscribe: (l) => ((send = l), () => undefined),
  resync: () => Promise.resolve(),
  focus: () => Promise.resolve(),
  chat: () => Promise.resolve(),
};

const mount = async (i: ChatItem) => {
  act(() =>
    root.render(
      <DataProvider layer={createDataLayer(HUB)}>
        <TooltipProvider>
          <BubbleActionsContext.Provider value={actions}>
            <MessageView row={{ kind: "message", key: i.id, item: i, run: true, end: true, head: false, history: false }} mineLatest={false} />
          </BubbleActionsContext.Provider>
        </TooltipProvider>
      </DataProvider>,
    ),
  );
  act(() => {
    send(live());
    send(snapshot(1));
  });
  await settle();
};
const settle = async () => {
  for (let n = 0; n < 5; n++) await act(() => new Promise((done) => setTimeout(done, 0)));
};

/** A lead message of three bubbles: words, an image with a caption, a clip. */
const TEXT = "Here is the receipt.\n\n[image]\n\n[clip]";
const lead: ChatItem = {
  id: "m1",
  author: "lead",
  kind: "message",
  text: TEXT,
  at: "2026-10-30T09:00:00.000Z",
  attachments: [],
  state: "sent",
  message: {
    messageId: "m1",
    projectRef: PROJECT,
    seq: 1,
    author: "lead",
    state: "final",
    text: TEXT,
    createdAt: "2026-10-30T09:00:00.000Z",
    parts: [
      { start: 0, end: 20 },
      { start: 22, end: 29, block: { v: 1, kind: "image", attachmentId: "F1", caption: "The receipt at 360px" } },
      { start: 31, end: 37, block: { v: 1, kind: "clip", attachmentId: "F3" } },
    ],
  },
};
/** Yours: two screenshots and a log. */
const mine: ChatItem = {
  id: "m2",
  author: "human",
  kind: "message",
  text: "Both pages, before and after.",
  at: "2026-10-30T09:01:00.000Z",
  attachments: [
    { attachmentId: "F2", name: "checkout.png", mime: "image/png", bytes: 68 },
    { attachmentId: "F5", name: "tests.log", mime: "text/plain", bytes: 120 },
    { attachmentId: "F4", name: "cart.png", mime: "image/png", bytes: 68 },
  ],
  state: "sent",
};

const viewer = () => document.querySelector<HTMLElement>("[data-viewer]");
const open = async (label: string) => {
  const button = host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  expect(button).not.toBeNull();
  act(() => button?.click());
  await settle();
};
const key = async (k: string) => {
  act(() => {
    (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
  });
  await settle();
};
const shown = () => viewer()?.querySelector("img")?.getAttribute("alt");

it("opens an image block large with its caption, and Esc closes it", async () => {
  await mount(lead);
  expect(viewer()).toBeNull();
  await open("Open The receipt at 360px");
  expect(shown()).toBe("The receipt at 360px");
  expect(viewer()?.querySelector("figcaption")?.textContent).toBe("The receipt at 360px");
  // One image in the message: nothing to step to.
  expect(viewer()?.querySelector('[aria-label="Next image"]')).toBeNull();
  await key("Escape");
  expect(viewer()).toBeNull();
});

it("leaves a clip playing where it is", async () => {
  await mount(lead);
  const clip = host.querySelector('[data-block="clip"]');
  expect(clip?.querySelector("video")).not.toBeNull();
  expect(clip?.querySelector("button")).toBeNull();
});

it("steps through the images you sent with the arrows, skipping other files", async () => {
  await mount(mine);
  await open("Open checkout.png");
  expect(shown()).toBe("checkout.png");
  expect(viewer()?.textContent).toContain("1 of 2");
  expect(viewer()?.querySelector('[aria-label="Previous image"]')).toBeNull();
  await key("ArrowRight");
  expect(shown()).toBe("cart.png");
  expect(viewer()?.textContent).toContain("2 of 2");
  // The last one: → stays put.
  await key("ArrowRight");
  expect(shown()).toBe("cart.png");
  act(() => viewer()?.querySelector<HTMLButtonElement>('[aria-label="Previous image"]')?.click());
  await settle();
  expect(shown()).toBe("checkout.png");
});

it("closes with a click beside the image or the X, not on the image", async () => {
  await mount(mine);
  await open("Open cart.png");
  act(() => viewer()?.querySelector("img")?.click());
  await settle();
  expect(viewer()).not.toBeNull();
  act(() => viewer()?.click());
  await settle();
  expect(viewer()).toBeNull();
  await open("Open cart.png");
  act(() => viewer()?.querySelector<HTMLButtonElement>('[aria-label="Close"]')?.click());
  await settle();
  expect(viewer()).toBeNull();
});

/** An image you sent finishing its load at `width` × `height` pixels. */
const loaded = (name: string, width: number, height: number) => {
  const img = host.querySelector<HTMLImageElement>(`[data-mine] img[alt="${name}"]`);
  expect(img).not.toBeNull();
  if (img === null) return img;
  Object.defineProperty(img, "naturalWidth", { value: width, configurable: true });
  Object.defineProperty(img, "naturalHeight", { value: height, configurable: true });
  act(() => {
    img.dispatchEvent(new Event("load"));
  });
  return img;
};

it("sizes the images you sent in points within the box, on your side, whatever their pixels", async () => {
  await mount(mine);
  // In your message, after your words: the stack sits in your side's corner, as the bubble does.
  const message = host.querySelector("[data-mine]");
  expect(message?.lastElementChild?.querySelector('img[alt="cart.png"]')).not.toBeNull();
  // A wide screenshot, a tall one, and a small one: each its own size, never a share of the column.
  const wide = loaded("checkout.png", 2880, 900);
  expect([wide?.style.width, wide?.style.height]).toEqual(["360px", "113px"]);
  const tall = loaded("cart.png", 600, 1800);
  expect([tall?.style.width, tall?.style.height]).toEqual(["93px", "280px"]);
  const small = loaded("cart.png", 64, 40);
  expect([small?.style.width, small?.style.height]).toEqual(["64px", "40px"]);
});

it("shows a lead's block that didn't fit as a small chip, never its JSON", async () => {
  const json = '{"v":1,"kind":"table","columns":["PR",""],"rows":[]}';
  const text = `The week:\n\n\`\`\`fleetd-block\n${json}\n\`\`\``;
  if (lead.message === undefined) throw new Error("no message");
  const broken: ChatItem = {
    ...lead,
    text,
    message: { ...lead.message, text, parts: [{ start: 0, end: 9 }, { start: 11, end: text.length }] },
  };
  await mount(broken);
  await settle();
  expect(host.textContent).toContain("The week:");
  expect(host.textContent).toContain("Couldn't show this");
  expect(host.textContent).not.toContain('"kind"');
  expect(host.querySelectorAll("[data-unshown]")).toHaveLength(1);
  // Alone in its part, the chip has no bubble around it.
  expect(host.querySelector('[data-part="1"]')?.className).not.toMatch(/bubble/i);
});

it("never shows the chip while a lead's reply streams in: its block may still be arriving", async () => {
  const text = 'The week:\n\n```fleetd-block\n{"v":1,"kind":"table","colu';
  if (lead.message === undefined) throw new Error("no message");
  const { parts: _, ...message } = lead.message;
  const streaming: ChatItem = { ...lead, text, state: "streaming", message: { ...message, text, state: "streaming" } };
  await mount(streaming);
  expect(host.querySelector("[data-unshown]")).toBeNull();
  expect(host.textContent).not.toContain('"kind"');
});

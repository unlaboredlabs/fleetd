// @vitest-environment happy-dom
// Every picture in the chat saves in one click: the lead's image blocks and each picture you sent carry a download
// button that asks main to save the file to Downloads, then says so with a way to show it there, or says why it
// failed. Its right-click menu has Save image… and Copy image, and the viewer offers the same. A clip has neither.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { DownloadOutcome, OpenOutcome } from "../../../shared/hub";
import type { ChatItem } from "../../src/data/chat";
import { createDataLayer, type HubApi } from "../../src/data/queries";
import { DataProvider } from "../../src/data/react";
import { live, project as PROJECT, snapshot } from "../../src/data/fixtures.test-util";
import { Toaster } from "../../ui/primitives/Toast";
import { TooltipProvider } from "../../ui/primitives/Tooltip";
import { BubbleActionsContext, type BubbleActions } from "./actions";
import { MessageView } from "./Bubble";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAF0lEQVR4nGPwqr3x4t0nhhfvPnnV3gAAPIAIz2Y7aggAAAAASUVORK5CYII=";
const FILES: Record<string, { name: string; mime: string }> = {
  F1: { name: "pebble.png", mime: "image/png" },
  F2: { name: "checkout.png", mime: "image/png" },
  F3: { name: "demo.mp4", mime: "video/mp4" },
  F4: { name: "cart.png", mime: "image/png" },
};

type FileRequest = { projectRef: typeof PROJECT; attachmentId: string };
const download = vi.fn((_hub: string, _request: FileRequest): Promise<DownloadOutcome> => Promise.resolve({ ok: true, path: "/home/sam/Downloads/pebble.png", name: "pebble.png" }));
const save = vi.fn((_hub: string, _request: FileRequest): Promise<OpenOutcome> => Promise.resolve({ ok: true }));
const copyImage = vi.fn((_hub: string, _request: FileRequest): Promise<OpenOutcome> => Promise.resolve({ ok: true }));
const show = vi.fn((_path: string): Promise<OpenOutcome> => Promise.resolve({ ok: true }));

let host: HTMLDivElement;
let root: Root;
const actions: BubbleActions = { project: PROJECT, waitedOn: undefined, send: () => undefined, reply: () => undefined, show: () => undefined };

class FakeIntersectionObserver {
  constructor(private cb: IntersectionObserverCallback) {}
  observe(target: Element) {
    queueMicrotask(() => this.cb([{ target, isIntersecting: true } as IntersectionObserverEntry], this as unknown as IntersectionObserver));
  }
  unobserve() {}
  disconnect() {}
}

beforeEach(() => {
  for (const mock of [download, save, copyImage, show]) mock.mockClear();
  vi.stubGlobal("fleetd", { platform: "linux", fixture: null, files: { download, save, copyImage, show } });
  vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
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

const settle = async () => {
  for (let n = 0; n < 5; n++) await act(() => new Promise((done) => setTimeout(done, 0)));
};
const mount = async (i: ChatItem) => {
  act(() =>
    root.render(
      <DataProvider layer={createDataLayer(HUB)}>
        <TooltipProvider>
          <Toaster>
            <BubbleActionsContext.Provider value={actions}>
              <MessageView row={{ kind: "message", key: i.id, item: i, run: true, end: true, head: false, history: false }} mineLatest={false} />
            </BubbleActionsContext.Provider>
          </Toaster>
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

/** A lead message of three bubbles: words, an image with a caption, a clip. */
const TEXT = "Here is the picture.\n\n[image]\n\n[clip]";
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
      { start: 22, end: 29, block: { v: 1, kind: "image", attachmentId: "F1", caption: "The profile picture" } },
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

const click = async (el: Element | null | undefined) => {
  if (!(el instanceof HTMLElement)) throw new Error("nothing to click");
  act(() => el.click());
  await settle();
};
const button = (label: string, within: ParentNode = document) => within.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
/** The toasts on screen, not what was read out as each one came. */
const toasts = () => [...document.querySelectorAll("ol > li")].map((t) => t.textContent);
const said = (words: string) => toasts().some((t) => t.includes(words));
const rightClick = (target: Element | null | undefined) => {
  if (target == null) throw new Error("nothing to right-click");
  act(() => {
    target.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }));
  });
};
const items = () => [...document.querySelectorAll("[role='menu'] [role='menuitem']")].map((i) => i.textContent);
const choose = async (label: string) => {
  await click([...document.querySelectorAll<HTMLElement>("[role='menuitem']")].find((i) => i.textContent === label));
};

it("saves an image block to Downloads in one click, and shows it in its folder from the confirmation", async () => {
  await mount(lead);
  const picture = host.querySelector('[data-block="image"] [data-picture]');
  // The button is in the picture's own frame, beside the button that opens it: it takes no room in the message.
  expect(picture?.querySelector('button[aria-label="Open The profile picture"]')).not.toBeNull();
  download.mockResolvedValueOnce({ ok: true, path: "/home/sam/Downloads/pebble (1).png", name: "pebble (1).png" });
  await click(button("Save pebble.png", picture ?? undefined));
  expect(download).toHaveBeenCalledExactlyOnceWith(expect.any(String), { projectRef: PROJECT, attachmentId: "F1" });
  // The name it got, a number added when the picture's own was taken.
  expect(said("Saved pebble (1).png to Downloads")).toBe(true);
  // Saving it didn't open it.
  expect(document.querySelector("[data-viewer]")).toBeNull();
  await click([...document.querySelectorAll("button")].find((b) => b.textContent === "Show in folder"));
  expect(show).toHaveBeenCalledExactlyOnceWith("/home/sam/Downloads/pebble (1).png");
});

it("says why when the save fails", async () => {
  await mount(lead);
  download.mockResolvedValueOnce({ ok: false, message: "The file couldn't be saved: Error: ENOSPC: no space left on device" });
  await click(button("Save pebble.png"));
  expect(said("Couldn’t save pebble.png")).toBe(true);
  expect(said("ENOSPC: no space left on device")).toBe(true);
});

it("puts the button on each picture you sent, and on no other file or clip", async () => {
  await mount(mine);
  expect([...host.querySelectorAll("[data-picture] > button[aria-label^='Save ']")].map((b) => b.getAttribute("aria-label"))).toEqual(["Save checkout.png", "Save cart.png"]);
  await click(button("Save cart.png"));
  expect(download).toHaveBeenCalledExactlyOnceWith(expect.any(String), { projectRef: PROJECT, attachmentId: "F4" });
  act(() => root.unmount());
  root = createRoot(host);
  await mount(lead);
  expect(host.querySelector('[data-block="clip"] [data-picture]')).toBeNull();
});

it("offers Save image… and Copy image on a picture's right-click, for a block and for one you sent", async () => {
  await mount(lead);
  rightClick(host.querySelector('[data-block="image"] img'));
  // The picture's own menu, not the bubble's with it.
  expect(items()).toEqual(["Save image…", "Copy image"]);
  await choose("Save image…");
  expect(save).toHaveBeenCalledExactlyOnceWith(expect.any(String), { projectRef: PROJECT, attachmentId: "F1" });
  expect(download).not.toHaveBeenCalled();
  rightClick(host.querySelector('[data-block="image"] img'));
  await choose("Copy image");
  expect(copyImage).toHaveBeenCalledExactlyOnceWith(expect.any(String), { projectRef: PROJECT, attachmentId: "F1" });
  expect(said("Image copied")).toBe(true);
  act(() => root.unmount());
  root = createRoot(host);
  await mount(mine);
  rightClick(host.querySelector('img[alt="checkout.png"]'));
  expect(items()).toEqual(["Save image…", "Copy image"]);
  copyImage.mockResolvedValueOnce({ ok: false, message: "This kind of image (image/webp) can't be copied. Save it instead." });
  await choose("Copy image");
  expect(copyImage).toHaveBeenLastCalledWith(expect.any(String), { projectRef: PROJECT, attachmentId: "F2" });
  expect(said("Couldn’t copy checkout.png")).toBe(true);
  expect(said("Save it instead.")).toBe(true);
});

it("has the same button and menu in the viewer, for the picture it shows, and stays open through them", async () => {
  await mount(mine);
  await click(button("Open checkout.png", host));
  const viewer = () => document.querySelector<HTMLElement>("[data-viewer]");
  // The X keeps the focus the viewer opens with: the download button comes after it.
  expect([...(viewer()?.querySelectorAll("button") ?? [])].map((b) => b.getAttribute("aria-label")).slice(0, 2)).toEqual(["Close", "Save checkout.png"]);
  await click(button("Save checkout.png", viewer() ?? undefined));
  expect(download).toHaveBeenLastCalledWith(expect.any(String), { projectRef: PROJECT, attachmentId: "F2" });
  expect(viewer()).not.toBeNull();
  // The next picture's button saves that one.
  await click(button("Next image", viewer() ?? undefined));
  await click(button("Save cart.png", viewer() ?? undefined));
  expect(download).toHaveBeenLastCalledWith(expect.any(String), { projectRef: PROJECT, attachmentId: "F4" });
  rightClick(viewer()?.querySelector("img"));
  expect(items()).toEqual(["Save image…", "Copy image"]);
  // → in the menu moves in the menu: the viewer stays on its picture, and choosing an item leaves it open.
  act(() => {
    document.querySelector("[role='menu']")?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true, cancelable: true }));
  });
  await settle();
  expect(viewer()?.querySelector("img")?.getAttribute("alt")).toBe("cart.png");
  await choose("Save image…");
  expect(save).toHaveBeenCalledExactlyOnceWith(expect.any(String), { projectRef: PROJECT, attachmentId: "F4" });
  expect(viewer()).not.toBeNull();
});

it("closes the viewer at the first Esc after a save or a copy, and the confirmation stays", async () => {
  await mount(mine);
  const viewer = () => document.querySelector<HTMLElement>("[data-viewer]");
  const esc = async (on: Element | null = document.activeElement) => {
    act(() => {
      (on ?? document.body).dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    });
    await settle();
  };
  // The toast is drawn after the viewer, and the page would give it the key.
  await click(button("Open checkout.png", host));
  await click(button("Save checkout.png", viewer() ?? undefined));
  expect(said("Saved pebble.png to Downloads")).toBe(true);
  await esc();
  expect(viewer()).toBeNull();
  expect(said("Saved pebble.png to Downloads")).toBe(true);
  // In the image's menu, Esc is the menu's: the viewer stays.
  await click(button("Open checkout.png", host));
  rightClick(viewer()?.querySelector("img"));
  expect(items()).toEqual(["Save image…", "Copy image"]);
  await esc(document.querySelector("[role='menu']"));
  expect(items()).toEqual([]);
  expect(viewer()).not.toBeNull();
  rightClick(viewer()?.querySelector("img"));
  await choose("Copy image");
  expect(said("Image copied")).toBe(true);
  await esc();
  expect(viewer()).toBeNull();
  expect(said("Image copied")).toBe(true);
  // With the viewer gone the key is the page's again, and dismisses the newest toast as it always did.
  await esc();
  expect(said("Image copied")).toBe(false);
});

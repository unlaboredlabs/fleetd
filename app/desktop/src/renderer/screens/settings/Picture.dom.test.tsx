// @vitest-environment happy-dom
// Settings › Projects › Icon over a fake hub: the project's icon shows, and its picture once it has one; a face or color
// picked shows at once and is sent a moment later, only the last of a quick run; the pointer over one shows it large;
// a picked or dropped image opens Move and Scale, whose Save uploads it and names the square under the circle; Remove
// image sends no picture; a file that isn't an image is refused before anything is sent.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectSettings as Settings } from "../../../shared/contracts";
import type { HubFrame } from "../../../shared/hub";
import { createDataLayer, type HubApi } from "../../src/data/queries";
import { DataProvider } from "../../src/data/react";
import { UiProvider } from "../../ui";
import { SEND_AFTER_MS } from "./Picture";
import { ProjectSettings } from "./Projects";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.hoisted(() => {
  (globalThis as { fleetd?: unknown }).fleetd = { platform: "linux" };
});

const AT = "2026-10-30T10:00:00.000Z";
const AVATAR = "a1b2c3d4e5f60718";
const settings: Settings = {
  machineId: "devbox",
  projectId: "p1",
  title: "storefront",
  workspaceRoot: "/home/w/src/storefront",
  setup: { commands: [], timeoutSec: 600, runAnyway: false, inputs: [] },
  env: [],
};

const ICON = { face: "wink", color: "fleet" } as const;

const snapshot = (avatar: string | undefined, icon: { face: string; color: string } | null = ICON): HubFrame => ({
  t: "snapshot",
  snapshot: {
    cursor: 1,
    attention: [],
    machines: [{ machineId: "devbox", name: "devbox", nodeVersion: "1", status: "online", lastSeenAt: AT, tags: [] }],
    projects: [
      {
        machineId: "devbox",
        projectId: "p1",
        title: "storefront",
        workspaceRoot: "/home/w/src/storefront",
        threads: { running: 0, waiting: 0, idle: 0, failed: 0 },
        lastActivityAt: AT,
        ...(avatar === undefined ? {} : { avatar }),
        ...(icon === null ? {} : { icon }),
      },
    ],
  },
});

/** An image as happy-dom can't decode one: 400 × 300 once its source is set. */
class FakeImage {
  naturalWidth = 400;
  naturalHeight = 300;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  set src(_: string) {
    setTimeout(() => this.onload?.(), 0);
  }
}

let host: HTMLDivElement;
let root: Root;
let calls: Array<{ tool: string; input: unknown }>;

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  calls = [];
  window.location.hash = "#/settings/projects?for=devbox/p1";
  vi.stubGlobal("fleetd", { platform: "linux" });
  vi.stubGlobal("Image", FakeImage);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

const settle = () => act(async () => new Promise((r) => setTimeout(r, 0)));

/** Settles until `done` holds: happy-dom reads a file in its own time. */
const until = async (done: () => boolean) => {
  for (let i = 0; i < 100 && !done(); i++) await settle();
};

const shown = () => document.querySelector('[role="dialog"]') !== null || section().querySelector('[role="alert"]') !== null;

const render = async (avatar: string | undefined, icon: { face: string; color: string } | null = ICON) => {
  let listener: (frame: HubFrame) => void = () => undefined;
  const hub: HubApi = {
    call: (tool, input) => {
      calls.push({ tool, input });
      if (tool === "project_avatar_get") return Promise.resolve({ ok: true, output: { avatar: AVATAR, mime: "image/jpeg", dataB64: "/9j/AA==" } });
      if (tool === "attachment_put") return Promise.resolve({ ok: true, output: { attachmentId: "F7", bytes: 4, sha256: "x".repeat(64) } });
      if (tool === "project_avatar_set" || tool === "project_icon_set") return Promise.resolve({ ok: true, output: { project: {} } });
      if (tool === "mcp_servers_get") return Promise.resolve({ ok: true, output: { global: [], project: [], userServers: true } });
      return Promise.resolve({ ok: true, output: { settings } });
    },
    subscribe: (l) => ((listener = l), () => undefined),
    resync: () => Promise.resolve(),
    focus: () => Promise.resolve(),
    chat: () => Promise.resolve(),
  };
  await act(async () => {
    root.render(
      <UiProvider>
        <DataProvider layer={createDataLayer(hub)}>
          <ProjectSettings route={{ tab: "projects", prompt: null, for: "devbox/p1", view: "edit" }} />
        </DataProvider>
      </UiProvider>,
    );
    await Promise.resolve();
  });
  await act(async () => {
    listener({ t: "state", state: { phase: "live", hub: "devbox:4710", protocol: 1 } });
    listener(snapshot(avatar, icon));
    await new Promise((r) => setTimeout(r, 0));
  });
  await settle();
  await settle();
  // A later snapshot, as another device's change brings.
  return async (frame: HubFrame) => {
    await act(async () => {
      listener(frame);
      await new Promise((r) => setTimeout(r, 0));
    });
    await settle();
  };
};

const section = () => {
  const el = document.querySelector<HTMLElement>('section[aria-label="Icon"]');
  if (el === null) throw new Error("no Icon setting");
  return el;
};

const button = (text: string, within: ParentNode = document) => {
  const b = [...within.querySelectorAll("button")].find((x) => x.textContent.trim() === text);
  if (b === undefined) throw new Error(`no button ${text}`);
  return b;
};

const click = async (el: HTMLElement) => {
  await act(async () => {
    el.click();
    await Promise.resolve();
  });
  await settle();
};

const pick = async (file: File) => {
  const input = section().querySelector<HTMLInputElement>('[data-testid="picture-file"]');
  if (input === null) throw new Error("no file input");
  await act(async () => {
    Object.defineProperty(input, "files", { value: [file], configurable: true });
    input.dispatchEvent(new Event("change", { bubbles: true }));
    await Promise.resolve();
  });
  await until(shown);
};

const png = () => new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], "logo.png", { type: "image/png" });

/** The large icon's image's file: `wink-fleet-96.webp`. */
const previewFile = () => {
  const src = section().querySelector<HTMLImageElement>('button[aria-label^="Upload an image"] [data-avatar="icon"] img')?.getAttribute("src") ?? "";
  return src.split("/").pop()?.split("?")[0];
};

const radio = (group: string, name: string) => {
  const el = section().querySelector<HTMLElement>(`[aria-label="${group}"] [role="radio"][aria-label="${name}"]`);
  if (el === null) throw new Error(`no ${group} ${name}`);
  return el;
};

const sent = () => calls.filter((c) => c.tool === "project_icon_set").map((c) => c.input);

const wait = (ms: number) => act(async () => new Promise((r) => setTimeout(r, ms)));

describe("Settings → Projects → Icon", () => {
  it("shows its icon, its letters from a hub that sends none, and its picture once it has one", async () => {
    await render(undefined);
    expect(previewFile()).toBe("wink-fleet-96.webp");
    expect(radio("Face", "Wink").getAttribute("aria-checked")).toBe("true");
    expect(radio("Color", "Fleet").getAttribute("aria-checked")).toBe("true");
    expect(section().querySelectorAll('[aria-label="Face"] [role="radio"]')).toHaveLength(9);
    expect(section().querySelectorAll('[aria-label="Color"] [role="radio"]')).toHaveLength(12);
    expect(calls.filter((c) => c.tool === "project_avatar_get")).toEqual([]);
    expect(button("Upload image…", section())).toBeDefined();
    expect([...section().querySelectorAll("button")].map((b) => b.textContent.trim())).not.toContain("Remove image");

    act(() => root.unmount());
    root = createRoot(host);
    await render(undefined, null);
    expect(section().querySelector<HTMLElement>('[data-avatar="letters"]')?.dataset.letters).toBe("S");

    act(() => root.unmount());
    root = createRoot(host);
    calls = [];
    await render(AVATAR);
    expect(calls.filter((c) => c.tool === "project_avatar_get").map((c) => c.input)).toEqual([{ machineId: "devbox", projectId: "p1" }]);
    expect(section().querySelector<HTMLImageElement>('[data-avatar="picture"] img')?.src).toBe("data:image/jpeg;base64,/9j/AA==");
    // Over a picture no face is picked: any is a pick.
    expect(section().querySelectorAll('[role="radio"][aria-checked="true"]')).toHaveLength(0);
  });

  it("shows a face or color picked at once and sends the last of a quick run a moment later", async () => {
    await render(undefined);
    await click(radio("Face", "Joy"));
    expect(previewFile()).toBe("joy-fleet-96.webp");
    await click(radio("Color", "Sun"));
    expect(previewFile()).toBe("joy-sun-96.webp");
    // The grid's faces wear the color picked.
    expect(radio("Face", "Mo").querySelector("img")?.getAttribute("src")).toContain("mo-sun-96.webp");
    expect(sent()).toEqual([]);
    await wait(SEND_AFTER_MS + 50);
    expect(sent()).toEqual([{ machineId: "devbox", projectId: "p1", icon: { face: "joy", color: "sun" } }]);
  });

  it("shows what the pointer is over, large, until it leaves", async () => {
    await render(undefined);
    await act(async () => {
      radio("Face", "Huh").dispatchEvent(new PointerEvent("pointerover", { bubbles: true }));
      await Promise.resolve();
    });
    expect(previewFile()).toBe("huh-fleet-96.webp");
    await act(async () => {
      radio("Color", "Rose").dispatchEvent(new PointerEvent("pointerover", { bubbles: true }));
      await Promise.resolve();
    });
    expect(previewFile()).toBe("wink-rose-96.webp");
    const picker = section().querySelector('[aria-label="Face"]')?.parentElement?.parentElement;
    await act(async () => {
      picker?.dispatchEvent(new PointerEvent("pointerout", { bubbles: true, relatedTarget: document.body }));
      await Promise.resolve();
    });
    expect(previewFile()).toBe("wink-fleet-96.webp");
    expect(sent()).toEqual([]);
  });

  it("lets a later change from another device show after a quick run that ends where it began", async () => {
    const push = await render(undefined);
    await click(radio("Face", "Joy"));
    await click(radio("Face", "Wink"));
    await wait(SEND_AFTER_MS + 50);
    expect(sent()).toEqual([{ machineId: "devbox", projectId: "p1", icon: { face: "wink", color: "fleet" } }]);
    await push(snapshot(undefined, { face: "mo", color: "mint" }));
    expect(previewFile()).toBe("mo-mint-96.webp");
    expect(radio("Face", "Mo").getAttribute("aria-checked")).toBe("true");
  });

  it("picks a face over a picture, which takes its place", async () => {
    await render(AVATAR);
    await click(radio("Face", "Wink"));
    expect(previewFile()).toBe("wink-fleet-96.webp");
    await wait(SEND_AFTER_MS + 50);
    expect(sent()).toEqual([{ machineId: "devbox", projectId: "p1", icon: { face: "wink", color: "fleet" } }]);
  });

  it("moves and scales a picked image, then sends it with the square under the circle", async () => {
    await render(undefined);
    await pick(png());
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
    expect(dialog?.textContent).toContain("Move and scale");
    await click(button("Save", dialog ?? document));
    await until(() => document.querySelector('[role="dialog"]') === null);
    const put = calls.find((c) => c.tool === "attachment_put");
    expect(put?.input).toMatchObject({ name: "logo.png", mime: "image/png", dataB64: "iVBORw==" });
    // 400 × 300 at zoom 1, centred: the 300 px square from x 50.
    expect(calls.find((c) => c.tool === "project_avatar_set")?.input).toEqual({ machineId: "devbox", projectId: "p1", attachmentId: "F7", crop: { x: 50, y: 0, size: 300 } });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(section().textContent).toContain("shows this image now");
  });

  it("takes an image dropped on the avatar", async () => {
    await render(undefined);
    const target = section().querySelector<HTMLButtonElement>("button[aria-label^='Upload an image']");
    if (target === null) throw new Error("no drop target");
    await act(async () => {
      const drop = new Event("drop", { bubbles: true, cancelable: true });
      Object.defineProperty(drop, "dataTransfer", { value: { files: [png()], types: ["Files"] } });
      target.dispatchEvent(drop);
      await Promise.resolve();
    });
    await until(shown);
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain("Move and scale");
  });

  it("removes it, and refuses a file that isn't an image before sending anything", async () => {
    await render(AVATAR);
    await click(button("Remove image", section()));
    expect(calls.filter((c) => c.tool === "project_avatar_set").map((c) => c.input)).toEqual([{ machineId: "devbox", projectId: "p1" }]);

    await pick(new File(["hello"], "notes.txt", { type: "text/plain" }));
    expect(section().querySelector('[role="alert"]')?.textContent).toContain("notes.txt isn't a png, jpeg or webp image.");
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(calls.filter((c) => c.tool === "attachment_put")).toEqual([]);
  });
});

// @vitest-environment happy-dom
// Settings › Projects › Picture over a fake hub: the project's picture shows once it has one; a picked or dropped image
// opens Move and Scale, whose Save uploads it and names the square under the circle; Remove sends no picture; a file
// that isn't an image is refused before anything is sent.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectSettings as Settings } from "../../../shared/contracts";
import type { HubFrame } from "../../../shared/hub";
import { createDataLayer, type HubApi } from "../../src/data/queries";
import { DataProvider } from "../../src/data/react";
import { UiProvider } from "../../ui";
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
  keepWorktrees: false,
  setup: { commands: [], timeoutSec: 600, runAnyway: false, inputs: [] },
  env: [],
};

const snapshot = (avatar: string | undefined): HubFrame => ({
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

const render = async (avatar: string | undefined) => {
  let listener: (frame: HubFrame) => void = () => undefined;
  const hub: HubApi = {
    call: (tool, input) => {
      calls.push({ tool, input });
      if (tool === "project_avatar_get") return Promise.resolve({ ok: true, output: { avatar: AVATAR, mime: "image/jpeg", dataB64: "/9j/AA==" } });
      if (tool === "attachment_put") return Promise.resolve({ ok: true, output: { attachmentId: "F7", bytes: 4, sha256: "x".repeat(64) } });
      if (tool === "project_avatar_set") return Promise.resolve({ ok: true, output: { project: snapshot(undefined) } });
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
    listener(snapshot(avatar));
    await new Promise((r) => setTimeout(r, 0));
  });
  await settle();
  await settle();
};

const section = () => {
  const el = document.querySelector<HTMLElement>('section[aria-label="Picture"]');
  if (el === null) throw new Error("no Picture setting");
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

describe("Settings → Projects → Picture", () => {
  it("shows its letters in a circle until it has a picture, then the picture", async () => {
    await render(undefined);
    expect(section().querySelector<HTMLElement>('[data-avatar="letters"]')?.dataset.letters).toBe("S");
    expect(calls.filter((c) => c.tool === "project_avatar_get")).toEqual([]);
    expect(button("Choose…", section())).toBeDefined();
    expect([...section().querySelectorAll("button")].map((b) => b.textContent.trim())).not.toContain("Remove");

    act(() => root.unmount());
    root = createRoot(host);
    calls = [];
    await render(AVATAR);
    expect(calls.filter((c) => c.tool === "project_avatar_get").map((c) => c.input)).toEqual([{ machineId: "devbox", projectId: "p1" }]);
    expect(section().querySelector<HTMLImageElement>('[data-avatar="picture"] img')?.src).toBe("data:image/jpeg;base64,/9j/AA==");
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
    expect(section().textContent).toContain("shows this picture now");
  });

  it("takes an image dropped on the avatar", async () => {
    await render(undefined);
    const target = section().querySelector<HTMLButtonElement>("button[aria-label^='Choose a picture']");
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
    await click(button("Remove", section()));
    expect(calls.filter((c) => c.tool === "project_avatar_set").map((c) => c.input)).toEqual([{ machineId: "devbox", projectId: "p1" }]);
    expect(section().textContent).toContain("its letters show again");

    await pick(new File(["hello"], "notes.txt", { type: "text/plain" }));
    expect(section().querySelector('[role="alert"]')?.textContent).toContain("notes.txt isn't a png, jpeg or webp image.");
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(calls.filter((c) => c.tool === "attachment_put")).toEqual([]);
  });
});

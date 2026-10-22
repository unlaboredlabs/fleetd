import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UpdatesState } from "../shared/updates";

const { fake } = vi.hoisted(() => ({
  // How the fake updater behaves, and the last one made, so a test can drive its download.
  fake: {
    last: null as null | { emit: (event: string, info: unknown) => boolean; quitAndInstall: () => void },
  },
}));

vi.mock("electron", () => ({
  app: { isPackaged: true, getVersion: () => "0.5.0" },
  shell: { openExternal: vi.fn() },
}));
vi.mock("./build", () => ({ RELEASE_BUILD: true }));
const release = { changes: [{ commit: "aaa1111", date: "2026-10-22T10:30:00Z", subject: "feat(desktop): updates show in the app (#268)", areas: ["app"] }], cli: "0.6.0" };
vi.mock("./update-release", () => ({ fetchRelease: () => Promise.resolve(release) }));
vi.mock("electron-updater", async () => {
  const { EventEmitter } = await import("node:events");
  class FakeUpdater extends EventEmitter {
    disableDifferentialDownload = false;
    autoDownload = true;
    autoInstallOnAppQuit = true;
    quitAndInstall = vi.fn();
    constructor() {
      super();
      fake.last = this;
    }
    checkForUpdates() {
      this.emit("update-available", { version: "0.6.0" });
      return Promise.resolve({ isUpdateAvailable: true, updateInfo: { version: "0.6.0" } });
    }
  }
  return { MacUpdater: FakeUpdater, AppImageUpdater: FakeUpdater, DebUpdater: FakeUpdater };
});

const { updates } = await import("./updater");

const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await new Promise((done) => setTimeout(done, 0));
};

describe("updates()", () => {
  let appImage: string | undefined;
  beforeEach(() => {
    appImage = process.env["APPIMAGE"];
    // Not the deb, which only tells; on macOS this is the Mac updater either way.
    process.env["APPIMAGE"] = "/tmp/fleetd.AppImage";
  });
  afterEach(() => {
    if (appImage === undefined) delete process.env["APPIMAGE"];
    else process.env["APPIMAGE"] = appImage;
    vi.restoreAllMocks();
  });

  it("finds an update, reads what's new, and restarts once asked and downloaded", async () => {
    const handle = updates(null);
    const seen: UpdatesState[] = [];
    handle.onChange((s) => seen.push(s));
    handle.check();
    await flush();
    expect(handle.state().app).toEqual({ kind: "available", version: "0.6.0", percent: null, restart: false });
    expect(handle.state().release).toEqual(release);
    handle.install();
    fake.last?.emit("update-downloaded", { version: "0.6.0" });
    expect(fake.last?.quitAndInstall).toHaveBeenCalledOnce();
    expect(seen.map((s) => s.app.kind)).toEqual(["checking", "checking", "available", "available", "ready"]);
  });

});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { showMessageBox, fake } = vi.hoisted(() => ({
  showMessageBox: vi.fn(() => Promise.resolve({ response: 1 })),
  // How the fake updater behaves, and the last one made, so a test can finish its download.
  fake: { downloadBeforeAnswer: false, last: null as null | { emit: (event: string, info: { version: string }) => boolean } },
}));

vi.mock("electron", () => ({
  app: { isPackaged: true, getVersion: () => "0.4.0" },
  dialog: { showMessageBox },
  shell: { openExternal: vi.fn() },
}));
vi.mock("./build", () => ({ RELEASE_BUILD: true }));
vi.mock("electron-updater", async () => {
  const { EventEmitter } = await import("node:events");
  class FakeUpdater extends EventEmitter {
    disableDifferentialDownload = false;
    autoDownload = true;
    autoInstallOnAppQuit = true;
    constructor() {
      super();
      fake.last = this;
    }
    checkForUpdates() {
      // A cached or fast download can finish before the check's promise settles.
      if (fake.downloadBeforeAnswer) this.emit("update-downloaded", { version: "0.5.0" });
      return Promise.resolve({ isUpdateAvailable: true, updateInfo: { version: "0.5.0" } });
    }
    quitAndInstall() {}
  }
  return { MacUpdater: FakeUpdater, AppImageUpdater: FakeUpdater, DebUpdater: FakeUpdater };
});

const { updates } = await import("./updater");

const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await new Promise((done) => setTimeout(done, 0));
};
const messages = (): unknown[] => showMessageBox.mock.calls.map((call: unknown[]) => (call[0] as { message: string }).message);

describe("Check for Updates…", () => {
  let appImage: string | undefined;
  beforeEach(() => {
    appImage = process.env["APPIMAGE"];
    // Not the deb, which only tells; on macOS this is the Mac updater either way.
    process.env["APPIMAGE"] = "/tmp/fleetd.AppImage";
    showMessageBox.mockClear();
  });
  afterEach(() => {
    if (appImage === undefined) delete process.env["APPIMAGE"];
    else process.env["APPIMAGE"] = appImage;
  });

  it("still answers, with the restart prompt, when the download beats the check's answer", async () => {
    fake.downloadBeforeAnswer = true;
    await updates()?.checkNow();
    expect(messages()).toEqual(["fleetd 0.5.0 is ready"]);
  });

  it("answers a second click during the download with nothing new, and settles when the download ends", async () => {
    fake.downloadBeforeAnswer = false;
    const handle = updates();
    let settled = false;
    const first = handle?.checkNow().then(() => {
      settled = true;
    });
    await flush();
    const second = handle?.checkNow();
    await flush();
    expect(messages()).toEqual(["Downloading fleetd 0.5.0"]);
    expect(settled).toBe(false);

    fake.last?.emit("update-downloaded", { version: "0.5.0" });
    await Promise.all([first, second]);
    expect(messages()).toEqual(["Downloading fleetd 0.5.0", "fleetd 0.5.0 is ready"]);
  });
});

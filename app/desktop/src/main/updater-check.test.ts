import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UpdatesState } from "../shared/updates";

const { fake } = vi.hoisted(() => ({
  // How the fake updater behaves, and the last one made, so a test can drive its download.
  fake: {
    last: null as null | { emit: (event: string, info: unknown) => boolean; quitAndInstall: () => void },
    /** The feed's version, and how many checks read it. */
    feed: "0.6.0",
    checks: 0,
  },
}));

vi.mock("electron", () => ({
  app: { isPackaged: true, getVersion: () => "0.5.0" },
  shell: { openExternal: vi.fn() },
}));
vi.mock("./build", () => ({ RELEASE_BUILD: true }));
const release = { changes: [{ commit: "aaa1111", date: "2026-10-22T10:30:00Z", subject: "feat(desktop): updates show in the app (#268)", areas: ["app"] }], cli: "0.6.0", app: "0.6.0" };
vi.mock("./update-release", () => ({ fetchRelease: () => Promise.resolve({ ...release, app: fake.feed }) }));
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
      fake.checks++;
      this.emit("update-available", { version: fake.feed });
      return Promise.resolve({ isUpdateAvailable: true, updateInfo: { version: fake.feed } });
    }
  }
  return { MacUpdater: FakeUpdater, AppImageUpdater: FakeUpdater, DebUpdater: FakeUpdater };
});

const { FOCUS_GAP_MS, updates } = await import("./updater");

/** The promise: a build on the channel shows within this long of publication. */
const TEN_MINUTES = 10 * 60_000;

const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await new Promise((done) => setTimeout(done, 0));
};

describe("updates()", () => {
  let appImage: string | undefined;
  beforeEach(() => {
    appImage = process.env["APPIMAGE"];
    // Not the deb, which only tells; on macOS this is the Mac updater either way.
    process.env["APPIMAGE"] = "/tmp/fleetd.AppImage";
    fake.feed = "0.6.0";
    fake.checks = 0;
  });
  afterEach(() => {
    vi.useRealTimers();
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

  // The cause of missed nightlies: the app checked at launch and then on a 4-hour timer, whose clock stops while the
  // computer sleeps, never when its window came back, and never again once an update was downloaded.
  describe("notices a new build within 10 minutes", () => {
    beforeEach(() => {
      vi.useFakeTimers({ now: new Date("2026-10-26T10:00:00Z") });
    });
    const settle = () => vi.advanceTimersByTimeAsync(0);

    it("checks at launch, then every 10 minutes", async () => {
      updates(null).start();
      await settle();
      expect(fake.checks).toBe(1);
      await vi.advanceTimersByTimeAsync(TEN_MINUTES - 60_000);
      expect(fake.checks).toBe(1);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(fake.checks).toBe(2);
      await vi.advanceTimersByTimeAsync(TEN_MINUTES);
      expect(fake.checks).toBe(3);
    });

    it("checks within a minute of waking, after a sleep longer than 10 minutes", async () => {
      updates(null).start();
      await settle();
      // Asleep: the wall clock moves on, timers don't.
      vi.setSystemTime(Date.now() + 3 * 60 * 60_000);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(fake.checks).toBe(2);
    });

    it("checks when a window comes to the front, unless a check just ran", async () => {
      const handle = updates(null);
      handle.start();
      await settle();
      handle.focused();
      await settle();
      expect(fake.checks).toBe(1);
      vi.setSystemTime(Date.now() + FOCUS_GAP_MS);
      handle.focused();
      await settle();
      expect(fake.checks).toBe(2);
    });

    it("finds a newer build while one is ready, and not the ready one again", async () => {
      const handle = updates(null);
      handle.start();
      await settle();
      fake.last?.emit("update-downloaded", { version: "0.6.0" });
      expect(handle.state().app).toEqual({ kind: "ready", version: "0.6.0" });
      await vi.advanceTimersByTimeAsync(TEN_MINUTES);
      expect(fake.checks).toBe(1);
      fake.feed = "0.6.1";
      await vi.advanceTimersByTimeAsync(TEN_MINUTES);
      expect(fake.checks).toBe(2);
      fake.last?.emit("update-downloaded", { version: "0.6.1" });
      expect(handle.state().app).toEqual({ kind: "ready", version: "0.6.1" });
    });
  });

});

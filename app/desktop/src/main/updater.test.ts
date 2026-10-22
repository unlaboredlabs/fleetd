import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: { isPackaged: true, getVersion: () => "0.5.0" },
  shell: { openExternal: vi.fn() },
}));
vi.mock("./build", () => ({ RELEASE_BUILD: true }));
// The lazy import of electron-updater fails, as it would with a broken or missing module in the asar. (Vitest
// rewords the factory's error, so the assertions don't depend on its text.)
vi.mock("electron-updater", () => {
  throw new Error("Cannot find module 'electron-updater'");
});

const { updates } = await import("./updater");

const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await new Promise((done) => setTimeout(done, 0));
};

describe("updates() when electron-updater fails to load", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("logs it, rejects nothing, and an asked-for check says so", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => void unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const handle = updates(null);
      handle.start();
      await flush();
      expect(console.error).toHaveBeenCalledWith("couldn't load the updater:", expect.any(String));
      expect(handle.state().app).toEqual({ kind: "idle" });
      handle.check();
      await flush();
      expect(handle.state().app).toEqual({ kind: "failed", during: "check", reason: "The updater didn't load. Reinstall fleetd to get updates again." });
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});

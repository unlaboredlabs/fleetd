import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { showMessageBox } = vi.hoisted(() => ({ showMessageBox: vi.fn(() => Promise.resolve({ response: 1 })) }));

vi.mock("electron", () => ({
  app: { isPackaged: true, getVersion: () => "0.4.0" },
  dialog: { showMessageBox },
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
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown): void => {
    unhandled.push(reason);
  };
  beforeEach(() => {
    process.on("unhandledRejection", onUnhandled);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });
  afterEach(() => {
    process.off("unhandledRejection", onUnhandled);
    vi.restoreAllMocks();
  });

  it("logs it, rejects nothing, and Check for Updates… says it couldn't check", async () => {
    const handle = updates();
    expect(handle).not.toBeNull();
    handle?.start();
    await flush();
    expect(console.error).toHaveBeenCalledWith("couldn't load the updater:", expect.any(String));

    await handle?.checkNow();
    await flush();
    expect(showMessageBox).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Couldn't check for updates", type: "warning" }),
    );
    expect(unhandled).toEqual([]);
  });
});

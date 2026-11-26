// Coming back to the app with an over-the-air update waiting, on the way, or none.
import { describe, expect, it, vi } from "vitest";
import { cameBack, type Updater } from "./appUpdate";

const updater = (o: { pending?: boolean; available?: boolean; isNew?: boolean } = {}) => {
  const u = {
    pending: () => o.pending ?? false,
    check: vi.fn(async () => ({ isAvailable: o.available ?? false })),
    fetch: vi.fn(async () => ({ isNew: o.isNew ?? true })),
    reload: vi.fn(async () => undefined),
  } satisfies Updater;
  return u;
};

describe("coming back to the app", () => {
  it("runs a downloaded update at once, without asking the server again", async () => {
    const u = updater({ pending: true, available: true });
    expect(await cameBack(u)).toBe("reloaded");
    expect(u.reload).toHaveBeenCalledOnce();
    expect(u.check).not.toHaveBeenCalled();
  });

  it("downloads a newer update for the next return, without restarting under the person", async () => {
    const u = updater({ available: true });
    expect(await cameBack(u)).toBe("downloaded");
    expect(u.fetch).toHaveBeenCalledOnce();
    expect(u.reload).not.toHaveBeenCalled();
  });

  it("does nothing when the server has nothing newer, or what it has is already here", async () => {
    const none = updater();
    expect(await cameBack(none)).toBe("none");
    expect(none.fetch).not.toHaveBeenCalled();
    expect(await cameBack(updater({ available: true, isNew: false }))).toBe("none");
  });
});

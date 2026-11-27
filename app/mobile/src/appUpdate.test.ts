// Coming back to the app with an over-the-air update waiting, on the way, or none.
import { describe, expect, it, vi } from "vitest";
import { AWAY_MS, cameBack, type Updater } from "./appUpdate";

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
  it("runs a downloaded update after a real stay away, without asking the server again", async () => {
    const u = updater({ pending: true, available: true });
    expect(await cameBack(u, AWAY_MS)).toBe("reloaded");
    expect(u.reload).toHaveBeenCalledOnce();
    expect(u.check).not.toHaveBeenCalled();
  });

  it("never restarts under a picker, the camera, a permission prompt or the sign-in page", async () => {
    // Android reports each of them as the app going to the background: what they hand back would be dropped.
    const u = updater({ pending: true, available: true });
    expect(await cameBack(u, 40_000)).toBe("waits");
    expect(await cameBack(u, AWAY_MS - 1)).toBe("waits");
    expect(u.reload).not.toHaveBeenCalled();
  });

  it("downloads a newer update for the next return, without restarting under the person", async () => {
    const u = updater({ available: true });
    expect(await cameBack(u, 1000)).toBe("downloaded");
    expect(u.fetch).toHaveBeenCalledOnce();
    expect(u.reload).not.toHaveBeenCalled();
  });

  it("does nothing when the server has nothing newer, or what it has is already here", async () => {
    const none = updater();
    expect(await cameBack(none, AWAY_MS)).toBe("none");
    expect(none.fetch).not.toHaveBeenCalled();
    expect(await cameBack(updater({ available: true, isNew: false }), AWAY_MS)).toBe("none");
  });
});

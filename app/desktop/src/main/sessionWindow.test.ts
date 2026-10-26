import { describe, expect, it } from "vitest";
import { SessionWindowRequest } from "../shared/ipc";
import { sessionHash } from "./sessionWindow";

describe("a session's own window", () => {
  it("opens on the session's route, built from its ids", () => {
    expect(sessionHash({ machineId: "devbox", projectId: "dcffccea-c5a7-40a6-940d-7f70239ffa22", session: "bs-checkout" })).toBe(
      "#/session/devbox/dcffccea-c5a7-40a6-940d-7f70239ffa22/bs-checkout",
    );
  });

  it("takes ids only, never a path or a URL", () => {
    const ok = { machineId: "devbox", projectId: "p1", session: "bs-1" };
    expect(SessionWindowRequest.safeParse(ok).success).toBe(true);
    for (const bad of [{ ...ok, session: "../settings" }, { ...ok, machineId: "https://example.com" }, { ...ok, projectId: "" }, { ...ok, extra: 1 }]) {
      expect(SessionWindowRequest.safeParse(bad).success).toBe(false);
    }
  });
});

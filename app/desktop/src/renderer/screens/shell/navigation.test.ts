// @vitest-environment happy-dom
// Routes and several hubs (docs/design/hubs.md): a route names its hub as `?at=<id>`, one that doesn't stays on the
// hub of the screen before it, and a single-hub app's hashes never name one.
import { afterEach, describe, expect, it } from "vitest";
import { currentRoute, hashFor, navigate, setRouteHubs } from "./navigation";
import { parseHash, toHash } from "./routes";

afterEach(() => {
  setRouteHubs(["hub"]);
  window.location.hash = "";
});

describe("routes on several hubs", () => {
  it("reads and writes a route's hub, and leaves a route without one as it was", () => {
    expect(parseHash("#/project/laptop/billing?at=a1b2")).toEqual({ id: "project", project: { machineId: "laptop", projectId: "billing" }, message: null, at: "a1b2" });
    expect(toHash({ id: "project", project: { machineId: "laptop", projectId: "billing" }, message: null, at: "a1b2" })).toBe("#/project/laptop/billing?at=a1b2");
    expect(parseHash("#/project/devbox/storefront")).toEqual({ id: "project", project: { machineId: "devbox", projectId: "storefront" }, message: null });
    // A session's own window, as main opens it (main/sessionWindow.ts): on the hub it names.
    expect(parseHash("#/session/laptop/billing/bs-1?at=a1b2c3d4")).toEqual({ id: "session", project: { machineId: "laptop", projectId: "billing" }, session: "bs-1", at: "a1b2c3d4" });
    // Not a hub id: ignored, never passed on.
    expect(parseHash("#/status?at=..%2Fhub")).toEqual({ id: "status" });
    // The pairing screen's `hub` is an address, not which hub the screen is on.
    expect(parseHash("#/onboarding?hub=http%3A%2F%2Fdevbox%3A4790&at=a1b2")).toMatchObject({ id: "onboarding", hub: "http://devbox:4790", at: "a1b2" });
  });

  it("with one hub, never names it", () => {
    setRouteHubs(["hub"]);
    expect(hashFor({ id: "project", project: { machineId: "devbox", projectId: "storefront" }, message: null })).toBe("#/project/devbox/storefront");
    expect(currentRoute().at).toBe("hub");
  });

  it("with several, names the hub, and a route that doesn't stays on the hub of the one before", () => {
    setRouteHubs(["hub", "a1b2"]);
    navigate({ id: "project", project: { machineId: "laptop", projectId: "billing" }, message: null, at: "a1b2" });
    expect(window.location.hash).toBe("#/project/laptop/billing?at=a1b2");
    // A link a screen builds as a plain hash, and a navigate that names no hub.
    window.location.hash = "#/settings/agents";
    expect(currentRoute()).toMatchObject({ id: "settings", at: "a1b2" });
    navigate({ id: "status" });
    expect(window.location.hash).toBe("#/status?at=a1b2");
    navigate({ id: "status", at: "hub" });
    expect(window.location.hash).toBe("#/status?at=hub");
  });

  it("takes a hub since removed as the first", () => {
    setRouteHubs(["hub", "a1b2"]);
    window.location.hash = "#/status?at=gone1";
    expect(currentRoute().at).toBe("hub");
  });
});

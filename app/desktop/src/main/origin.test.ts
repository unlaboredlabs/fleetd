import { describe, expect, it } from "vitest";
import { APP_ORIGIN, assetPath, originOf } from "./origin";

describe("originOf", () => {
  it("tells the app's own pages from local files and other sites", () => {
    expect(originOf("app://fleetd/index.html#/settings")).toBe(APP_ORIGIN);
    expect(originOf("app://fleetd.evil/index.html")).not.toBe(APP_ORIGIN);
    expect(originOf("file:///tmp/x.html")).toBeNull();
    expect(originOf("file:///home/me/app/desktop/out/renderer/index.html")).toBeNull();
    expect(originOf("http://localhost:5173/")).toBe("http://localhost:5173");
    expect(originOf("not a url")).toBeNull();
  });
});

describe("assetPath", () => {
  const root = "/opt/fleetd/renderer";

  it("serves files under the renderer dir, index.html for the root", () => {
    expect(assetPath("app://fleetd/", root)).toBe("/opt/fleetd/renderer/index.html");
    expect(assetPath("app://fleetd/assets/index-1.js?x=1#y", root)).toBe("/opt/fleetd/renderer/assets/index-1.js");
  });

  it("never leaves the renderer dir, and refuses other origins", () => {
    // The URL parser folds plain and %2e dot segments at the root, so these stay inside.
    expect(assetPath("app://fleetd/../../etc/passwd", root)).toBe("/opt/fleetd/renderer/etc/passwd");
    expect(assetPath("app://fleetd/%2e%2e/%2e%2e/etc/passwd", root)).toBe("/opt/fleetd/renderer/etc/passwd");
    // Encoded slashes survive the parser and only decode here.
    expect(assetPath("app://fleetd/assets/..%2f..%2f..%2fetc%2fpasswd", root)).toBeNull();
    expect(assetPath("app://other/index.html", root)).toBeNull();
    expect(assetPath("file:///opt/fleetd/renderer/index.html", root)).toBeNull();
  });
});

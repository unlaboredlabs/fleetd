import { describe, expect, it } from "vitest";
import { feedUrl } from "./update-feed";

const EDGE = "https://github.com/unlaboredlabs/fleetd/releases/download/edge";

describe("feedUrl", () => {
  it("reads the edge release, where every build is published, whatever the running build's version", () => {
    expect(feedUrl(undefined)).toBe(EDGE);
  });

  it("takes an https or loopback override", () => {
    expect(feedUrl("https://mirror.example/fleetd")).toBe("https://mirror.example/fleetd");
    expect(feedUrl("http://127.0.0.1:8765")).toBe("http://127.0.0.1:8765");
    expect(feedUrl("http://localhost:8765/x")).toBe("http://localhost:8765/x");
    expect(feedUrl("http://[::1]:8765")).toBe("http://[::1]:8765");
  });

  it("ignores an override that anyone on the path could answer", () => {
    for (const raw of ["http://mirror.example/fleetd", "http://127.0.0.1.evil.example", "file:///tmp/feed", "not a url", ""]) {
      expect(feedUrl(raw)).toBe(EDGE);
    }
  });
});

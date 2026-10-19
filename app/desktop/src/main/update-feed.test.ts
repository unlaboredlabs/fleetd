import { describe, expect, it } from "vitest";
import { feedUrl } from "./update-feed";

const NIGHTLY = "https://github.com/unlaboredlabs/fleetd/releases/download/nightly";
const STABLE = "https://github.com/unlaboredlabs/fleetd/releases/latest/download";

describe("feedUrl", () => {
  it("follows the channel of the running build", () => {
    expect(feedUrl("0.4.0-nightly.202610191200+abc1234", undefined)).toBe(NIGHTLY);
    expect(feedUrl("0.4.0", undefined)).toBe(STABLE);
  });

  it("takes an https or loopback override", () => {
    expect(feedUrl("0.4.0", "https://mirror.example/fleetd")).toBe("https://mirror.example/fleetd");
    expect(feedUrl("0.4.0", "http://127.0.0.1:8765")).toBe("http://127.0.0.1:8765");
    expect(feedUrl("0.4.0", "http://localhost:8765/x")).toBe("http://localhost:8765/x");
    expect(feedUrl("0.4.0", "http://[::1]:8765")).toBe("http://[::1]:8765");
  });

  it("ignores an override that anyone on the path could answer", () => {
    for (const raw of ["http://mirror.example/fleetd", "http://127.0.0.1.evil.example", "file:///tmp/feed", "not a url", ""]) {
      expect(feedUrl("0.4.0-nightly.202610191200+abc1234", raw)).toBe(NIGHTLY);
    }
  });
});

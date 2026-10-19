import { describe, expect, it } from "vitest";
import { contactSheet } from "./report.ts";

describe("contactSheet", () => {
  it("names every pending screen and its reason, even with nothing shot", () => {
    const html = contactSheet([], [{ screen: "palette", fixtures: ["typical"], reason: "F11's palette has not landed" }]);
    expect(html).toContain("Not shot: 1 pending screen");
    expect(html).toContain("<b>palette</b> (typical): F11&#39;s palette has not landed");
  });
});

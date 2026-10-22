import { describe, expect, it } from "vitest";
import { asOfWords } from "./offline";

describe("asOfWords", () => {
  const now = Date.parse("2026-10-19T12:00:00.000Z");
  it("names the time, and the day when it wasn't today", () => {
    expect(asOfWords(Date.parse("2026-10-19T09:02:00.000Z"), now, "UTC")).toBe("as of 09:02");
    expect(asOfWords(Date.parse("2026-10-18T18:40:00.000Z"), now, "UTC")).toBe("as of yesterday 18:40");
    expect(asOfWords(Date.parse("2026-10-12T18:40:00.000Z"), now, "UTC")).toBe("as of Mon 12 Oct 18:40");
  });
});

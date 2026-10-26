import { describe, expect, it } from "vitest";
import { glyphOf } from "./parts";

describe("an agent's glyph", () => {
  it("shows each lane status as its state's shape: paused apart from queued, thinking apart from working", () => {
    expect(glyphOf("working")).toBe("working");
    expect(glyphOf("starting", true)).toBe("thinking");
    expect(glyphOf("stalled")).toBe("working");
    expect(glyphOf("waiting", true)).toBe("waiting");
    expect(glyphOf("queued")).toBe("queued");
    expect(glyphOf("idle")).toBe("queued");
    expect(glyphOf("parked")).toBe("paused");
    expect(glyphOf("done")).toBe("done");
    expect(glyphOf("cancelled")).toBe("done");
    expect(glyphOf("failed")).toBe("failed");
  });
});

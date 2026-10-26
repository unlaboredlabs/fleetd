import { describe, expect, it } from "vitest";
import { draftOf, parseCaps } from "./memoryCapsModel";

const caps = { user: 16000, index: 16000, topic: 32000, project: 128000 };

describe("the memory caps form", () => {
  it("sends the numbers as typed, commas and all", () => {
    expect(parseCaps(draftOf(caps))).toEqual({ ok: true, caps });
    expect(parseCaps({ ...draftOf(caps), user: "20,000", project: "400 000" })).toEqual({ ok: true, caps: { ...caps, user: 20000, project: 400000 } });
  });

  it("names the field outside the range the hub takes", () => {
    expect(parseCaps({ ...draftOf(caps), topic: "100001" })).toEqual({ ok: false, key: "topic", reason: "Each topic file: a whole number of characters from 1,000 to 100,000." });
    expect(parseCaps({ ...draftOf(caps), project: "400001" })).toMatchObject({ ok: false, key: "project" });
    expect(parseCaps({ ...draftOf(caps), user: "999" })).toMatchObject({ ok: false, key: "user" });
    expect(parseCaps({ ...draftOf(caps), index: "12.5" })).toMatchObject({ ok: false, key: "index" });
    expect(parseCaps({ ...draftOf(caps), index: "" })).toMatchObject({ ok: false, key: "index" });
  });
});

import { describe, expect, it } from "vitest";
import { archiveWords } from "./archive";

describe("Archive from the hold menu", () => {
  it("archives a bot, or brings an archived one back, in the desktop's words", () => {
    expect(archiveWords("Ada", false)).toEqual({ label: "Archive", done: "Ada archived", failed: "Couldn't archive Ada" });
    expect(archiveWords("Taxes", true)).toEqual({ label: "Unarchive", done: "Taxes is back", failed: "Couldn't bring back Taxes" });
  });
});

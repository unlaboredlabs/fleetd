import { describe, expect, it } from "vitest";
import { plainWords } from "./plain";

describe("a message's words before the parser has come", () => {
  it("drops markdown's marks and keeps the words and line breaks", () => {
    expect(plainWords("## Plan\n\n**Ship** the [fix](https://x.invalid) in `main`.\n- one\n- two")).toBe("Plan\n\nShip the fix in main.\n- one\n- two");
  });

  it("leaves a lead's block out, never its JSON, and keeps a code fence's contents", () => {
    expect(plainWords('Done.\n```fleetd-block\n{"kind":"pr","number":12}\n```\n```ts\nconst a = 1;\n```')).toBe("Done.\nconst a = 1;");
    // Off for a person's words: their fence is code like any other.
    expect(plainWords("```fleetd-block\nraw\n```", false)).toBe("raw");
  });
});

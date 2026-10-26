import { expect, it } from "vitest";
import { plainText } from "./plain";

it("drops markdown's marks and keeps the words", () => {
  expect(plainText("## Done\n\n> **Merged** [PR #12](#/p/devbox/storefront) with `fleetd/T1`, _quietly_.")).toBe(
    "Done\n\nMerged PR #12 with fleetd/T1, quietly.",
  );
});

it("keeps lists, snake_case and a fence's contents as written", () => {
  expect(plainText("- one\n- two_three\n\n```ts\nconst **x** = 1;\n```")).toBe("- one\n- two_three\n\nconst **x** = 1;");
});

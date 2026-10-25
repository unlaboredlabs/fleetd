// @vitest-environment happy-dom
import { beforeEach, expect, it } from "vitest";
import { bubbleKey, resetTapbacks, toggleTapback } from "./tapbacks";

const stored = (): unknown => JSON.parse(window.localStorage.getItem("fleetd.tapbacks") ?? "{}");

beforeEach(() => {
  window.localStorage.clear();
  resetTapbacks();
});

it("keeps one tapback per bubble, takes it off when picked again, and outlives the launch", () => {
  const b = bubbleKey("m1", "0");
  toggleTapback("devbox/app", b, "❤️");
  toggleTapback("devbox/app", b, "👍");
  expect(stored()).toEqual({ "devbox/app": { [b]: "👍" } });
  // A new launch reads them back, dropping anything that isn't a tapback.
  window.localStorage.setItem("fleetd.tapbacks", JSON.stringify({ "devbox/app": { [b]: "👍", junk: "nope" } }));
  resetTapbacks();
  toggleTapback("devbox/app", bubbleKey("m2", "1"), "😂");
  expect(stored()).toEqual({ "devbox/app": { [b]: "👍", "m2/1": "😂" } });
  toggleTapback("devbox/app", b, "👍");
  expect(stored()).toEqual({ "devbox/app": { "m2/1": "😂" } });
});

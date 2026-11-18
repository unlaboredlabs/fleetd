// @vitest-environment happy-dom
import { expect, it } from "vitest";
import { covered } from "./covered";

it("counts an element under an inert ancestor (the app under a sheet) as covered, and nothing else", () => {
  document.body.innerHTML = `<div id="app"><span id="glyph"></span></div><div id="sheet"><span id="own"></span></div>`;
  const glyph = document.getElementById("glyph");
  expect(covered(glyph)).toBe(false);
  document.getElementById("app")?.setAttribute("inert", "");
  expect(covered(glyph)).toBe(true);
  expect(covered(document.getElementById("own"))).toBe(false);
  expect(covered(null)).toBe(false);
});

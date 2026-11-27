// @vitest-environment happy-dom
import { expect, it } from "vitest";
import { followTabTitle, tabCount, tabPlace } from "./tabTitle";

it("names where you are, then fleetd, after how many wait on you; the newest place shown wins", () => {
  document.title = "kept";
  const chat = tabPlace("storefront");
  // Off until the web turns it on: the desktop's window keeps its own title.
  expect(document.title).toBe("kept");
  followTabTitle();
  expect(document.title).toBe("storefront · fleetd");
  const settings = tabPlace("Settings");
  tabCount(2);
  expect(document.title).toBe("(2) Settings · fleetd");
  settings();
  expect(document.title).toBe("(2) storefront · fleetd");
  tabCount(0);
  chat();
  expect(document.title).toBe("fleetd");
});

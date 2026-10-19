import { describe, expect, it } from "vitest";
import { debugSwitches } from "./debug-switches";

const none = () => false;

describe("debugSwitches", () => {
  it("finds DevTools and inspector switches in argv, with or without values, one dash or two", () => {
    expect(debugSwitches(["/opt/fleetd/fleetd", "--remote-debugging-port=0"], {}, none)).toEqual(["remote-debugging-port"]);
    expect(debugSwitches(["fleetd", "--remote-debugging-pipe", "-inspect-brk=9229", "--INSPECT"], {}, none)).toEqual([
      "inspect",
      "inspect-brk",
      "remote-debugging-pipe",
    ]);
    expect(debugSwitches(["fleetd", "--remote-debugging-address=0.0.0.0"], {}, none)).toEqual(["remote-debugging-address"]);
  });

  it("finds them in ELECTRON_EXTRA_LAUNCH_ARGS and NODE_OPTIONS", () => {
    expect(debugSwitches(["fleetd"], { ELECTRON_EXTRA_LAUNCH_ARGS: "--foo  --remote-debugging-port=9333" }, none)).toEqual([
      "remote-debugging-port",
    ]);
    expect(debugSwitches(["fleetd"], { NODE_OPTIONS: "--max-old-space-size=4096 --inspect=9229" }, none)).toEqual(["inspect"]);
  });

  it("asks Chromium's parsed command line too", () => {
    expect(debugSwitches(["fleetd"], {}, (name) => name === "remote-debugging-pipe")).toEqual(["remote-debugging-pipe"]);
  });

  it("leaves ordinary launches alone", () => {
    expect(debugSwitches(["fleetd", "--no-sandbox", "fleetd://pair?code=--inspect", "--inspector-theme=x", "--enable-logging"], { NODE_OPTIONS: "" }, none)).toEqual([]);
  });
});

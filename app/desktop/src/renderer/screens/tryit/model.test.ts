import { describe, expect, it } from "vitest";
import type { Preview } from "../../../shared/contracts";
import { atStep, configLines, configWords, endWords, ofPr, previewFor, sameOf, startedWords, suggestionFor, tookWords, tryAction, wirePins } from "./model";

const preview = (id: string, state: Preview["state"], number = 14, more: Partial<Preview> = {}): Preview => ({
  previewId: `P${id.repeat(32)}`,
  projectRef: { machineId: "devbox", projectId: "p1" },
  of: ofPr("acme/storefront", number),
  target: "web",
  machineId: "devbox",
  state,
  askedBy: { words: "you" },
  startedAt: "2026-10-19T10:00:00.000Z",
  ...more,
});

describe("Try it", () => {
  it("shows the PR's running preview first, else its newest that ended, and never another PR's", () => {
    const ended = preview("a", "ended");
    const ready = preview("b", "ready");
    const other = preview("c", "ready", 15);
    expect(previewFor([ended, other, ready], ofPr("acme/storefront", 14))).toBe(ready);
    expect(previewFor([ended, other], ofPr("acme/storefront", 14))).toBe(ended);
    expect(previewFor([other], ofPr("acme/storefront", 14))).toBeUndefined();
    expect(sameOf(ofPr("acme/a", 1), ofPr("acme/b", 1))).toBe(false);
    expect(sameOf({ kind: "order", workstreamId: "W1" }, { kind: "order", workstreamId: "W1" })).toBe(true);
  });

  it("reopens one that is starting or ready, and starts one only when none runs and the key may", () => {
    expect(tryAction(preview("a", "starting"), false)).toBe("open");
    expect(tryAction(preview("a", "ready"), true)).toBe("open");
    expect(tryAction(preview("a", "ended"), true)).toBe("start");
    expect(tryAction(preview("a", "failed"), undefined)).toBe("start");
    expect(tryAction(undefined, true)).toBe("start");
    // A hub from before canStart: offered, and its refusal says why.
    expect(tryAction(undefined, undefined)).toBe("start");
    // A read key (D162): only a running one opens.
    expect(tryAction(undefined, false)).toBe("none");
    expect(tryAction(preview("a", "ended"), false)).toBe("none");
    // A state from a newer hub is not one to reopen.
    expect(tryAction(preview("a", "paused"), true)).toBe("start");
  });

  it("finds a suggestion by its PR", () => {
    const x = { projectRef: { machineId: "devbox", projectId: "p1" }, of: ofPr("acme/storefront", 14), by: "#14’s writer", why: "the buttons", at: "2026-10-19T10:00:00.000Z" };
    expect(suggestionFor([x], ofPr("acme/storefront", 14))).toBe(x);
    expect(suggestionFor([x], ofPr("acme/storefront", 13))).toBeUndefined();
  });

  it("says the step at work, how long steps took, and why it ended", () => {
    expect(atStep([{ words: "Check out", state: "done" }, { words: "Build", state: "running" }, { words: "Start", state: "queued" }])).toMatchObject({ step: { words: "Build" }, n: 2, of: 3 });
    expect(atStep([{ words: "Check out", state: "done" }, { words: "Start", state: "queued" }])).toMatchObject({ step: { words: "Start" }, n: 2 });
    expect(atStep([])).toMatchObject({ step: undefined, of: 0 });
    expect([tookWords(400), tookWords(41_000), tookWords(72_000), tookWords(120_000), tookWords(undefined)]).toEqual(["0 s", "41 s", "1 min 12 s", "2 min", ""]);
    expect(endWords({ endReason: "idle" })).toBe("It ended after no one used it for a while.");
    expect(endWords({ endReason: "melted" })).toBe("It ended.");
    expect(endWords({})).toBe("It ended.");
    const p = preview("a", "ready", 14, { readyAt: "2026-10-19T10:00:44.000Z", steps: [{ words: "Setup", state: "reused" }, { words: "Build", state: "done" }] });
    expect(startedWords(p)).toBe("Ready in 44 s; one step reused.");
  });

  it("sends pins in ten-thousandths of the screen, with the page they were on and the words trimmed", () => {
    expect(wirePins([{ x: 0.76, y: 0.7612, note: "  wraps in Dutch " }, { x: -0.1, y: 1.4, note: " " }], "http://devbox:8414/checkout?lang=nl")).toEqual([
      { x: 7600, y: 7612, note: "wraps in Dutch", at: "http://devbox:8414/checkout?lang=nl" },
      { x: 0, y: 10_000, at: "http://devbox:8414/checkout?lang=nl" },
    ]);
    expect(wirePins([{ x: 0.5, y: 0.5, note: "" }], undefined)).toEqual([{ x: 5000, y: 5000 }]);
  });

  it("shows a proposed setting's commands in the order they run", () => {
    const config = { web: { setup: ["pnpm install --frozen-lockfile"], build: "pnpm build", start: "pnpm preview --port $PORT --host 127.0.0.1", ready: "/", inputs: ["pnpm-lock.yaml"] }, idleMinutes: 30 };
    expect(configLines(config)).toEqual(["setup: pnpm install --frozen-lockfile", "build: pnpm build", "start: pnpm preview --port $PORT --host 127.0.0.1", "ready: /"]);
    expect(configWords(config)).toBe("On the web, at $PORT on 127.0.0.1. A preview ends after 30 min without use. Setup is skipped while pnpm-lock.yaml hasn’t changed.");
    expect(configLines({})).toEqual([]);
  });
});

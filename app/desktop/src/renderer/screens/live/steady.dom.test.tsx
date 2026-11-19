// @vitest-environment happy-dom
// The shared hold on a live line (shared/steady.ts), as the agents' rows, the island and the phone's turn line use it.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GAP_MS, HOLD_MS, steadyWait, useSteady } from "../../../shared/steady";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("steadyWait", () => {
  it("waits out what is left of the hold, and a quiet line at least the gap", () => {
    expect(steadyWait(0, 5000, false)).toBe(0);
    expect(steadyWait(5000, 5200, false)).toBe(HOLD_MS - 200);
    expect(steadyWait(0, 5000, true)).toBe(GAP_MS);
    expect(steadyWait(5000, 5900, true)).toBe(GAP_MS);
  });
});

/** A line drawn through useSteady: its words, "thinking" the quiet one. */
function Line({ words }: { words: string }) {
  return <span>{useSteady(words, words, words === "thinking")}</span>;
}

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.useFakeTimers();
  host = document.createElement("div");
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  vi.useRealTimers();
});

const show = (words: string) => {
  act(() => root.render(<Line words={words} />));
};
const pass = (ms: number) => {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
};

describe("useSteady", () => {
  it("shows the first line, and the first change at once", () => {
    show("thinking");
    expect(host.textContent).toBe("thinking");
    show("running ls");
    pass(0);
    expect(host.textContent).toBe("running ls");
  });

  it("holds a shown line HOLD_MS, then shows the latest of those that came meanwhile", () => {
    show("running ls");
    show("running rg");
    pass(0);
    show("reading a.ts");
    show("editing b.ts");
    pass(HOLD_MS - 10);
    expect(host.textContent).toBe("running rg");
    pass(10);
    expect(host.textContent).toBe("editing b.ts");
  });

  it("never shows a short gap of thinking between two tool calls, long held or not", () => {
    show("running ls");
    pass(5000);
    show("thinking");
    pass(GAP_MS - 100);
    show("running rg");
    pass(0);
    expect(host.textContent).toBe("running rg");
  });

  it("shows thinking once it has lasted GAP_MS", () => {
    show("running ls");
    pass(5000);
    show("thinking");
    pass(GAP_MS - 1);
    expect(host.textContent).toBe("running ls");
    pass(1);
    expect(host.textContent).toBe("thinking");
  });

  it("keeps the shown line, with no change, when the latest returns to it before its turn", () => {
    show("running ls");
    show("running rg");
    pass(0);
    show("reading a.ts");
    pass(HOLD_MS / 2);
    show("running rg");
    pass(HOLD_MS * 3);
    expect(host.textContent).toBe("running rg");
  });
});

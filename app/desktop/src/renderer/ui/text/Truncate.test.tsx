// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "../primitives/Tooltip";
import { Truncate } from "./Truncate";

// happy-dom has no layout: a truncating span in the page reports text 500 px wide in a 100 px box when `cutText`
// is on; a detached element measures 0, as in a browser.
let cutText = true;
Object.defineProperty(HTMLElement.prototype, "scrollWidth", {
  configurable: true,
  get(this: HTMLElement) {
    if (!this.isConnected) return 0;
    return this.dataset["text"] === "truncate" && cutText ? 500 : 100;
  },
});
Object.defineProperty(HTMLElement.prototype, "clientWidth", {
  configurable: true,
  get(this: HTMLElement) {
    return this.isConnected ? 100 : 0;
  },
});

// Like the real one: each element is reported once when observed, and again (as 0x0) when it leaves the page.
// The second half is what made the old Truncate flip back to plain text after every remount.
class FakeResizeObserver {
  private targets = new Set<Element>();
  private watcher = new MutationObserver(() => {
    const gone = [...this.targets].filter((t) => !t.isConnected);
    if (gone.length > 0) this.cb(gone.map((target) => ({ target }) as ResizeObserverEntry), this);
  });
  constructor(private cb: ResizeObserverCallback) {
    this.watcher.observe(document.body, { childList: true, subtree: true });
  }
  observe(target: Element) {
    this.targets.add(target);
    queueMicrotask(() => this.cb([{ target } as ResizeObserverEntry], this));
  }
  unobserve(target: Element) {
    this.targets.delete(target);
  }
  disconnect() {
    this.targets.clear();
  }
}
vi.stubGlobal("ResizeObserver", FakeResizeObserver);

const copy = vi.fn((_text: string) => Promise.resolve());
Object.defineProperty(window, "fleetd", { configurable: true, value: { copy } });

const LONG = "Move the storefront checkout to the payments service and keep the old endpoint behind a flag";
let host: HTMLDivElement;
let root: Root;

async function render(node: React.ReactNode) {
  await act(async () => {
    root.render(<TooltipProvider>{node}</TooltipProvider>);
    await Promise.resolve();
  });
  // Let the observer's first report and the state it sets settle.
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

const slot = () => host.querySelector<HTMLElement>("[data-text]");
const press = async (el: Element, key: string) => {
  await act(async () => {
    el.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
    await new Promise((r) => setTimeout(r, 0));
  });
};

beforeEach(() => {
  cutText = true;
  copy.mockClear();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  document.body.innerHTML = "";
});

describe("Truncate", () => {
  it("cut text is a focusable button, and Enter opens the full text with Copy", async () => {
    await render(<Truncate>{LONG}</Truncate>);
    const el = slot();
    expect(el?.getAttribute("role")).toBe("button");
    expect(el?.tabIndex).toBe(0);
    if (!el) throw new Error("no slot");
    await press(el, "Enter");
    const copyButton = [...document.querySelectorAll("button")].find((b) => b.textContent.includes("Copy"));
    expect(copyButton).toBeDefined();
    expect(document.body.textContent).toContain(LONG);
    await act(async () => {
      copyButton?.click();
      await Promise.resolve();
    });
    expect(copy).toHaveBeenCalledWith(LONG);
  });

  it("a click opens it too, and the slot stays interactive afterwards", async () => {
    await render(<Truncate>{LONG}</Truncate>);
    await act(async () => {
      slot()?.click();
      await new Promise((r) => setTimeout(r, 0));
    });
    expect([...document.querySelectorAll("button")].some((b) => b.textContent.includes("Copy"))).toBe(true);
    expect(slot()?.getAttribute("role")).toBe("button");
  });

  it("text that fits has no affordances", async () => {
    cutText = false;
    await render(<Truncate>short</Truncate>);
    expect(slot()?.hasAttribute("role")).toBe(false);
    expect(slot()?.hasAttribute("tabindex")).toBe(false);
  });

  it("expand=inline unfolds in place, keeps focus, and Escape folds it back", async () => {
    await render(<Truncate expand="inline">{LONG}</Truncate>);
    const el = slot();
    if (!el) throw new Error("no slot");
    await press(el, "Enter");
    expect(slot()?.dataset["text"]).toBe("wrap");
    expect(document.activeElement).toBe(slot());
    await press(slot() as HTMLElement, "Escape");
    expect(slot()?.dataset["text"]).toBe("truncate");
    expect(document.activeElement).toBe(slot());
  });

  it("expand=none only tooltips, so a row keeps the click", async () => {
    await render(<Truncate expand="none">{LONG}</Truncate>);
    expect(slot()?.hasAttribute("tabindex")).toBe(false);
  });
});

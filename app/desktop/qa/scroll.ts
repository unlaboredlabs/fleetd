// The chat holding still under the reader (W733): watches, frame by frame once each has painted, the row under the
// conversation's middle and the list's own box, and says every frame something other than the wheel moved them (a
// picture loading above, a banner pushing the list down). perf/scroll.ts records the same in long runs.
//
// A row's move on screen is the list's content moving under it (a picture growing above it) less the list's scroll,
// and the scroll is the page's own (a scrollTop write, scrollTo) or the browser's (the wheel's). The first two are
// read in the same frame as the row, so any move they make that the other doesn't undo is said at once. The wheel's
// scroll is matched with the wheel's events over the whole watch, not frame by frame: on macOS the browser scrolls on
// its own thread and the page reads the event and the scroll it made in different frames, either first, up to 600 ms
// apart on a loaded runner (W771). Whatever the browser scrolled that the wheel didn't ask for is said at the end.
import type { Page } from "@playwright/test";

/** Starts watching the chat's conversation. */
export const watchScroll = (page: Page) =>
  page.evaluate(() => {
    const el = document.querySelector<HTMLElement>('[aria-label="Conversation with the lead"]');
    if (!el) throw new Error("no conversation");
    const moves: string[] = [];
    // Px the wheel asked the rows to move (up the wheel, down the rows) since the watch began, and that less what the
    // browser's scroll has moved them.
    let asked = 0;
    let owed = 0;
    el.addEventListener(
      "wheel",
      (e) => {
        owed -= e.deltaY;
        asked -= e.deltaY;
      },
      { passive: true, capture: true },
    );
    // Px the page's own writes scrolled the list since the frame before.
    let own = 0;
    const read = Object.getOwnPropertyDescriptor(Element.prototype, "scrollTop") as { get: (this: Element) => number; set: (this: Element, v: number) => void };
    const written = (write: () => void) => {
      const from = read.get.call(el);
      write();
      own += read.get.call(el) - from;
    };
    Object.defineProperty(el, "scrollTop", {
      configurable: true,
      get: () => read.get.call(el),
      set: (v: number) => written(() => read.set.call(el, v)),
    });
    for (const name of ["scrollTo", "scroll", "scrollBy"] as const) {
      const real = el[name].bind(el) as (...a: unknown[]) => void;
      el[name] = (...a: unknown[]) => written(() => real(...a));
    }
    let anchor: Element | null = null;
    let anchorTop = 0;
    let box = el.getBoundingClientRect();
    let was = el.scrollTop;
    const after = new MessageChannel();
    after.port1.onmessage = () => {
      const r = el.getBoundingClientRect();
      if (Math.abs(r.top - box.top) >= 2 || Math.abs(r.height - box.height) >= 2) moves.push(`the list's box moved: top ${String(box.top)} -> ${String(r.top)}, height ${String(box.height)} -> ${String(r.height)}`);
      box = r;
      const top = el.scrollTop;
      // The browser's scroll since the frame before: the wheel's, or one it made by itself.
      const browser = top - was - own;
      if (anchor?.isConnected === true) {
        const moved = anchor.getBoundingClientRect().top - anchorTop;
        const off = moved + browser;
        if (Math.abs(off) >= 2) moves.push(`rows moved ${off.toFixed(0)} px more than the wheel's scroll at scrollTop ${String(top)}`);
      }
      owed += browser;
      own = 0;
      was = top;
      anchor = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)?.closest("[data-index]") ?? null;
      anchorTop = anchor?.getBoundingClientRect().top ?? 0;
    };
    const tick = () => {
      after.port2.postMessage(0);
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    const end = () => {
      // At the end the wheel pushed towards, it moves less than it asks.
      const atEnd = asked > 0 ? el.scrollTop <= 1 : el.scrollTop + el.clientHeight >= el.scrollHeight - 1;
      const short = Math.sign(owed) === Math.sign(asked) && Math.abs(owed) <= Math.abs(asked) && atEnd;
      return Math.abs(owed) < 2 || short ? [] : [`the list scrolled ${(-owed).toFixed(0)} px more than the wheel asked (${String(asked)}), ending at scrollTop ${String(el.scrollTop)}`];
    };
    Object.assign(window, { __scrollMoves: () => [...moves, ...end()] });
  });

/** Every move since watchScroll that the wheel didn't make. */
export const scrollMoves = (page: Page): Promise<string[]> => page.evaluate(() => (window as unknown as { __scrollMoves: () => string[] }).__scrollMoves());

/** Mouse wheel notches over the conversation, 100 px each, ~12 a second, up for `n` < 0. */
export const notches = async (page: Page, n: number) => {
  const box = await page.getByLabel("Conversation with the lead").boundingBox();
  if (!box) throw new Error("no conversation");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  for (let i = 0; i < Math.abs(n); i++) {
    await page.mouse.wheel(0, Math.sign(n) * 100);
    await page.waitForTimeout(80);
  }
};

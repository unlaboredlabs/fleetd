// The chat holding still under the reader (W733): watches, frame by frame once each has painted, the row under the
// conversation's middle and the list's own box, and says every frame something other than the wheel moved them (a
// picture loading above, a banner pushing the list down). perf/scroll.ts records the same in long runs.
import type { Page } from "@playwright/test";

/** Starts watching the chat's conversation. */
export const watchScroll = (page: Page) =>
  page.evaluate(() => {
    const el = document.querySelector<HTMLElement>('[aria-label="Conversation with the lead"]');
    if (!el) throw new Error("no conversation");
    const moves: string[] = [];
    // Wheel deltas since the frame before, px the rows should move (up the wheel, down the rows).
    let asked = 0;
    el.addEventListener("wheel", (e) => (asked -= e.deltaY), { passive: true, capture: true });
    let anchor: Element | null = null;
    let anchorTop = 0;
    let box = el.getBoundingClientRect();
    let was = { top: el.scrollTop, height: el.scrollHeight, view: el.clientHeight };
    /** A frame off by `off` with no wheel, waiting a frame: a wheel event read a frame late shows as -N then +N. */
    let held: { off: number; what: string } | undefined;
    const after = new MessageChannel();
    after.port1.onmessage = () => {
      const r = el.getBoundingClientRect();
      if (Math.abs(r.top - box.top) >= 2 || Math.abs(r.height - box.height) >= 2) moves.push(`the list's box moved: top ${String(box.top)} -> ${String(r.top)}, height ${String(box.height)} -> ${String(r.height)}`);
      box = r;
      const now = { top: el.scrollTop, height: el.scrollHeight, view: el.clientHeight };
      // At either end the wheel moves less than it asks.
      const ends = (s: typeof now) => s.top <= 1 || s.top + s.view >= s.height - 1;
      if (anchor?.isConnected === true) {
        const moved = anchor.getBoundingClientRect().top - anchorTop;
        const off = asked !== 0 && (ends(now) || ends(was)) ? (Math.sign(moved) === Math.sign(asked) || moved === 0 ? 0 : moved) : moved - asked;
        const what = `rows moved ${off.toFixed(0)} px more than the wheel (${String(asked)}) at scrollTop ${String(now.top)}`;
        if (held !== undefined && Math.abs(held.off + off) < 2) held = undefined;
        else {
          if (held !== undefined) moves.push(held.what);
          held = Math.abs(off) >= 2 ? { off, what } : undefined;
        }
      }
      asked = 0;
      was = now;
      anchor = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)?.closest("[data-index]") ?? null;
      anchorTop = anchor?.getBoundingClientRect().top ?? 0;
    };
    const tick = () => {
      after.port2.postMessage(0);
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    Object.assign(window, { __scrollMoves: () => [...moves, ...(held === undefined ? [] : [held.what])] });
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

// Scroll recorder (W733): drives wheel input over CDP into the built app's chat (`pnpm build:test`, fixtures/scroll)
// and records, per frame, scrollTop, scrollHeight and how far the row under the view's middle moved on screen, with
// every write to the list's scroll position and who made it. node perf/scroll.ts <scenario> <out.json>
import { writeFileSync } from "node:fs";
import { chromium, type CDPSession, type Page } from "@playwright/test";
import { devtoolsPort, launch, openChat, sleep } from "./app.ts";

const [scenario = "idle-up", out = "rec.json"] = process.argv.slice(2);

const install = (page: Page) =>
  page.evaluate(() => {
    const el = document.querySelector<HTMLElement>('[aria-label="Conversation with the lead"]');
    if (!el) throw new Error("no list");
    const rec = { frames: [] as unknown[][], wheels: [] as number[][], writes: [] as unknown[][], marks: [] as unknown[][], run: true };
    el.addEventListener("wheel", (e) => rec.wheels.push([performance.now(), e.deltaY]), { passive: true, capture: true });
    let anchor: Element | null = null;
    let anchorTop = 0;
    let anchorText = "";
    // Read once the frame has painted (a task posted from its animation frame runs after its rendering): what a
    // ResizeObserver changed before the paint is what the reader saw.
    const after = new MessageChannel();
    after.port1.onmessage = () => {
      let shift = Number.NaN;
      if (anchor?.isConnected !== true && anchorText !== "") anchor = [...el.querySelectorAll("[data-index]")].find((row) => row.textContent.slice(0, 200) === anchorText) ?? null;
      if (anchor?.isConnected === true) shift = anchor.getBoundingClientRect().top - anchorTop;
      const r = el.getBoundingClientRect();
      anchor = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)?.closest("[data-index]") ?? null;
      anchorTop = anchor?.getBoundingClientRect().top ?? 0;
      anchorText = (anchor?.textContent ?? "").slice(0, 200);
      rec.frames.push([performance.now(), el.scrollTop, el.scrollHeight, shift, el.clientHeight, anchorText.slice(0, 40), el.clientWidth]);
    };
    const tick = () => {
      after.port2.postMessage(0);
      if (rec.run) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    const who = () => (new Error().stack ?? "").split("\n").slice(2, 7).map((l) => l.trim().replace(/^at /u, "").replace(/\(.*\/(assets\/[^)]*)\)/u, "$1")).join(" < ");
    const desc = Object.getOwnPropertyDescriptor(Element.prototype, "scrollTop") as { get: (this: Element) => number; set: (this: Element, v: number) => void };
    Object.defineProperty(el, "scrollTop", {
      configurable: true,
      get(this: Element): number {
        return desc.get.call(this);
      },
      set(this: Element, v: number) {
        rec.writes.push([performance.now(), desc.get.call(this), v, who()]);
        desc.set.call(this, v);
      },
    });
    const to = el.scrollTo.bind(el);
    el.scrollTo = ((a: ScrollToOptions | number, b?: number) => {
      const top = typeof a === "number" ? b : a.top;
      rec.writes.push([performance.now(), el.scrollTop, top ?? Number.NaN, who()]);
      return typeof a === "number" ? to(a, b ?? 0) : to(a);
    }) as typeof el.scrollTo;
    Object.assign(window, { __rec: rec, __mark: (what: string) => rec.marks.push([performance.now(), what]) });
  });

const wheel = (cdp: CDPSession, x: number, y: number, dy: number) => cdp.send("Input.dispatchMouseEvent", { type: "mouseWheel", x, y, deltaX: 0, deltaY: dy });
const mark = (page: Page, what: string) => page.evaluate((w) => (window as unknown as { __mark: (w: string) => void }).__mark(w), what);

/** Mouse wheel notches, 100 px each, ~12 a second. */
const notches = async (cdp: CDPSession, x: number, y: number, n: number, dir: number) => {
  for (let i = 0; i < n; i++) {
    await wheel(cdp, x, y, dir * 100);
    await sleep(80);
  }
};
/** A trackpad flick: many small deltas, decaying like momentum. */
const flick = async (cdp: CDPSession, x: number, y: number, dir: number) => {
  for (let v = 60; v > 1; v *= 0.93) {
    await wheel(cdp, x, y, dir * Math.round(v));
    await sleep(16);
  }
};

const fixtureOf = (s: string) => (s.startsWith("still-") ? "scroll-still" : "scroll-busy");

const drive = async (page: Page, cdp: CDPSession, x: number, y: number) => {
  // The window's content resizing, as a drag of its edge does.
  const height = await page.evaluate(() => innerHeight);
  const setWidth = (width: number) => page.setViewportSize({ width, height });
  switch (scenario) {
    // Scrolled up a few screens, then still while messages, edits, pictures and agents' lines arrive below and in view.
    case "idle-up":
      await notches(cdp, x, y, 25, -1);
      await mark(page, "still");
      await sleep(20_000);
      return;
    // Reading up through history as older pages load (300 ms each), trackpad flicks, while messages arrive.
    case "read-up":
    case "still-read-up":
      for (let i = 0; i < 14; i++) await flick(cdp, x, y, -1);
      await mark(page, "still");
      await sleep(3000);
      return;
    // Up past pictures, back down to the end, and once their bytes have left memory (ATTACHMENT_GC_MS), up again.
    case "still-reread-up":
      await notches(cdp, x, y, 40, -1);
      await sleep(1500);
      await notches(cdp, x, y, 45, 1);
      await sleep(12_000);
      await mark(page, "again");
      for (let i = 0; i < 10; i++) await flick(cdp, x, y, -1);
      await mark(page, "still");
      await sleep(2000);
      return;
    // Far up, then back down toward the end, while messages arrive.
    case "read-down":
      await notches(cdp, x, y, 40, -1);
      await sleep(1500);
      await mark(page, "down");
      for (let i = 0; i < 12; i++) await flick(cdp, x, y, 1);
      await mark(page, "still");
      await sleep(3000);
      return;
    // Scrolled up and still through the hub restarting (fixtures/scroll's RESTART_AT_MS, 30 s after it subscribed).
    case "restart":
      await notches(cdp, x, y, 25, -1);
      await mark(page, "still");
      await sleep(32_000);
      return;
    // Scrolled up, the window narrower and wider again.
    case "resize":
    case "still-resize":
      await notches(cdp, x, y, 25, -1);
      await sleep(1000);
      await mark(page, "narrow");
      await setWidth(640);
      await sleep(1500);
      await mark(page, "wide");
      await setWidth(1440);
      await sleep(1500);
      return;
    // Scrolled up, the bot's panel closed and opened again (its title pill): the chat narrower, then wider.
    case "panel":
    case "still-panel": {
      await notches(cdp, x, y, 25, -1);
      await sleep(1000);
      const pill = page.getByRole("button", { name: /its agents, PRs and checklist/u });
      await mark(page, "closed");
      await pill.click();
      await sleep(1500);
      await mark(page, "open");
      await pill.click();
      await sleep(1500);
      return;
    }
    default:
      throw new Error(`no scenario ${scenario}`);
  }
};

const app = launch({ debug: true, env: { FLEETD_FIXTURE: fixtureOf(scenario) } });
try {
  const port = await devtoolsPort(app);
  await app.waitFor(/^FLEETD_PERF launch /u, 30_000);
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${String(port)}`);
  const page = browser
    .contexts()
    .flatMap((c) => c.pages())
    .find((p) => new URL(p.url()).pathname.endsWith("/index.html"));
  if (!page) throw new Error("no page");
  const { log } = await openChat(page);
  await sleep(1500);
  const box = await log.boundingBox();
  if (!box) throw new Error("no box");
  const cdp = await page.context().newCDPSession(page);
  await install(page);
  await drive(page, cdp, box.x + box.width / 2, box.y + box.height / 2);
  await sleep(1000);
  const rec = await page.evaluate(() => {
    const r = (window as unknown as { __rec: { run: boolean } }).__rec;
    r.run = false;
    return r;
  });
  writeFileSync(out, JSON.stringify({ scenario, ...rec }));
  await browser.close();
} finally {
  await app.stop();
}

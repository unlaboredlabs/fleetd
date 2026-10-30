// Dropping dragged sidebar rows in the built app (`pnpm qa:build`, `pnpm fixtures`, then `pnpm perf:drops`): a long
// sidebar (status-rows with more projects, so it scrolls), a hub that keeps the order as a real one does (it answers
// sidebar_order_get with the last sidebar_order_set and sends sidebar.order after each), and drops made with the mouse
// through Chromium's input pipeline: short, long, down and up in a scrolled list, from either end, after the edge's
// autoscroll, as another desktop's move arrives, as the hub's own echo comes back early or late, and as a reply draws
// the rows again. Each animation frame from before the press until well after the release, every row's place on screen
// is recorded. A drop jumps when, from the press on, a row the drag never reaches moves at all, or a row it reaches
// goes anywhere but up to one slot over and back, or doesn't end where the drop puts it (the row above a row dragged
// down jumping up past its place); or when, after the release, a row moves farther in a frame than the glide's curve
// would take it (a snap), or turns back without the order having changed. A drag that never lifts, or lands where it
// started, fails.
//
//   --theme light|dark   (default light)
//   --strip DIR          also write each drop's frames (Chromium's screencast), named by ms from just before the press
//   --rounds N           how many times the drops are made (default 3)
//   --only TEXT          only the drops whose name has TEXT
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import type { CDPSession, Page } from "@playwright/test";
import { fixturesDir, launch } from "../qa/harness.ts";
import type { FixtureName } from "../qa/registry.ts";

const { values: flags } = parseArgs({ options: { theme: { type: "string" }, strip: { type: "string" }, rounds: { type: "string" }, only: { type: "string" } } });
const theme: "light" | "dark" = flags.theme === "dark" ? "dark" : "light";
const ROUNDS = Number(flags.rounds ?? "3");
/** How long after the release the frames are kept: the settle (180 ms) and well past it. */
const AFTER_MS = 600;

/** status-rows with 22 more projects: a sidebar taller than the window. */
const FIXTURE = "drops-long";
const writeFixture = () => {
  const f = JSON.parse(readFileSync(path.join(fixturesDir, "status-rows.json"), "utf8")) as {
    name: string;
    frames: Array<{ t: string; snapshot?: { projects: Array<Record<string, unknown>> } }>;
  };
  f.name = FIXTURE;
  const snap = f.frames.find((x) => x.t === "snapshot")?.snapshot;
  if (snap === undefined) throw new Error("status-rows has no snapshot");
  const base = snap.projects.find((p) => p["kind"] === undefined) ?? snap.projects[0];
  const names = ["atlas", "beacon", "cobalt", "delta", "ember", "falcon", "garnet", "harbor", "indigo", "juniper", "kepler", "lumen", "meridian", "nimbus", "onyx", "pioneer", "quartz", "raven", "sierra", "tundra", "umber", "vertex"];
  names.forEach((title, i) =>
    snap.projects.push({ ...base, projectId: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`, title, workspaceRoot: `/home/dev/src/${title}`, threads: { running: 0, waiting: 0, idle: 1, failed: 0 } }),
  );
  writeFileSync(path.join(fixturesDir, `${FIXTURE}.json`), JSON.stringify(f));
};

interface Row {
  readonly name: string;
  readonly top: number;
  readonly lifted: boolean;
}
interface Frame {
  readonly t: number;
  readonly rows: ReadonlyArray<Row>;
  /** The list's own top: a row's place in it is its top less this, the same however far the sidebar scrolled. */
  readonly list: number;
}

/** In the app's main process: the hub's sidebar_order_get / _set answered from an order it keeps. */
const stubHub = (app: Awaited<ReturnType<typeof launch>>["app"]) =>
  app.evaluate(({ ipcMain }) => {
    type Call = { tool: string; input: { order?: unknown[] } };
    type Handler = (e: Electron.IpcMainInvokeEvent, id: string, call: Call) => Promise<unknown>;
    const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, Handler> })._invokeHandlers;
    const real = handlers.get("hub:call");
    if (real === undefined) throw new Error("no hub:call handler");
    const g = globalThis as unknown as {
      drops: { order: unknown[]; getMs: number; setMs: number; echoMs: number; seq: number; send?: (frame: unknown) => void; move: (order: unknown[]) => void; echo: () => void; chat: () => void };
    };
    let said = 0;
    g.drops = {
      order: [],
      getMs: 30,
      setMs: 40,
      echoMs: 20,
      seq: 1_000_000,
      move(order) {
        g.drops.order = order;
        g.drops.echo();
      },
      // sidebar.order: the person's devices read the order again.
      echo() {
        g.drops.send?.({ t: "event", event: { seq: ++g.drops.seq, at: new Date().toISOString(), type: "sidebar.order", summary: "Sidebar order changed", data: {} } });
      },
      // A lead's reply in atlas: its row turns bold, the sidebar draws its rows again.
      chat() {
        const ref = { machineId: "devbox", projectId: "00000000-0000-4000-8000-000000000000" };
        said++;
        g.drops.send?.({
          t: "event",
          event: { seq: ++g.drops.seq, at: new Date().toISOString(), type: "chat.message", summary: "The lead replied", ...ref, data: { projectRef: ref, messageId: `m-drops-${String(said)}`, seq: 1000 + said, author: "lead", state: "final" } },
        });
      },
    };
    const wait = (ms: number) => new Promise((done) => setTimeout(done, ms));
    ipcMain.removeHandler("hub:call");
    ipcMain.handle("hub:call", async (e, id: string, call: Call) => {
      g.drops.send = (frame) => e.sender.send("hub:frame", id, frame);
      if (call.tool === "sidebar_order_get") {
        const order = g.drops.order;
        await wait(g.drops.getMs);
        return { ok: true, output: { order } };
      }
      if (call.tool === "sidebar_order_set") {
        await wait(g.drops.setMs);
        const order = call.input.order ?? [];
        g.drops.order = order;
        setTimeout(() => g.drops.echo(), g.drops.echoMs);
        return { ok: true, output: { order } };
      }
      return real(e, id, call);
    });
  }, undefined);

/** The Projects section's rows, by name, top to bottom as the DOM has them. */
const names = (page: Page) =>
  page.evaluate(() =>
    [...document.querySelectorAll("nav[aria-label='Sidebar'] section")]
      .filter((s) => s.textContent.startsWith("Projects"))
      .flatMap((s) => [...s.querySelectorAll<HTMLElement>("[data-reorder-row]")].map((r) => r.innerText.split("\n")[0]?.trim() ?? "")),
  );

/** Starts recording every row's top each animation frame, from before the press; the release's time goes in with the first pointerup. */
const record = (page: Page) =>
  page.evaluate(() => {
    const w = window as unknown as { frames: Frame[]; up: number; stop: boolean };
    w.frames = [];
    w.up = 0;
    w.stop = false;
    window.addEventListener("pointerup", () => (w.up = performance.now()), { capture: true, once: true });
    const tick = (t: number) => {
      const section = [...document.querySelectorAll("nav[aria-label='Sidebar'] section")].find((s) => s.textContent.startsWith("Projects"));
      const els = [...(section?.querySelectorAll<HTMLElement>("[data-reorder-row]") ?? [])];
      const rows = els.map((r) => ({ name: r.innerText.split("\n")[0]?.trim() ?? "", top: r.getBoundingClientRect().top, lifted: r.hasAttribute("data-lifted") }));
      w.frames.push({ t, rows, list: els[0]?.parentElement?.getBoundingClientRect().top ?? 0 });
      if (!w.stop) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });

const recorded = (page: Page) =>
  page.evaluate(() => {
    const w = window as unknown as { frames: Frame[]; up: number; stop: boolean };
    w.stop = true;
    return { frames: w.frames, up: w.up };
  });

/** The row named `name`'s middle on screen. */
const middle = async (page: Page, name: string) => {
  const box = await page.evaluate((n) => {
    const r = [...document.querySelectorAll<HTMLElement>("nav[aria-label='Sidebar'] [data-reorder-row]")].find((x) => x.innerText.split("\n")[0]?.trim() === n);
    r?.scrollIntoView({ block: "nearest" });
    const b = r?.getBoundingClientRect();
    return b === undefined ? undefined : { x: b.left + b.width / 2, y: b.top + b.height / 2 };
  }, name);
  if (box === undefined) throw new Error(`no row ${name}`);
  return box;
};

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

interface Drop {
  readonly name: string;
  /** Makes the drag, up to just before the release. */
  readonly drag: (page: Page) => Promise<unknown>;
  /** Hub timing for this drop. */
  readonly hub?: { getMs?: number; setMs?: number; echoMs?: number };
  /**
   * Something the hub sends this long after the release (before it, when negative): another desktop's move back to the
   * sidebar's own order, or a lead's reply that draws the rows again.
   */
  readonly during?: { readonly ms: number; readonly what: "move" | "chat" };
  /** How far the sidebar is scrolled before the press. */
  readonly scroll?: number;
}

const ROW = 28;
const glide = async (page: Page, from: { x: number; y: number }, dy: number, steps: number) => {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(from.x, from.y + (dy * i) / steps);
    await sleep(16);
  }
  return { x: from.x, y: from.y + dy };
};

const pick = async (page: Page, at: number) => (await names(page))[at] ?? "";

const DROPS: ReadonlyArray<Drop> = [
  { name: "short down", drag: async (p) => glide(p, await middle(p, await pick(p, 2)), ROW + 6, 6) },
  { name: "short up", drag: async (p) => glide(p, await middle(p, await pick(p, 4)), -(ROW + 6), 6) },
  { name: "long down", drag: async (p) => glide(p, await middle(p, await pick(p, 1)), 6 * ROW + 4, 20) },
  { name: "long up", drag: async (p) => glide(p, await middle(p, await pick(p, 9)), -(6 * ROW + 4), 20) },
  { name: "quick flick", drag: async (p) => glide(p, await middle(p, await pick(p, 3)), 3 * ROW, 2) },
  { name: "just past one", drag: async (p) => glide(p, await middle(p, await pick(p, 5)), ROW + 2, 4) },
  {
    name: "after autoscroll",
    drag: async (p) => {
      const at = await middle(p, await pick(p, 6));
      const bottom = await p.evaluate(() => document.querySelector("nav[aria-label='Sidebar'] > div")?.getBoundingClientRect().bottom ?? 0);
      const end = await glide(p, at, bottom - 6 - at.y, 24);
      await sleep(700);
      await p.mouse.move(end.x, end.y - 60, { steps: 4 });
      return { x: end.x, y: end.y - 60 };
    },
  },
  {
    name: "another desktop's move mid-glide",
    drag: async (p) => glide(p, await middle(p, await pick(p, 2)), 2 * ROW + 4, 8),
    hub: { setMs: 0, getMs: 0, echoMs: 150 },
    during: { ms: 60, what: "move" },
  },
  { name: "another desktop's move before the release", drag: async (p) => glide(p, await middle(p, await pick(p, 3)), -(2 * ROW + 4), 8), during: { ms: -50, what: "move" } },
  { name: "a reply mid-glide", drag: async (p) => glide(p, await middle(p, await pick(p, 1)), 3 * ROW + 4, 8), during: { ms: 50, what: "chat" } },
  // A real-length list scrolled part way, as a sidebar mostly is: the rows the drag never passes must not move at all.
  { name: "down past one, scrolled", scroll: 120, drag: async (p) => glide(p, await middle(p, await pick(p, 8)), ROW + 6, 6) },
  { name: "down past three, scrolled", scroll: 120, drag: async (p) => glide(p, await middle(p, await pick(p, 8)), 3 * ROW + 6, 10) },
  { name: "up past one, scrolled", scroll: 120, drag: async (p) => glide(p, await middle(p, await pick(p, 12)), -(ROW + 6), 6) },
  { name: "up past three, scrolled", scroll: 120, drag: async (p) => glide(p, await middle(p, await pick(p, 12)), -(3 * ROW + 6), 10) },
  {
    name: "down past three and back one, scrolled",
    scroll: 120,
    drag: async (p) => {
      const end = await glide(p, await middle(p, await pick(p, 8)), 3 * ROW + 6, 10);
      await p.mouse.move(end.x, end.y - ROW, { steps: 4 });
    },
  },
  { name: "down from the top", drag: async (p) => glide(p, await middle(p, await pick(p, 0)), 2 * ROW + 6, 8) },
  { name: "up from the bottom", scroll: 2000, drag: async (p) => glide(p, await middle(p, (await names(p)).at(-1) ?? ""), -(2 * ROW + 6), 8) },
  { name: "slow hub, late echo", drag: async (p) => glide(p, await middle(p, await pick(p, 4)), 2 * ROW + 4, 8), hub: { setMs: 250, getMs: 120, echoMs: 0 } },
  { name: "fast hub, instant echo", drag: async (p) => glide(p, await middle(p, await pick(p, 2)), 3 * ROW + 4, 8), hub: { setMs: 0, getMs: 0, echoMs: 0 } },
];

interface Verdict {
  readonly drop: string;
  readonly jumps: ReadonlyArray<string>;
  readonly frames: number;
}

/** How far along the glide's curve (--ease-out, cubic-bezier(0.22, 1, 0.36, 1)) a row is at `t`, 0 to 1 of its time. */
const eased = (t: number): number => {
  const at = (s: number, a: number, b: number) => 3 * (1 - s) ** 2 * s * a + 3 * (1 - s) * s * s * b + s ** 3;
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (at(mid, 0.22, 0.36) < t) lo = mid;
    else hi = mid;
  }
  return at(lo, 1, 1);
};
const GLIDE_MS = 180;

/**
 * Every row around the dragged one, from the press to the end, in its list (however far the sidebar scrolls). A row the
 * dragged row's middle never reached (above a row dragged down, below one dragged up, beyond the farthest it went)
 * stays exactly where it was. A row it reached slides at most one row, toward where the dragged row started: if the
 * drop leaves it on the other side, it goes one way only and ends one row over; if the drag gave it back (it went past
 * and came back, as after an autoscroll), it ends where it started. So a row passed by a row dragged down, which then
 * sits above it, never jumps up past its place (W219). A drag that never lifts, or lands where it started, has nothing
 * to show and fails.
 */
const around = (frames: ReadonlyArray<Frame>): string[] => {
  const lifted = frames.flatMap((f) => f.rows.filter((r) => r.lifted).map((r) => r.name))[0];
  const first = frames[0];
  const last = frames.at(-1);
  if (first === undefined || last === undefined) return ["no frames"];
  if (lifted === undefined) return ["no row lifted"];
  const was = first.rows.findIndex((r) => r.name === lifted);
  const now = last.rows.findIndex((r) => r.name === lifted);
  if (was < 0 || now < 0) return [`${lifted} isn't in the list`];
  if (was === now) return [`${lifted} landed where it started`];
  const size = Math.abs((first.rows[was + 1]?.top ?? first.rows[was - 1]?.top ?? 0) - (first.rows[was]?.top ?? 0));
  // How far the dragged row's middle went each way, in its list, while it was lifted.
  const middles = frames.flatMap((f) => f.rows.filter((r) => r.name === lifted && r.lifted).map((r) => r.top - f.list + size / 2));
  const lowest = Math.max(...middles);
  const highest = Math.min(...middles);
  const out: string[] = [];
  first.rows.forEach(({ name, top }, i) => {
    if (i === was) return;
    const at = top - first.list;
    const below = i > was;
    const reached = below ? lowest >= at + size / 2 - 0.5 : highest <= at + size / 2 + 0.5;
    const passed = i >= Math.min(was, now) && i <= Math.max(was, now);
    // Where it may be: its place, or for a row reached anywhere from there to one row toward the dragged row's start;
    // where it must end: one row over if the drop left it on the other side, else its place.
    const [lo, hi] = !reached ? [at, at] : below ? [at - size, at] : [at, at + size];
    const end = passed ? (below ? at - size : at + size) : at;
    const what = passed ? "passed" : reached ? "given back" : "never reached";
    let prev = at;
    for (const f of frames) {
      const there = f.rows.find((r) => r.name === name);
      if (there === undefined) continue;
      const y = there.top - f.list;
      const ms = Math.round(f.t - first.t);
      if (y < lo - 0.5 || y > hi + 0.5) out.push(`${name} (${what}) at ${(y - at).toFixed(1)} px from its place, ${String(ms)} ms from the press`);
      else if (passed && (below ? y > prev + 0.5 : y < prev - 0.5)) out.push(`${name} (passed) went back ${(y - prev).toFixed(1)} px, ${String(ms)} ms from the press`);
      else {
        prev = y;
        continue;
      }
      return;
    }
    const ended = last.rows.find((r) => r.name === name);
    if (ended !== undefined && Math.abs(ended.top - last.list - end) > 0.5) out.push(`${name} (${what}) ended ${(ended.top - last.list - at).toFixed(1)} px from its place, not ${(end - at).toFixed(1)}`);
  });
  return out;
};

/**
 * Every row's path from just before the release to well after it. A row may only glide: each frame it moves at most
 * as far as the glide's curve goes in that time at its start, where it is steepest (of the farthest the row goes in
 * all), and it turns back only where the order changed (the drop, or another desktop's move) a frame or two before.
 */
const judge = (drop: string, frames: ReadonlyArray<Frame>, up: number, moved: boolean): Verdict => {
  const at = frames.findIndex((f) => f.t >= up);
  const path = frames.slice(Math.max(0, at - 1));
  const jumps: string[] = [];
  if (path.length < 2) return { drop, jumps: ["no frames"], frames: 0 };
  const order = path.map((f) => f.rows.map((r) => r.name).join("\n"));
  for (const name of path[0]?.rows.map((r) => r.name) ?? []) {
    const tops = path.map((f) => f.rows.find((r) => r.name === name)?.top);
    const seen = tops.filter((t) => t !== undefined);
    const range = Math.max(...seen) - Math.min(...seen);
    let way = 0;
    for (let i = 1; i < path.length; i++) {
      const [a, b] = [tops[i - 1], tops[i]];
      const [fa, fb] = [path[i - 1], path[i]];
      if (a === undefined || b === undefined || fa === undefined || fb === undefined) continue;
      const step = b - a;
      const ms = Math.round(fb.t - up);
      const most = range * eased(Math.min(1, (fb.t - fa.t) / GLIDE_MS)) + 2;
      if (Math.abs(step) > most) jumps.push(`${name} moved ${step.toFixed(1)} px in one frame, at most ${most.toFixed(1)} (${String(ms)} ms)`);
      if (Math.abs(step) < 0.5) continue;
      const turned = way !== 0 && Math.sign(step) !== way;
      const reordered = order[i - 1] !== order[i] || (i > 1 && order[i - 2] !== order[i - 1]);
      if (turned && !reordered) jumps.push(`${name} turned back ${step.toFixed(1)} px (${String(ms)} ms)`);
      way = Math.sign(step);
    }
  }
  // Another desktop's move puts any row anywhere.
  return { drop, jumps: [...(moved ? [] : around(frames)), ...jumps], frames: path.length };
};

const screencast = async (cdp: CDPSession, dir: string | undefined) => {
  const shots: Array<{ ts: number; data: string }> = [];
  if (dir === undefined) return { stop: () => Promise.resolve(shots) };
  const on = (f: { data: string; sessionId: number; metadata: { timestamp?: number } }) => {
    shots.push({ ts: (f.metadata.timestamp ?? 0) * 1000, data: f.data });
    void cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId });
  };
  cdp.on("Page.screencastFrame", on);
  await cdp.send("Page.startScreencast", { format: "png", everyNthFrame: 1 });
  return {
    stop: async () => {
      await cdp.send("Page.stopScreencast");
      cdp.off("Page.screencastFrame", on);
      return shots;
    },
  };
};

const main = async () => {
  writeFixture();
  const launched = await launch(FIXTURE as FixtureName, undefined, { realClock: true });
  const { app, page } = launched;
  try {
    await app.evaluate(({ BrowserWindow, nativeTheme }, t) => {
      nativeTheme.themeSource = t;
      BrowserWindow.getAllWindows()[0]?.setContentSize(1100, 620);
    }, theme);
    await page.emulateMedia({ reducedMotion: "no-preference", colorScheme: theme });
    await stubHub(app);
    await page.locator("nav[aria-label='Sidebar'] [data-reorder-row]").nth(8).waitFor({ timeout: 30_000 });
    await sleep(1500);
    const cdp = await page.context().newCDPSession(page);
    const verdicts: Verdict[] = [];
    for (let round = 0; round < ROUNDS; round++) {
      for (const drop of DROPS.filter((d) => flags.only === undefined || d.name.includes(flags.only))) {
        await page.evaluate((top) => document.querySelector("nav[aria-label='Sidebar'] > div")?.scrollTo({ top }), drop.scroll ?? 0);
        await app.evaluate((_e, h) => {
          const g = globalThis as unknown as { drops: Record<string, number> };
          Object.assign(g.drops, { getMs: 30, setMs: 40, echoMs: 20 }, h);
        }, drop.hub ?? {});
        await sleep(300);
        await record(page);
        const cast = await screencast(cdp, round === 0 ? flags.strip : undefined);
        await drop.drag(page);
        await sleep(50);
        if (drop.during !== undefined) {
          await app.evaluate((_e, d) => {
            const g = globalThis as unknown as { drops: { move: (o: unknown[]) => void; chat: () => void } };
            setTimeout(() => (d.what === "move" ? g.drops.move([]) : g.drops.chat()), Math.max(0, d.ms));
          }, drop.during);
          if (drop.during.ms < 0) await sleep(-drop.during.ms);
        }
        await page.mouse.up();
        await sleep(AFTER_MS);
        const { frames, up } = await recorded(page);
        const shots = await cast.stop();
        const v = judge(drop.name, frames, up, drop.during?.what === "move");
        verdicts.push(v);
        console.log(`${v.jumps.length === 0 ? "smooth" : "JUMP  "}  ${drop.name} (${String(v.frames)} frames)${v.jumps.length === 0 ? "" : `\n          ${v.jumps.slice(0, 4).join("\n          ")}`}`);
        if (flags.strip !== undefined && shots.length > 0) {
          const dir = path.join(flags.strip, theme, drop.name.replaceAll(" ", "-"));
          mkdirSync(dir, { recursive: true });
          // The screencast's clock and the page's differ: frames are named from the first one, just before the press.
          const t0 = shots[0]?.ts ?? 0;
          for (const s of shots) writeFileSync(path.join(dir, `${String(Math.round(s.ts - t0)).padStart(4, "0")}.png`), Buffer.from(s.data, "base64"));
          writeFileSync(path.join(dir, "frames.json"), JSON.stringify({ up, frames }));
        }
      }
    }
    const bad = verdicts.filter((v) => v.jumps.length > 0);
    console.log(`\n${String(verdicts.length - bad.length)} of ${String(verdicts.length)} drops settled without a jump (${theme}).`);
    if (bad.length > 0) process.exitCode = 1;
  } finally {
    await launched.close();
  }
};

await main();

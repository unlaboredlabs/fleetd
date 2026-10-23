import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppLog } from "./applog";
import { FAILURES_IN_A_ROW, guardWindow, HANG_GRACE_MS, STABLE_MS, type GuardedWindow, type RecoveryDeps } from "./recovery";

const PAGE = "app://fleetd/index.html";

const dirs: string[] = [];

const setup = (answers: number[] = []) => {
  const dir = mkdtempSync(join(tmpdir(), "fleetd-recovery-"));
  dirs.push(dir);
  const page = Object.assign(new EventEmitter(), { forcefullyCrashRenderer: vi.fn() });
  const win = Object.assign(new EventEmitter(), { isDestroyed: () => false, webContents: page }) as unknown as GuardedWindow & EventEmitter;
  const loads: Array<string | null> = [];
  const ask = vi.fn(() => Promise.resolve(answers.shift() ?? 0));
  const copyDiagnostics = vi.fn();
  const quit = vi.fn();
  const deps: RecoveryDeps = {
    log: new AppLog(join(dir, "app.log"), { version: "1" }),
    load: (url) => loads.push(url),
    ask,
    copyDiagnostics,
    quit,
    quitting: () => false,
    isOwnPage: (url) => url.startsWith(PAGE),
  };
  guardWindow(win, deps);
  const crash = () => page.emit("render-process-gone", {}, { reason: "crashed", exitCode: 11 });
  return { page, win, ask, copyDiagnostics, quit, loads, crash, logText: () => readFileSync(join(dir, "app.log"), "utf8") };
};

const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

describe("a window whose page dies", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("reloads at the route it was on, and logs why", () => {
    const s = setup();
    s.page.emit("did-navigate", {}, `${PAGE}#/`);
    s.page.emit("did-navigate-in-page", {}, `${PAGE}#/project/devbox/p1`);
    s.page.emit("did-navigate-in-page", {}, "https://elsewhere.example/");
    s.crash();
    expect(s.loads).toEqual([`${PAGE}#/project/devbox/p1`]);
    expect(s.logText()).toMatch(/main v1 #\/project\/…: The window's page died \(crashed, exit code 11\); reloading it/u);
  });

  it(`asks instead of looping after ${String(FAILURES_IN_A_ROW)} failures in a row; Copy diagnostics asks again`, async () => {
    const s = setup([1, 0]);
    s.crash();
    s.page.emit("did-fail-load", {}, -6, "ERR_FILE_NOT_FOUND", PAGE, true);
    expect(s.loads).toHaveLength(2);
    s.crash();
    await flush();
    expect(s.copyDiagnostics).toHaveBeenCalledTimes(1);
    expect(s.ask).toHaveBeenCalledTimes(2);
    // Reload starts a new run: the next failure reloads again without asking.
    expect(s.loads).toHaveLength(3);
    s.crash();
    expect(s.loads).toHaveLength(4);
    expect(s.ask).toHaveBeenCalledTimes(2);
  });

  it("quits when asked to", async () => {
    const s = setup([2]);
    for (let i = 0; i < FAILURES_IN_A_ROW; i++) s.crash();
    await flush();
    expect(s.quit).toHaveBeenCalled();
  });

  it("counts failures only in a row: a page that stayed up starts over", () => {
    const s = setup();
    s.crash();
    s.crash();
    s.page.emit("did-finish-load");
    vi.advanceTimersByTime(STABLE_MS);
    s.crash();
    s.crash();
    expect(s.ask).not.toHaveBeenCalled();
    expect(s.loads).toHaveLength(4);
  });

  it("ignores a clean exit, an aborted navigation and a subframe", () => {
    const s = setup();
    s.page.emit("render-process-gone", {}, { reason: "clean-exit", exitCode: 0 });
    s.page.emit("did-fail-load", {}, -3, "ERR_ABORTED", PAGE, true);
    s.page.emit("did-fail-load", {}, -6, "ERR_FILE_NOT_FOUND", PAGE, false);
    expect(s.loads).toEqual([]);
  });

  it("gives a hung page a moment, then crashes its renderer (which reloads it)", () => {
    const s = setup();
    s.win.emit("unresponsive");
    s.win.emit("responsive");
    vi.advanceTimersByTime(HANG_GRACE_MS);
    expect(s.page.forcefullyCrashRenderer).not.toHaveBeenCalled();
    s.win.emit("unresponsive");
    vi.advanceTimersByTime(HANG_GRACE_MS);
    expect(s.page.forcefullyCrashRenderer).toHaveBeenCalledTimes(1);
  });
});

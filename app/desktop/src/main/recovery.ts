// A window whose page dies (the renderer crashed or was killed, hung, or the page failed to load) is reloaded at the
// route it was on, so a crash costs a reload rather than a blank window. After FAILURES_IN_A_ROW without a page that
// stayed up in between, it stops looping and asks: Reload, Copy diagnostics or Quit.
import type { AppLog } from "./applog";

export const FAILURES_IN_A_ROW = 3;
/** A page that stays up this long after loading ends the run of failures. */
export const STABLE_MS = 60_000;
/** An unresponsive page gets this long to answer again before its renderer is crashed and the page reloaded. */
export const HANG_GRACE_MS = 5_000;

/** The slice of BrowserWindow (and its webContents) this needs; a fake in tests. */
export interface GuardedWindow {
  isDestroyed(): boolean;
  on(event: "unresponsive" | "responsive", listener: () => void): unknown;
  readonly webContents: {
    on(event: "render-process-gone", listener: (event: unknown, details: { reason: string; exitCode: number }) => void): unknown;
    on(event: "did-fail-load", listener: (event: unknown, code: number, description: string, url: string, isMainFrame: boolean) => void): unknown;
    on(event: "did-finish-load", listener: () => void): unknown;
    on(event: "did-navigate" | "did-navigate-in-page", listener: (event: unknown, url: string) => void): unknown;
    forcefullyCrashRenderer(): void;
  };
}

export interface RecoveryDeps {
  readonly log: AppLog;
  /** Loads `url` (the last route, or the start page when null) into the window. */
  load(url: string | null): void;
  /** The native dialog; resolves to the button index: 0 Reload, 1 Copy diagnostics, 2 Quit. */
  ask(): Promise<number>;
  copyDiagnostics(): void;
  quit(): void;
  /** True once the app is quitting: windows closing then aren't failures. */
  quitting(): boolean;
  isOwnPage(url: string): boolean;
}

/** net::ERR_ABORTED: a navigation replaced by another, not a failure. */
const ABORTED = -3;

export const guardWindow = (win: GuardedWindow, deps: RecoveryDeps): void => {
  const page = win.webContents;
  let failures = 0;
  let asking = false;
  let lastUrl: string | null = null;
  let stable: ReturnType<typeof setTimeout> | undefined;
  let hang: ReturnType<typeof setTimeout> | undefined;

  const remember = (_event: unknown, url: string) => {
    if (deps.isOwnPage(url)) lastUrl = url;
  };
  page.on("did-navigate", remember);
  page.on("did-navigate-in-page", remember);
  page.on("did-finish-load", () => {
    clearTimeout(stable);
    stable = setTimeout(() => {
      failures = 0;
    }, STABLE_MS);
  });

  const failed = async (what: string): Promise<void> => {
    if (win.isDestroyed() || deps.quitting()) return;
    deps.log.write({ source: "main", what, ...(lastUrl === null ? {} : { route: new URL(lastUrl).hash }) });
    clearTimeout(stable);
    failures += 1;
    if (failures < FAILURES_IN_A_ROW) {
      deps.load(lastUrl);
      return;
    }
    if (asking) return;
    asking = true;
    for (;;) {
      const choice = await deps.ask();
      if (win.isDestroyed()) return;
      if (choice === 1) {
        deps.copyDiagnostics();
        continue;
      }
      asking = false;
      if (choice === 2) {
        deps.quit();
        return;
      }
      failures = 0;
      deps.load(lastUrl);
      return;
    }
  };

  page.on("render-process-gone", (_event, details) => {
    if (details.reason === "clean-exit") return;
    void failed(`The window's page died (${details.reason}, exit code ${String(details.exitCode)}); reloading it`);
  });
  page.on("did-fail-load", (_event, code, description, _url, isMainFrame) => {
    if (!isMainFrame || code === ABORTED) return;
    void failed(`The window's page didn't load (${description}, ${String(code)}); reloading it`);
  });
  win.on("unresponsive", () => {
    deps.log.write({ source: "main", what: "The window's page stopped responding" });
    hang ??= setTimeout(() => {
      hang = undefined;
      // render-process-gone follows, which reloads.
      if (!win.isDestroyed()) page.forcefullyCrashRenderer();
    }, HANG_GRACE_MS);
  });
  win.on("responsive", () => {
    clearTimeout(hang);
    hang = undefined;
  });
};

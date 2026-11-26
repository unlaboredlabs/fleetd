// The app's errors for the person's own workspace (`app_error_report`), which keeps each in its log: what failed, on
// which screen and build, folded or not, and the stack, so the next crash says where it happened without anyone
// sending Apple's report. Never what the person sees or types: a message keeps its first words, and anything quoted in
// it (where a value can end up, "Unexpected token in 'some text'") is dropped. Each is kept on the phone the moment it
// happens, before it is sent, so one the app ends on (a fatal) goes when it next starts. Pure, so tested
// (appErrors.test.ts); appErrorsDevice.ts gives it the phone's file, build and handler.
import type { AppErrorReport, HubError } from "./desktop";
import { splitOf } from "./split";

/** How many reports wait on the phone at most: the newest. */
export const PENDING_MAX = 20;
export const MESSAGE_MAX = 300;
/** The schema's; the JavaScript's own stack comes first. */
export const STACK_MAX = 8000;

/**
 * Quoted words longer than a name: what an error's message or stack can carry of a value. A property's or a
 * variable's name ("Cannot read property 'title' of undefined") is shorter, and is what says where it failed.
 */
const QUOTED = /(["'`“‘])[^\n"'`“”‘’]{25,}(["'`”’])/gu;

/** `text` with anything quoted in it longer than a name left out. */
export const scrub = (text: string): string => text.replace(QUOTED, "$1…$2");

/** A stack frame's file by its name alone: on a phone its path is the app's install folder, long and the same each time. */
export const shortPaths = (stack: string): string => stack.replace(/(?:\/[^\s/():]+)+\/([^\s/():]+:\d+(?::\d+)?)/gu, "$1");

const cut = (text: string, max: number): string => (text.length <= max ? text : `${text.slice(0, max - 1)}…`);

/** What the phone is and runs, which every report carries. */
export interface Build {
  readonly platform: AppErrorReport["platform"];
  readonly build: string;
  readonly update?: string | undefined;
  readonly os?: string | undefined;
  readonly device?: string | undefined;
}

export interface Where {
  readonly fatal: boolean;
  readonly screen?: string | undefined;
  /** React's, for an error a screen's drawing threw. */
  readonly componentStack?: string | null | undefined;
  readonly window: { readonly width: number; readonly height: number };
}

/** The report of `error` (anything thrown), where it happened, on `build`, at `nowMs`. */
export const reportOf = (error: unknown, where: Where, build: Build, nowMs: number): AppErrorReport => {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : typeof error === "string" ? error : "A value that isn't an Error was thrown";
  const stack = [error instanceof Error ? (error.stack ?? "") : "", where.componentStack ?? ""].filter((s) => s.trim() !== "").join("\n");
  const width = Math.round(where.window.width);
  const height = Math.round(where.window.height);
  return {
    at: new Date(nowMs).toISOString(),
    build: cut(build.build, 32),
    fatal: where.fatal,
    message: cut(scrub(message.replace(/\s+/gu, " ").trim()), MESSAGE_MAX) || "Error",
    platform: build.platform,
    stack: cut(scrub(shortPaths(stack)), STACK_MAX),
    wide: splitOf(width) !== undefined,
    window: `${String(width)}x${String(height)}`,
    ...(where.screen === undefined ? {} : { screen: cut(where.screen, 80) }),
    ...(build.update === undefined ? {} : { update: cut(build.update, 64) }),
    ...(build.os === undefined ? {} : { os: cut(build.os, 32) }),
    ...(build.device === undefined ? {} : { device: cut(build.device, 64) }),
  };
};

/** `pending` with `report` after it, the oldest gone past PENDING_MAX. */
export const queued = (pending: readonly AppErrorReport[], report: AppErrorReport): AppErrorReport[] => [...pending, report].slice(-PENDING_MAX);

/** What the phone kept, as read back: anything that isn't a list of reports is none. */
export const parsePending = (raw: unknown): AppErrorReport[] =>
  Array.isArray(raw) ? raw.filter((r): r is AppErrorReport => typeof r === "object" && r !== null && typeof (r as AppErrorReport).message === "string").slice(-PENDING_MAX) : [];

/** A fatal error this long after the app started restarts its JavaScript rather than end the app. */
export const RECOVER_AFTER_MS = 10_000;
/** At most one such restart in this long: a second fatal soon after ends the app, so a broken start can't loop. */
export const RECOVER_GAP_MS = 5 * 60_000;

/**
 * Whether a fatal error at `nowMs` restarts the app's JavaScript (expo-updates' reload, a moment's blank) rather than
 * end the app: not in its first seconds, where the same error would come back at once, and not twice in RECOVER_GAP_MS.
 */
export const recovers = (startedMs: number, lastReloadMs: number | null, nowMs: number): boolean =>
  nowMs - startedMs >= RECOVER_AFTER_MS && (lastReloadMs === null || nowMs - lastReloadMs >= RECOVER_GAP_MS || lastReloadMs > nowMs);

/** Whether a send that failed with `error` may go again later: the link, not the workspace, was the trouble. */
export const sendAgain = (error: Pick<HubError, "code">): boolean => error.code === "offline" || error.code === "timeout" || error.code === "disconnected";

export interface KeeperDeps {
  readonly load: () => unknown;
  /** Written before it returns: a fatal's report must be on disk before the app ends. */
  readonly save: (pending: readonly AppErrorReport[]) => void;
  readonly build: () => Build;
  readonly window: () => { readonly width: number; readonly height: number };
  readonly now: () => number;
}

/** Sends reports to the workspace: true once it took them (or can't ever), false to keep them for the next link. */
export type Send = (errors: readonly AppErrorReport[]) => Promise<boolean>;

export interface Keeper {
  /** Keeps `error`'s report, then sends what waits unless it was fatal (the app is ending; it goes at the next start). */
  readonly note: (error: unknown, where: Omit<Where, "window">) => void;
  /** Where the person is now: the screen a report says when nothing else names one. */
  readonly at: (screen: string | undefined) => void;
  /** The workspace to send to, or none (unpaired); what waits goes at once. */
  readonly sendTo: (send: Send | null) => void;
  /** Sends what waits, if there is a workspace to send to and nothing is on its way. */
  readonly flush: () => Promise<void>;
  /** The screen it would say now. */
  readonly screen: () => string | undefined;
}

export const keeper = (deps: KeeperDeps): Keeper => {
  let send: Send | null = null;
  let screen: string | undefined;
  let sending = false;
  const pending = (): AppErrorReport[] => {
    try {
      return parsePending(deps.load());
    } catch {
      return [];
    }
  };
  const save = (list: readonly AppErrorReport[]) => {
    try {
      deps.save(list);
    } catch {
      // Nowhere to keep it: it goes with this run's next send, or not at all.
    }
  };
  const flush = async (): Promise<void> => {
    const to = send;
    if (to === null || sending) return;
    const out = pending();
    if (out.length === 0) return;
    sending = true;
    let left = 0;
    try {
      if (!(await to(out))) return;
      // What came in while these were on their way goes next.
      const ids = new Set(out.map((r) => `${r.at} ${r.message}`));
      const rest = pending().filter((r) => !ids.has(`${r.at} ${r.message}`));
      save(rest);
      left = rest.length;
    } catch {
      // Kept for the next link.
    } finally {
      sending = false;
    }
    if (left > 0) await flush();
  };
  return {
    note: (error, where) => {
      const report = reportOf(error, { ...where, screen: where.screen ?? screen, window: deps.window() }, deps.build(), deps.now());
      save(queued(pending(), report));
      if (!where.fatal) void flush();
    },
    at: (s) => {
      screen = s;
    },
    sendTo: (s) => {
      send = s;
      void flush();
    },
    flush,
    screen: () => screen,
  };
};

// App presence (Settings › General, on by default). Once a minute while a window is focused, main tells the hub
// three facts: the app is focused, which project is on screen, and whether there was input in the last minute. The
// hub counts such minutes toward the person's minutes per merged PR, and keeps them to itself. The input check is the
// OS's idle time, so no key or click is ever read, and nothing on screen is sent. Turned off, nothing is sent at all.
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import type { ChatScope } from "../shared/ipc";

export const PRESENCE_EVERY_MS = 60_000;
/** Input this recent means the person is there. */
export const INPUT_WITHIN_S = 60;

export interface PresenceFrame {
  readonly focused: boolean;
  readonly input: boolean;
  readonly project?: ChatScope;
}

/** The switch, in a file of its own so main knows it before any window loads. On unless it was turned off. */
export class PresenceSetting {
  readonly #file: string;
  #on: boolean;

  constructor(file: string) {
    this.#file = file;
    this.#on = PresenceSetting.#read(file);
  }

  get on(): boolean {
    return this.#on;
  }

  /** Turns it on or off for this run, and saves it when it can; what's on now either way. */
  set(on: boolean): boolean {
    this.#on = on;
    try {
      const tmp = `${this.#file}.tmp`;
      writeFileSync(tmp, JSON.stringify({ on }));
      renameSync(tmp, this.#file);
    } catch {
      // Not saved: it is still as asked until the app quits.
    }
    return this.#on;
  }

  static #read(file: string): boolean {
    try {
      const saved: unknown = JSON.parse(readFileSync(file, "utf8"));
      return !(typeof saved === "object" && saved !== null && "on" in saved && saved.on === false);
    } catch {
      return true;
    }
  }
}

export interface PresenceDeps {
  readonly on: () => boolean;
  /** A window of this app has the focus. */
  readonly focused: () => boolean;
  /** The OS saw input in the last `seconds` (Electron's `powerMonitor.getSystemIdleState`). */
  readonly active: (seconds: number) => boolean;
  /** The project whose screen is showing. */
  readonly project: () => ChatScope | null;
  readonly send: (frame: PresenceFrame) => void;
}

/** This minute's frame: none while presence is off or no window is focused. */
export const presenceFrame = (deps: PresenceDeps): PresenceFrame | null => {
  if (!deps.on() || !deps.focused()) return null;
  const project = deps.project();
  const input = deps.active(INPUT_WITHIN_S);
  return project === null
    ? { focused: true, input }
    : { focused: true, input, project: { machineId: project.machineId, projectId: project.projectId } };
};

/** Sends each minute's frame; returns the stop. */
export const startPresence = (deps: PresenceDeps, everyMs = PRESENCE_EVERY_MS): (() => void) => {
  const timer = setInterval(() => {
    const frame = presenceFrame(deps);
    if (frame !== null) deps.send(frame);
  }, everyMs);
  return () => clearInterval(timer);
};

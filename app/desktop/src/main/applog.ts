// The app's own log: errors from main and the window, in the OS log directory (macOS ~/Library/Logs/fleetd/app.log,
// Linux $XDG_STATE_HOME/fleetd/app.log). Each entry is an error's message and stack, the app version and the route,
// scrubbed (shared/scrub.ts): never secrets, keys, message bodies or pasted text. It rotates past LOG_MAX_BYTES, keeping
// one previous file, so it never grows past twice that.
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync } from "node:fs";
import { dirname } from "node:path";
import type { HubState } from "../shared/hub";
import { errorText, routeShape, scrub } from "../shared/scrub";

export const LOG_MAX_BYTES = 1_000_000;
/** The window's errors logged per minute at most: a part that throws on every frame must not churn the disk. */
const RENDERER_PER_MINUTE = 20;

export interface LogEntry {
  readonly source: "main" | "window";
  /** What failed, in a few words: "the chat", "render-process-gone", "uncaught exception". */
  readonly what: string;
  readonly error?: { readonly message: string; readonly stack?: string | undefined; readonly name?: string | undefined } | undefined;
  /** The window's hash route, when known; written without its query or ids. */
  readonly route?: string | undefined;
}

export class AppLog {
  readonly file: string;
  readonly #version: string;
  readonly #home: string | undefined;
  readonly #maxBytes: number;
  readonly #now: () => number;
  #window = { minute: 0, count: 0 };

  constructor(file: string, opts: { version: string; home?: string; maxBytes?: number; now?: () => number }) {
    this.file = file;
    this.#version = opts.version;
    this.#home = opts.home;
    this.#maxBytes = opts.maxBytes ?? LOG_MAX_BYTES;
    this.#now = opts.now ?? Date.now;
  }

  /** Appends an entry; false when it was dropped (over the window's rate) or couldn't be written. Never throws. */
  write(entry: LogEntry): boolean {
    const now = this.#now();
    if (entry.source === "window") {
      const minute = Math.floor(now / 60_000);
      if (minute !== this.#window.minute) this.#window = { minute, count: 0 };
      if (++this.#window.count > RENDERER_PER_MINUTE) return false;
    }
    const route = entry.route === undefined ? "" : ` ${routeShape(entry.route)}`;
    const head = `${new Date(now).toISOString()} ${entry.source} v${this.#version}${route}: ${scrub(entry.what, this.#home)}`;
    const body = entry.error === undefined ? "" : `\n${errorText(entry.error, this.#home).replace(/^/gmu, "  ")}`;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      if (existsSync(this.file) && statSync(this.file).size >= this.#maxBytes) renameSync(this.file, `${this.file}.1`);
      appendFileSync(this.file, `${head}${body}\n`, { mode: 0o600 });
      return true;
    } catch {
      return false;
    }
  }

  /** The file as a person would read it: the home directory as `~`. */
  get where(): string {
    return scrub(this.file, this.#home);
  }

  /** The last `n` lines, from the previous file too when the current one is short. */
  tail(n: number): string[] {
    const lines = (file: string): string[] => {
      try {
        return readFileSync(file, "utf8").split("\n").filter((l) => l !== "");
      } catch {
        return [];
      }
    };
    const current = lines(this.file);
    return (current.length >= n ? current : [...lines(`${this.file}.1`), ...current]).slice(-n);
  }
}

/** How many log lines Copy Diagnostics carries. */
export const DIAGNOSTIC_LINES = 50;

const connection = (hub: HubState): string => {
  switch (hub.phase) {
    case "live":
      return `live (protocol ${String(hub.protocol)})`;
    case "connecting":
      return `connecting (attempt ${String(hub.attempt)})`;
    case "retrying":
      return "lost, retrying";
    case "refused":
      return "the hub refused the key";
    case "unpaired":
      return "not paired";
  }
};

/**
 * Help → Copy Diagnostics: the version, the OS, the hub connection (its state, never its address or key) and the
 * log's last lines, for a bug report.
 */
export const diagnostics = (d: {
  readonly version: string;
  readonly versions: { readonly electron: string; readonly chrome: string };
  readonly os: string;
  /** Each hub's connection, in sidebar order; numbered when there are several (labels are the person's own words). */
  readonly hubs: ReadonlyArray<HubState>;
  readonly log: AppLog;
}): string =>
  [
    `fleetd ${d.version} (Electron ${d.versions.electron}, Chromium ${d.versions.chrome})`,
    `OS: ${d.os}`,
    ...(d.hubs.length === 1 ? [`Hub: ${connection(d.hubs[0] ?? { phase: "unpaired" })}`] : d.hubs.map((h, i) => `Hub ${String(i + 1)}: ${connection(h)}`)),
    `Log: ${d.log.where}`,
    "",
    `The log's last ${String(DIAGNOSTIC_LINES)} lines:`,
    ...d.log.tail(DIAGNOSTIC_LINES),
  ].join("\n");

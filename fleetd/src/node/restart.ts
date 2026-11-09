// The node's restart to apply its screen settings (crates/fleetd/src/node/screens.rs `schedule`, `when_idle`): the
// screens read node.json once, as the node starts, so after `node_action` `screens` changed it (src/node/screens'
// `apply`) the node restarts itself once no screen is live here, holding its agents' tool calls first, as an update's
// restart does, so it finds them between steps. The node then stops as for SIGTERM, and its service manager starts it.
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { installedExe, replaceFile } from "../update/index.ts";
import { isHubService, services } from "../update/service.ts";

const LOOK_MS = 10_000;
const DRAIN_LOOK_MS = 2_000;
const DRAIN_MAX_MS = 600_000;
/** How long a restart waits for a change's answer to reach the link, at most. */
const ANSWER_WAIT_MS = 60_000;
const HOLD_LEASE_MS = 60_000;

/** The screen sections of node.json, as the services running now read them. */
export function sections(home: string): string {
  try {
    const json = JSON.parse(readFileSync(join(home, "node.json"), "utf8")) as Record<string, unknown>;
    return JSON.stringify(["browser", "device", "ios", "desktop", "mac", "screenIdleMinutes"].map((k) => json[k] ?? null));
  } catch {
    return "";
  }
}

const holdPath = (home: string) => join(home, "update", "hold");
const screensMark = (home: string) => join(home, "update", "hold.screens");
const updateMark = (home: string) => join(home, "update", "hold.update");
const until = (path: string) => {
  try {
    return Number(readFileSync(path, "utf8").trim()) || undefined;
  } catch {
    return undefined;
  }
};

/** Holds the agents for a screens restart (hold.rs `hold_for_screens`), noted as its own. */
export function holdForScreens(home: string): void {
  mkdirSync(join(home, "update", "held"), { recursive: true });
  const at = String(Date.now() + HOLD_LEASE_MS);
  replaceFile(holdPath(home), at);
  replaceFile(screensMark(home), at);
}

/** Ends a screens restart's hold, unless an update holds too (hold.rs `release_screens`). */
export function releaseScreens(home: string): void {
  const ours = until(screensMark(home)) !== undefined;
  rmSync(screensMark(home), { force: true });
  const updating = (until(updateMark(home)) ?? 0) > Date.now();
  if (ours && !updating) for (const f of ["hold", "hold.update", "held"]) rmSync(join(home, "update", f), { recursive: true, force: true });
}

export type Restarter = {
  /** Screens live here now. */
  live: () => number;
  /** Holds the agents (renewing the hold) and answers how many are still mid-step. */
  hold: () => number;
  /** Stops the node, for its service manager to start it again. */
  restart: () => void;
  /** Whether the node runs as the service `fleetd machine add` sets up (default: a node service names its binary). */
  asService?: () => boolean;
  pace?: { lookMs: number; drainLookMs: number; drainMaxMs: number; answerMs: number };
};

export class ScreensRestart {
  readonly #started: string;
  #watching = false;
  #pending = new Set<number>();
  #next = 0;
  constructor(
    readonly home: string,
    readonly r: Restarter,
  ) {
    this.#started = sections(home);
  }

  #differs(): boolean {
    return sections(this.home) !== this.#started;
  }

  /** A change is asked for: its answer is pending until the returned function says it is on the link. */
  ask(): () => void {
    const n = ++this.#next;
    this.#pending.add(n);
    return () => this.#pending.delete(n);
  }

  /** After node.json changed: the answer to give, and the restart scheduled once no screen is live here. */
  schedule(): string {
    if (!this.#differs()) return "Saved.";
    const asService =
      this.r.asService ??
      (() => {
        try {
          return services(installedExe()).some((s) => !isHubService(s));
        } catch {
          return false;
        }
      });
    if (!asService()) return "Saved in node.json. This node doesn't run as the service fleetd sets up, so restart it to apply the change.";
    const n = this.r.live();
    if (!this.#watching) {
      this.#watching = true;
      void this.#whenIdle().then((restart) => {
        this.#watching = false;
        if (restart) {
          console.log(`${new Date().toISOString()} INFO screen settings changed: restarting the node to apply them`);
          this.r.restart();
        }
      });
    }
    return n === 0
      ? "Saved. The node restarts to apply it once its agents finish the step they're on."
      : n === 1
        ? "Saved. It applies once the screen live here ends, when the node restarts."
        : `Saved. It applies once the ${n} screens live here end, when the node restarts.`;
  }

  /** Waits until the node may restart: no screen live, then its agents held between steps with still none live. False
   * once nothing differs any more. */
  async #whenIdle(): Promise<boolean> {
    const pace = this.r.pace ?? { lookMs: LOOK_MS, drainLookMs: DRAIN_LOOK_MS, drainMaxMs: DRAIN_MAX_MS, answerMs: ANSWER_WAIT_MS };
    // Its answer goes out first.
    const answered = Date.now();
    while (this.#pending.size && Date.now() - answered < pace.answerMs) await Bun.sleep(Math.min(pace.drainLookMs, 200));
    for (;;) {
      if (!this.#differs()) return false;
      if (this.r.live() === 0) {
        const drained = Date.now();
        while (this.r.hold() > 0 && Date.now() - drained < pace.drainMaxMs) await Bun.sleep(pace.drainLookMs);
        if (!this.#differs()) {
          releaseScreens(this.home);
          return false;
        }
        // A change asked for meanwhile: its answer goes out before the node does, the hold renewed while it waits.
        const waited = Date.now();
        while (this.#pending.size && Date.now() - waited < pace.answerMs) {
          this.r.hold();
          await Bun.sleep(pace.drainLookMs);
        }
        if (this.r.live() === 0) return true;
        // A screen opened while the agents finished their step: it isn't cut off, and they carry on.
        releaseScreens(this.home);
      }
      await Bun.sleep(pace.lookMs);
    }
  }
}

export const holdExists = (home: string) => existsSync(holdPath(home));

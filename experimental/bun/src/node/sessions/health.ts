// What the node says about its runner (`runner_info`), crates/fleetd/src/node/sessions/health.rs: the last zero-cost
// probe, corrected by what real runs showed since.
//
// A run that fails Auth marks the login logged out at once, so the hub shows the `claude auth login` fix without
// waiting for a probe. Any later probe that reports logged in clears the mark. That includes a login in the macOS
// keychain, which changes no file the node could watch, and the probe makes no model call. A probe that started before
// the failure says nothing about it. A usable runner is probed once, at start. While it is unusable the node re-probes
// every RECHECK_AFTER_MS and pushes each change, so the hub's cached state, and with it its launch gate, flips back
// within seconds of the fix.
import type { RunnerInfo } from "./types.ts";

/** How often a runner that can't run sessions is re-probed. */
export const RECHECK_AFTER_MS = 15_000;

/** What a person runs to log claude in again (failure.rs `login_fix`). */
export const loginFix = (proxy: boolean) => (proxy ? "log in with your proxy as you normally do" : "claude auth login");

export class Health {
  #probed: { info: RunnerInfo; at: number } | undefined;
  #authFailed: { at: number; message: string } | undefined;

  /** What `runner_info` reports; undefined before the first probe ends. */
  info(): RunnerInfo | undefined {
    if (!this.#probed) return undefined;
    const info = { ...this.#probed.info };
    if (this.#authFailed) {
      info.login = "logged_out";
      const fix = loginFix(info.proxy !== undefined);
      const refused = `claude refused its login: ${this.#authFailed.message.replace(/\.+$/, "")}. Fix: ${fix}`;
      info.problem = info.problem && !info.problem.includes(fix) ? `${refused} ${info.problem}` : refused;
    }
    return info;
  }

  /** How long until the next probe: 0 before the first, then RECHECK_AFTER_MS after the last one while the runner is
   * unusable. Undefined while it is usable: a `runner_info` call answers from the last probe. */
  nextProbeIn(now: number): number | undefined {
    if (!this.#probed) return 0;
    const info = this.info();
    const usable = info?.login === "logged_in" && info.conformanceOk !== false;
    return usable ? undefined : Math.max(0, RECHECK_AFTER_MS - Math.max(0, now - this.#probed.at));
  }

  /** Records a probe that started at `started`. */
  probed(info: RunnerInfo, started: number): void {
    if (info.login === "logged_in" && this.#authFailed && started >= this.#authFailed.at) this.#authFailed = undefined;
    this.#probed = { info, at: started };
  }

  /** A run failed Auth with `message`. */
  authFailed(message: string, now: number): void {
    this.#authFailed = { at: now, message: message.split("\n")[0] ?? message };
  }

  /** A run completed, so the login works. */
  runCompleted(): void {
    this.#authFailed = undefined;
  }
}

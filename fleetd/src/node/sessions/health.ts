// What the node says about its runner (`runner_info`), crates/fleetd/src/node/sessions/health.rs: the last zero-cost
// probe, corrected by what real runs showed since.
//
// A run that fails Auth marks the login logged out at once, so the hub shows the fix without waiting for a probe: the
// file the key comes from (`claude.env`), else `claude auth login`. The probe makes no model call, so it can't tell a
// refused key from a good one: it reports the same "logged in" 0.4 s after Claude refused it (the Nov 26 sweep's
// machine showed Idle with a bad key). So only a run that completes clears the mark, or a probe of a login that changed
// since the refusal (its `key`: the login's variables, its credentials file, its keychain entry, the account the
// workspace sealed to the node). The node also tries the login itself on the endpoint's free model list, a minute after
// the refusal and then every few minutes, and clears the mark when that passes (`runCompleted`): a refusal that was a
// blip on Claude's side heals by itself. A probe that started before the failure says nothing about it. A usable runner is probed once, at start. While it is unusable the node re-probes
// every RECHECK_AFTER_MS and pushes each change, so the hub's cached state, and with it its launch gate, flips back
// within seconds of the fix.
import type { RunnerInfo } from "./types.ts";

/** How often a runner that can't run sessions is re-probed. */
export const RECHECK_AFTER_MS = 15_000;

/** What a person does to log claude in again (failure.rs `login_fix`): with `file`, where the key it ran on is set. */
export const loginFix = (proxy: boolean, file?: string) =>
  file !== undefined ? `replace the key in ${file}` : proxy ? "log in with your proxy as you normally do" : "claude auth login";

export class Health {
  #probed: { info: RunnerInfo; at: number; key?: string } | undefined;
  #authFailed: { at: number; message: string; key?: string } | undefined;

  /** What `runner_info` reports; undefined before the first probe ends. */
  info(): RunnerInfo | undefined {
    if (!this.#probed) return undefined;
    const info = { ...this.#probed.info };
    if (this.#authFailed) {
      info.login = "logged_out";
      const fix = loginFix(info.proxy !== undefined, info.loginFile);
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

  /** Records a probe that started at `started`, of the login `key` names. */
  probed(info: RunnerInfo, started: number, key?: string): void {
    const failed = this.#authFailed;
    if (info.login === "logged_in" && failed && started >= failed.at && (failed.key === undefined || key !== failed.key)) this.#authFailed = undefined;
    this.#probed = { info, at: started, ...(key === undefined ? {} : { key }) };
  }

  /** A run failed Auth with `message`, on the login `key` names. */
  authFailed(message: string, now: number, key?: string): void {
    this.#authFailed = { at: now, message: message.split("\n")[0] ?? message, ...(key === undefined ? {} : { key }) };
  }

  /** Whether a run's refusal of the login stands. */
  refused(): boolean {
    return this.#authFailed !== undefined;
  }

  /** A run completed, or the login passed the node's own check: the login works. */
  runCompleted(): void {
    this.#authFailed = undefined;
  }
}

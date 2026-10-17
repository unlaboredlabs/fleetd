// `node_action` frames from the hub's doctor: re-mint the hub's T3 session, restart T3 with the configured command,
// or probe the commit identity and free disk space. Each always answers, in plain words.
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import type { NodeAction, NodeActionResult } from "@fleetd/contracts";
import { Duration, Effect } from "effect";
import type { T3RestartFailed } from "./T3Supervisor.ts";
import { scrubbedEnv } from "./T3Sessions.ts";

export type ActionOutcome = Omit<NodeActionResult, "t" | "id">;

export interface NodeActionDeps {
  /** Returns once a fresh session has been sent to the hub. */
  readonly remint: Effect.Effect<void>;
  /** Absent: this node has no T3 restart command. */
  readonly restart?: Effect.Effect<void, T3RestartFailed>;
  readonly probe: Effect.Effect<NonNullable<ActionOutcome["probe"]>>;
}

const REMINT_WAIT = Duration.seconds(30);

/** `git config --global user.email`, absent when unset or git is missing. */
const gitConfigEmail = Effect.callback<string | undefined>((resume, signal) => {
  execFile("git", ["config", "--global", "user.email"], { env: scrubbedEnv(), signal, timeout: 10_000 }, (error, stdout) => {
    const email = String(stdout).trim();
    resume(Effect.succeed(error === null && email.length > 0 ? email.slice(0, 320) : undefined));
  });
});

/**
 * The email commits made here carry: `fleetd machine add` puts the hub's identity in the T3 and node units'
 * GIT_AUTHOR_* / GIT_COMMITTER_* environment, which wins over git's global config.
 */
export const commitEmail = (
  env: NodeJS.ProcessEnv = process.env,
): Effect.Effect<{ readonly gitEmail?: string; readonly gitEmailFrom?: "env" | "git_config" }> => {
  const fromEnv = (env.GIT_AUTHOR_EMAIL ?? env.GIT_COMMITTER_EMAIL)?.trim();
  return fromEnv
    ? Effect.succeed({ gitEmail: fromEnv.slice(0, 320), gitEmailFrom: "env" as const })
    : Effect.map(gitConfigEmail, (email) => (email === undefined ? {} : { gitEmail: email, gitEmailFrom: "git_config" as const }));
};

/** Free bytes for this user on the filesystem holding `dir`. */
const diskFree = (dir: string) =>
  Effect.tryPromise(() => fs.promises.statfs(dir)).pipe(
    Effect.map((s) => s.bavail * s.bsize),
    Effect.orElseSucceed(() => -1),
  );

export const probeHost = (home: string = os.homedir()) =>
  Effect.all({ identity: commitEmail(), diskFreeBytes: diskFree(home) }).pipe(
    Effect.map(({ identity, diskFreeBytes }) => ({ ...identity, diskPath: home, diskFreeBytes })),
  );

export const runNodeAction = (frame: NodeAction, deps: NodeActionDeps): Effect.Effect<NodeActionResult> =>
  Effect.gen(function* () {
    const answer = (outcome: ActionOutcome): NodeActionResult => ({ t: "node_action_result", id: frame.id, ...outcome });
    switch (frame.action) {
      case "probe":
        return answer({ ok: true, message: "probed", probe: yield* deps.probe });
      case "remint_session": {
        const sent = yield* deps.remint.pipe(Effect.timeoutOption(REMINT_WAIT));
        return answer(
          sent._tag === "Some"
            ? { ok: true, message: "minted a fresh T3 session and sent it to the hub" }
            : { ok: false, message: `no new T3 session within ${Duration.toSeconds(REMINT_WAIT)} s; T3 may be down (see the node log)` },
        );
      }
      case "restart_t3": {
        if (deps.restart === undefined) {
          return answer({ ok: false, message: "this node has no T3 restart command (fleetd node join --t3-restart-cmd); restart T3 by hand" });
        }
        const failed = yield* deps.restart.pipe(
          Effect.as(undefined),
          Effect.catch((error) => Effect.succeed(error.message)),
        );
        return answer(failed === undefined ? { ok: true, message: "ran the T3 restart command" } : { ok: false, message: failed.slice(0, 500) });
      }
    }
  });

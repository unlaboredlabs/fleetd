// GitHub's REST API through the `gh` CLI on the hub machine, so the hub holds no GitHub token of its own.
import { execFile } from "node:child_process";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

export const GH_AUTH_FIX = "run `gh auth login` on the hub machine";

export class GhError extends Data.TaggedError("GhError")<{
  /** `auth`: gh is not logged in. `missing`: no gh on PATH. `failed`: the call itself failed (404, rate limit, ...). */
  readonly kind: "auth" | "missing" | "failed";
  readonly message: string;
}> {}

export class GitHub extends Context.Service<
  GitHub,
  {
    /** `gh api <path>`, parsed as JSON. `path` is relative, e.g. `repos/o/r/pulls/7`. */
    readonly api: (path: string) => Effect.Effect<unknown, GhError>;
  }
>()("fleetd/checks/GitHub") {}

/** One subprocess run; the fake in tests stands in for the `gh` binary. */
export type GhRunner = (
  args: ReadonlyArray<string>,
) => Effect.Effect<{ readonly exitCode: number; readonly stdout: string; readonly stderr: string }, { readonly spawnError: string }>;

export const ghRunner: GhRunner = (args) =>
  Effect.callback((resume, signal) => {
    execFile("gh", [...args], { signal, timeout: 30_000, maxBuffer: 8 << 20 }, (error, stdout, stderr) => {
      if (error === null) return resume(Effect.succeed({ exitCode: 0, stdout, stderr }));
      if (typeof error.code === "number") return resume(Effect.succeed({ exitCode: error.code, stdout, stderr }));
      resume(Effect.fail({ spawnError: error.code === "ENOENT" ? "ENOENT" : error.message }));
    });
  });

const AUTH_HINT = /gh auth login|not logged in|authentication required|GH_TOKEN/iu;

export const make = (run: GhRunner) =>
  GitHub.of({
    api: (path) =>
      run(["api", "-H", "Accept: application/vnd.github+json", path]).pipe(
        Effect.mapError(({ spawnError }) =>
          spawnError === "ENOENT"
            ? new GhError({ kind: "missing", message: `gh is not installed on the hub machine: install the GitHub CLI, then ${GH_AUTH_FIX}` })
            : new GhError({ kind: "failed", message: `gh could not start: ${spawnError}` }),
        ),
        Effect.flatMap(({ exitCode, stdout, stderr }) => {
          // gh exits 4 when it needs a login.
          if (exitCode === 4 || (exitCode !== 0 && AUTH_HINT.test(stderr))) {
            return Effect.fail(new GhError({ kind: "auth", message: `gh is not authenticated: ${GH_AUTH_FIX}` }));
          }
          if (exitCode !== 0) {
            const why = stderr.trim().split("\n").at(-1) ?? `exit ${exitCode}`;
            return Effect.fail(new GhError({ kind: "failed", message: `gh api ${path} failed: ${why}`.slice(0, 500) }));
          }
          return Effect.try({
            try: () => JSON.parse(stdout) as unknown,
            catch: () => new GhError({ kind: "failed", message: `gh api ${path} did not return JSON` }),
          });
        }),
      ),
  });

export const layer = (run: GhRunner = ghRunner) => Layer.succeed(GitHub, make(run));

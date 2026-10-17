// A pull request's current head commit, from GitHub through the `gh` CLI on the hub machine.
import { execFile } from "node:child_process";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

export class PrHeadError extends Schema.TaggedError<PrHeadError>()("PrHeadError", { pr: Schema.String, message: Schema.String }) {}

export class PrHeads extends Context.Service<
  PrHeads,
  { readonly headSha: (prUrl: string) => Effect.Effect<string, PrHeadError> }
>()("fleetd/valuebar/PrHeads") {}

/** `repos/<owner>/<repo>/pulls/<n>` for a github.com PR URL. */
export const pullsPath = (prUrl: string): string | undefined => {
  const m = /^https?:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/pulls?\/(\d+)\/?(?:[?#].*)?$/iu.exec(prUrl.trim());
  return m === null ? undefined : `repos/${m[1]}/${m[2]}/pulls/${m[3]}`;
};

const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;

export const layerGh = Layer.succeed(
  PrHeads,
  PrHeads.of({
    headSha: (pr) => {
      const path = pullsPath(pr);
      if (path === undefined) return Effect.fail(new PrHeadError({ pr, message: "not a github.com pull request URL" }));
      return Effect.callback<string, PrHeadError>((resume) => {
        execFile("gh", ["api", path, "--jq", ".head.sha"], { timeout: 15_000 }, (error, stdout, stderr) => {
          const sha = String(stdout).trim().toLowerCase();
          if (error !== null || !SHA.test(sha)) {
            const reason = String(stderr).trim() || error?.message || `unexpected output: ${sha.slice(0, 80)}`;
            resume(Effect.fail(new PrHeadError({ pr, message: `gh api ${path}: ${reason}`.slice(0, 500) })));
          } else {
            resume(Effect.succeed(sha));
          }
        });
      });
    },
  }),
);

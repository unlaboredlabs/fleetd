// The repo policy file `.fleetd/policy.yaml`, read from the project's workspace on its machine through T3's file
// RPC. Cached per project for 60 s; `invalidate` drops an entry at once (say, after a merge that touched the
// file). No file means DEFAULT_POLICY, one area "all" = ["**"]. A broken file is an error with a fix, never a
// silent fallback, so a typo can't widen what a writer may touch.
import { DEFAULT_POLICY, POLICY_FILE_PATH, PolicyFile, type ProjectRef } from "@fleetd/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { parseDocument } from "yaml";
import { WorkspaceFiles } from "../executor/WorkspaceFiles.ts";
import { fromExecutor, LeadError } from "../leads/LeadError.ts";
import * as HubStore from "../store/HubStore.ts";

export const POLICY_TTL_MS = 60_000;

const EXAMPLE = [
  "areas:",
  '  docs: ["docs/**"]',
  '  hub: ["apps/hub/**", "packages/contracts/**"]',
  "defaults:          # optional",
  "  model: claude-opus-5-5",
  "  effort: high",
].join("\n");

/** Parses and validates the file's text. */
export const parsePolicy = (text: string): Result.Result<PolicyFile, LeadError> => {
  const invalid = (problem: string) =>
    Result.fail(
      new LeadError({
        code: "invalid",
        message: `${POLICY_FILE_PATH} is invalid: ${problem}`.slice(0, 1000),
        fix: `Fix ${POLICY_FILE_PATH} on the project's default branch. Area names are lowercase slugs ([a-z0-9][a-z0-9_-]*, at most 40 characters), each with a list of repo-relative globs. For example:\n${EXAMPLE}`,
      }),
    );
  const doc = parseDocument(text, { prettyErrors: true });
  if (doc.errors.length > 0) return invalid(`YAML: ${doc.errors[0]!.message.split("\n")[0]}`);
  const value: unknown = doc.toJS();
  if (value === null || value === undefined) return invalid("the file is empty; it needs an `areas:` map");
  const decoded = Schema.decodeUnknownExit(PolicyFile)(value);
  if (decoded._tag === "Success") return Result.succeed(decoded.value);
  const error = decoded.cause.reasons.find((r) => r._tag === "Fail")?.error;
  return invalid(error instanceof Error ? error.message.replace(/\n\s*/gu, " ") : "it does not match the policy shape");
};

/** Where the policy text comes from: undefined when the project has no policy file. */
export class PolicySource extends Context.Service<
  PolicySource,
  { readonly read: (ref: ProjectRef) => Effect.Effect<string | undefined, LeadError> }
>()("fleetd/leases/PolicySource") {}

/** Reads the file from the project's workspace root through the machine's T3. Needs WorkspaceFiles and HubStore. */
export const layerSourceT3 = Layer.effect(
  PolicySource,
  Effect.gen(function* () {
    const files = yield* WorkspaceFiles;
    const store = yield* HubStore.HubStore;
    return PolicySource.of({
      read: (ref) =>
        Effect.gen(function* () {
          const project = yield* store.projects.get(ref);
          if (project === undefined) {
            return yield* new LeadError({
              code: "not_found",
              message: `Project ${ref.projectId} on ${ref.machineId} is not known to the hub.`,
              fix: "Check the project with project_get; its machine may not have reported it yet.",
            });
          }
          return yield* files.read(ref.machineId, project.workspaceRoot, POLICY_FILE_PATH).pipe(Effect.mapError(fromExecutor));
        }),
    });
  }),
);

export class Policies extends Context.Service<
  Policies,
  {
    /** The project's policy: from its file, cached up to 60 s, or DEFAULT_POLICY when it has none. */
    readonly get: (ref: ProjectRef) => Effect.Effect<PolicyFile, LeadError>;
    /** Forgets the cached policy, so the next `get` reads the file again. */
    readonly invalidate: (ref: ProjectRef) => Effect.Effect<void>;
  }
>()("fleetd/leases/Policies") {}

const make = Effect.gen(function* () {
  const source = yield* PolicySource;
  // An invalid file is cached like a valid one, so a broken file isn't re-read on every spawn.
  const cache = new Map<string, { readonly atMs: number; readonly result: Result.Result<PolicyFile, LeadError> }>();
  const key = (ref: ProjectRef) => `${ref.machineId}/${ref.projectId}`;

  return Policies.of({
    get: (ref) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const cached = cache.get(key(ref));
        if (cached !== undefined && now - cached.atMs < POLICY_TTL_MS) return yield* Effect.fromResult(cached.result);
        // A read failure (machine offline) is not cached.
        const text = yield* source.read(ref);
        const result = text === undefined ? Result.succeed(DEFAULT_POLICY) : parsePolicy(text);
        cache.set(key(ref), { atMs: now, result });
        return yield* Effect.fromResult(result);
      }),
    invalidate: (ref) => Effect.sync(() => void cache.delete(key(ref))),
  });
});

/** Needs a PolicySource. */
export const layer = Layer.effect(Policies, make);

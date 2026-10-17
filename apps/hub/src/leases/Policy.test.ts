import { DEFAULT_POLICY, MachineId, ProjectId, type ProjectRef } from "@fleetd/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import { TestClock } from "effect/testing";
import { describe, expect, it } from "vitest";
import { LeadError } from "../leads/LeadError.ts";
import { layer, parsePolicy, Policies, PolicySource } from "./Policy.ts";

const A: ProjectRef = { machineId: MachineId.make("lab-a"), projectId: ProjectId.make("pa") };

const failureOf = <A>(result: Result.Result<A, LeadError>) => {
  if (Result.isSuccess(result)) throw new Error("expected a failure");
  return result.failure;
};

describe("parsePolicy", () => {
  it("reads areas and defaults", () => {
    const text = 'areas:\n  docs: ["docs/**"]\n  hub: [apps/hub/**, packages/contracts/**]\ndefaults:\n  model: claude-sonnet-5-5\n  effort: high\n';
    expect(parsePolicy(text)).toEqual(
      Result.succeed({
        areas: { docs: ["docs/**"], hub: ["apps/hub/**", "packages/contracts/**"] },
        defaults: { model: "claude-sonnet-5-5", effort: "high" },
      }),
    );
  });

  it.each([
    ["areas: {docs: [docs/**]\n", "is invalid: YAML: Flow map in block collection must be sufficiently indented and end with a } at line 2, column 1:"],
    ["", "is invalid: the file is empty; it needs an `areas:` map"],
    ["owners: [wynn]\n", 'is invalid: Missing key at ["areas"]'],
    ["areas:\n  Docs: [docs/**]\n", 'is invalid: Expected a string matching the RegExp ^[a-z0-9][a-z0-9_-]*$ at ["areas"]["Docs"]'],
    ["areas:\n  docs: docs/**\n", 'is invalid: Expected array at ["areas"]["docs"]'],
    ["areas:\n  docs: []\n", 'is invalid: Expected a value with a length of at least 1 at ["areas"]["docs"]'],
    ["areas:\n  docs: [/etc/**]\n", 'is invalid: Expected a repo-relative glob, not an absolute path at ["areas"]["docs"][0]'],
    ["areas:\n  docs: [docs/**]\ndefaults:\n  effort: medum\n", 'at ["defaults"]["effort"]'],
  ])("refuses %j with a message and a fix", (text, message) => {
    const error = failureOf(parsePolicy(text));
    expect(error.code).toBe("invalid");
    expect(error.message).toContain(".fleetd/policy.yaml ");
    expect(error.message).toContain(message);
    expect(error.fix).toContain("Fix .fleetd/policy.yaml on the project's default branch.");
    expect(error.fix).toContain('  docs: ["docs/**"]');
  });
});

describe("Policies", () => {
  const run = (body: (source: { text: string | undefined; reads: number; offline: boolean }) => Effect.Effect<void, unknown, Policies>) => {
    const source = { text: undefined as string | undefined, reads: 0, offline: false };
    const fake = PolicySource.of({
      read: () =>
        Effect.suspend(() => {
          source.reads++;
          return source.offline
            ? Effect.fail(new LeadError({ code: "machine_offline", message: "offline", fix: "wait" }))
            : Effect.succeed(source.text);
        }),
    });
    return Effect.runPromise(
      body(source).pipe(
        Effect.provide(layer.pipe(Layer.provideMerge(Layer.succeed(PolicySource, fake)), Layer.provideMerge(TestClock.layer()))),
      ),
    );
  };

  it("uses the default policy when the file is absent and caches for 60 s", () =>
    run((source) =>
      Effect.gen(function* () {
        const policies = yield* Policies;
        expect(yield* policies.get(A)).toEqual(DEFAULT_POLICY);
        source.text = "areas:\n  docs: [docs/**]\n";
        yield* TestClock.adjust("59 seconds");
        expect(yield* policies.get(A)).toEqual(DEFAULT_POLICY);
        expect(source.reads).toBe(1);
        yield* TestClock.adjust("1 second");
        expect(yield* policies.get(A)).toEqual({ areas: { docs: ["docs/**"] } });
        expect(source.reads).toBe(2);
      }),
    ));

  it("re-reads after invalidate, caches a broken file, and never caches a failed read", () =>
    run((source) =>
      Effect.gen(function* () {
        const policies = yield* Policies;
        source.text = "areas:\n  Docs: [docs/**]\n";
        expect((yield* Effect.flip(policies.get(A))).code).toBe("invalid");
        expect((yield* Effect.flip(policies.get(A))).code).toBe("invalid");
        expect(source.reads).toBe(1);
        source.text = "areas:\n  docs: [docs/**]\n";
        yield* policies.invalidate(A);
        expect(yield* policies.get(A)).toEqual({ areas: { docs: ["docs/**"] } });
        yield* policies.invalidate(A);
        source.offline = true;
        expect((yield* Effect.flip(policies.get(A))).code).toBe("machine_offline");
        source.offline = false;
        expect(yield* policies.get(A)).toEqual({ areas: { docs: ["docs/**"] } });
        expect(source.reads).toBe(4);
      }),
    ));
});

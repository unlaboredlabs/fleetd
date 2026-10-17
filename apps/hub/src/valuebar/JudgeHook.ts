import type { ReviewVerdict, TaskId } from "@fleetd/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

/**
 * Told about every recorded review verdict, so the checks runner can resolve a `judge` check whose review task this
 * was (the checks runner's `Judges.complete`). Verdicts of ordinary review tasks reach it too and are ignored there.
 */
export class JudgeHook extends Context.Service<
  JudgeHook,
  { readonly onVerdict: (taskId: TaskId, verdict: ReviewVerdict) => Effect.Effect<void> }
>()("fleetd/valuebar/JudgeHook") {}

export const layerNoop = Layer.succeed(JudgeHook, JudgeHook.of({ onVerdict: () => Effect.void }));

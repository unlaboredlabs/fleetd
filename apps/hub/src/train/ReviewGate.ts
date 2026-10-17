// The port between the train and reviews (M7b, apps/hub/src/reviews). The train calls `review` whenever a Change
// enters `reviewing`: on enqueue, when its author pushed a new patch, and when a rebase changed its patch id. The
// gate answers "ready" when the tier needs nothing more for this patch id, or "pending" and later calls
// `Train.markReady` with the reviews that satisfied it.
import type { Change } from "@fleetd/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

export class ReviewGate extends Context.Service<
  ReviewGate,
  { readonly review: (change: Change) => Effect.Effect<"ready" | "pending"> }
>()("fleetd/train/ReviewGate") {}

/** Until reviews land: tier S needs none, M and L wait for `Train.markReady`. */
export const layerTierS = Layer.succeed(ReviewGate, ReviewGate.of({ review: (change) => Effect.succeed(change.tier === "S" ? "ready" : "pending") }));

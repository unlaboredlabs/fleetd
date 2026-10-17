// What reviews needs from the train: read a Change, leave a note on it, and mark it ready with the reviews that
// satisfied its tier. The train owns Changes and their states; the hub's wiring provides this from it. The train
// needs the review gate and the gate needs this, so `markReady` is bound once the train exists.
import type { Change, ChangeId, ChangeReview } from "@fleetd/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

export class ReviewChanges extends Context.Service<
  ReviewChanges,
  {
    readonly get: (changeId: ChangeId) => Effect.Effect<Change | undefined>;
    /** Sets the Change's `lastError` and nothing else. */
    readonly note: (changeId: ChangeId, text: string) => Effect.Effect<void>;
    /** `Train.markReady`: the reviews satisfy the tier for the Change's current patch id. */
    readonly markReady: (changeId: ChangeId, reviews: ReadonlyArray<ChangeReview>) => Effect.Effect<void, { readonly message: string }>;
  }
>()("fleetd/reviews/ReviewChanges") {}

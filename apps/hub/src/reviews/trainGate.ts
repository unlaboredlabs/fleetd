// The train's ReviewGate, answered by Reviews, with ReviewChanges taken from the train's Change records. The train
// needs the gate and the gate needs `Train.markReady`, so the train is handed over once built: compose
// `layerBindTrain` on top of `Train.layer`, which sits on `layerGate`.
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HubDb from "../store/HubDb.ts";
import { ChangeRecords } from "../train/ChangeRecords.ts";
import { ReviewGate } from "../train/ReviewGate.ts";
import { Train } from "../train/Train.ts";
import * as PatchIds from "./PatchIds.ts";
import { ReviewChanges } from "./ReviewChanges.ts";
import * as Reviews from "./Reviews.ts";

/** Completed with the train once it exists. */
export class TrainHandle extends Context.Service<TrainHandle, Deferred.Deferred<Train["Service"]>>()("fleetd/reviews/TrainHandle") {}

const layerChanges = Layer.effect(
  ReviewChanges,
  Effect.gen(function* () {
    const records = yield* ChangeRecords;
    const { db } = yield* HubDb.HubDb;
    const train = yield* TrainHandle;
    // One statement on the train's row, so a note never overwrites a state the train wrote meanwhile.
    const setNote = db.prepare("UPDATE changes SET data = json_set(data, '$.lastError', ?) WHERE n = ?");
    return ReviewChanges.of({
      get: records.get,
      note: (changeId, text) => Effect.sync(() => void setNote.run(text.slice(0, 2000), Number(changeId.slice(1)))),
      markReady: (changeId, reviews) => Effect.asVoid(Effect.flatMap(Deferred.await(train), (t) => t.markReady(changeId, reviews))),
    });
  }),
);

/**
 * Provides the train's ReviewGate (and Reviews, ReviewChanges, TrainHandle). Needs ChangeRecords, HubDb, EventLog,
 * HubStore, Tasks, GitHub, NodeCommands and ProviderList.
 */
export const layerGate = Layer.effect(
  ReviewGate,
  Effect.map(Reviews.Reviews, (reviews) => ReviewGate.of({ review: reviews.review })),
).pipe(
  Layer.provideMerge(Reviews.layer),
  Layer.provideMerge(Layer.merge(layerChanges, PatchIds.layer)),
  Layer.provideMerge(Layer.sync(TrainHandle, () => Deferred.makeUnsafe<Train["Service"]>())),
);

/** Hands the built train to the gate. Needs Train and TrainHandle. */
export const layerBindTrain = Layer.effectDiscard(
  Effect.gen(function* () {
    yield* Deferred.succeed(yield* TrainHandle, yield* Train);
  }),
);

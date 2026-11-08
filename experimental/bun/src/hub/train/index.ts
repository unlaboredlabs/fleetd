// The merge train's area (crates/fleetd/src/hub/train/mod.rs): one Train per hub over the hub's `gh` (as the GitHub
// App where it reaches), with its review gate, and its reads for other areas (D352).
import type { Change } from "../../shared/contracts.ts";
import type { Hub } from "../api/hub.ts";
import { AppGh } from "../github_app/gh.ts";
import { githubApps } from "../github_app/index.ts";
import { prompts } from "../prompts/store.ts";
import { type Reviews, withReviews } from "../reviews/service.ts";
import { HubHost } from "./hub_host.ts";
import { ChangeRecords, type ListFilter, type TrainRow } from "./records.ts";
import { fresh } from "./seams.ts";
import { Train } from "./service.ts";

export type { ListFilter, TrainRow } from "./records.ts";

export type TrainArea = { train: Train; reviews: Reviews; host: HubHost };

/** The hub's train and review gate, made once. */
export const trainArea = (hub: Hub): TrainArea =>
  hub.area("merge_train", (h) => {
    const host = new HubHost(h);
    const train = new Train(host, h.clock, h.db, new AppGh(githubApps(h)), { fresh: fresh(h) });
    train.prompts = prompts(h.db);
    const reviews = withReviews(train, host);
    h.shutdown.signal.addEventListener(
      "abort",
      () => {
        train.stop();
        reviews.stop();
      },
      { once: true },
    );
    return { train, reviews, host };
  });

/** The hub's Change records. */
export const changeRecords = (hub: Hub): ChangeRecords => hub.area("train_records", (h) => new ChangeRecords(h.db));

/** Changes, newest first, each with its position in its repo's queue (`Train::list`). */
export function trainChanges(hub: Hub, filter: ListFilter): Change[] {
  const records = changeRecords(hub);
  return records.positioned(records.list(filter));
}

/** The repo's train: the project it runs in and its watch window (`records().train(repo)`). */
export const trainOf = (hub: Hub, repo: string): TrainRow | undefined => changeRecords(hub).train(repo);

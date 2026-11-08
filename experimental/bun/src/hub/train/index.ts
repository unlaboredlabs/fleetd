// The merge train's reads for other areas (D352): `hub.train.list` and `hub.train.records().train(repo)` in the Rust
// hub. The train's own loop (service.rs) comes with its port.
import type { Change } from "../../shared/contracts.ts";
import type { Hub } from "../api/hub.ts";
import { ChangeRecords, type ListFilter, type TrainRow } from "./records.ts";

export type { ListFilter, TrainRow } from "./records.ts";

/** The hub's Change records. */
export const changeRecords = (hub: Hub): ChangeRecords => hub.area("train_records", (h) => new ChangeRecords(h.db));

/** Changes, newest first, each with its position in its repo's queue (`Train::list`). */
export function trainChanges(hub: Hub, filter: ListFilter): Change[] {
  const records = changeRecords(hub);
  return records.positioned(records.list(filter));
}

/** The repo's train: the project it runs in and its watch window (`records().train(repo)`). */
export const trainOf = (hub: Hub, repo: string): TrainRow | undefined => changeRecords(hub).train(repo);

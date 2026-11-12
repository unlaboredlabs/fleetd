// The project checker's turn and reads, run on the executors (crates/fleetd/src/hub/usage/wire_approvals.rs
// `executor::turn::executors(hub, Owner::ApprovalCheck)`, and the executor's `reads`); the navi area's start calls it.
import type { Effort } from "../../shared/contracts.ts";
import type { Hub } from "../api/hub.ts";
import { checkerSeams } from "../navi/checker_turn.ts";
import { executors } from "./index.ts";
import { Owner, turn } from "./turn.ts";

/** Fills `checkerSeams(hub)`'s turn and reads. */
export function wireChecker(hub: Hub): void {
  const seams = checkerSeams(hub);
  const check = turn(hub, Owner.ApprovalCheck);
  seams.turn = {
    run: (r, person, { input, options }) => check.run(r, person, input, { ...options, model: [options.model[0], options.model[1] as Effort] }),
  };
  seams.reads = (thread, limit) => executors(hub).views.reads(thread, limit);
}

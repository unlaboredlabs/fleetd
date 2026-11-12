// How a node answers a `cmd_check` it doesn't run. Pure, so the fake node in the package (test/fake-node.ts) answers in
// the node's own words.
import type { CmdResult } from "../../shared/node_link.ts";
import { tailUtf16 } from "../text.ts";

export const OUTPUT_TAIL_MAX = 2000;
/** How a `cmd_result`'s output starts when the node refused the command. */
export const REFUSED = "fleetd node refused to run this: ";

/** Why a cwd that isn't under any of `roots` is refused. */
export const outsideRoots = (cwd: string, roots: string[]) =>
  `${cwd} is outside cmdRoots, the directories this node runs commands in (${roots.join(", ")})`;

/** The `cmd_result` of a check that never ran: no exit code, and why as its output. */
export const notRunResult = (id: string, notRun: string): CmdResult => ({
  id,
  exitCode: null,
  outputTail: tailUtf16(notRun, OUTPUT_TAIL_MAX),
  timedOut: false,
});

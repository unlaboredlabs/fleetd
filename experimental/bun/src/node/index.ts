// `fleetd node …` (crates/fleetd/src/node): the node's link to its hub, its sessions and screens. A session's PTY is
// held by the Rust binary's `fleetd session-host`, which the node starts as the Rust node does (PORT_MAP.md, node-core).
import { NotImplemented } from "../shared/errors.ts";

export async function nodeCommand(argv: string[]): Promise<number> {
  throw new NotImplemented(`src/node: fleetd node ${argv[0] ?? ""}`.trim());
}

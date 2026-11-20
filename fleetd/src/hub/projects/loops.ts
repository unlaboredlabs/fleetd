import type { Hub } from "../api/hub.ts";
import { start as startVault } from "../vault/loops.ts";
import * as lifecycle from "./lifecycle.ts";
import { tellOnce } from "../hosted_gone/index.ts";

/** Starts this module's loops (Rust: projects::order_env::run), and the vault's, whose variables are the projects'. */
export function start(hub: Hub): void {
  lifecycle.start(hub);
  // The bots fleetd's removal of hosted sandboxes and local VMs touched hear it once in their chat (W760).
  try {
    const told = tellOnce(hub);
    if (told) console.log(`${new Date().toISOString()} INFO told ${told} bot(s) in their chat that their agents' computer changed`);
  } catch (error) {
    console.warn("hosted_gone: the bots weren't told:", error);
  }
  startVault(hub);
}

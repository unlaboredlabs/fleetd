import type { Hub } from "../api/hub.ts";
import { approvals } from "../approvals/index.ts";
import type { AttachmentId } from "../../shared/contracts.ts";
import { claimOwn, sweepUploads } from "./attachments.ts";
import { registerLeadCalls } from "./chat_file.ts";

/** How often unfinished uploads are swept: one nobody finishes goes within the hour and ten minutes. */
export const SWEEP_EVERY_MS = 600_000;

/**
 * Starts this module's loops (Rust: intake::attachments::run_sweep) and registers its lead call (chat_file). It also
 * answers the approvals' `ownImage`: a confirm step's screenshot shows on its card only when it is the asking
 * project's own file, which then becomes the project's (Rust: wire_approvals.rs, `claim_own`).
 */
export function start(hub: Hub): void {
  registerLeadCalls(hub);
  approvals(hub).deps.hooks.ownImage = async (project, id) => {
    try {
      return claimOwn(hub.db.conn, project, id as AttachmentId);
    } catch (error) {
      console.warn("approvals: a confirm step's screenshot not checked:", error);
      return false;
    }
  };
  const timer = setInterval(() => {
    try {
      const n = sweepUploads(hub);
      if (n > 0) console.info(`unfinished uploads deleted: ${n}`);
    } catch (error) {
      console.warn(`unfinished uploads not swept: ${error}`);
    }
  }, SWEEP_EVERY_MS);
  timer.unref?.();
  hub.shutdown.signal.addEventListener("abort", () => clearInterval(timer), { once: true });
}

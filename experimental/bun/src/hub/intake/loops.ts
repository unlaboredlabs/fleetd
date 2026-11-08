import type { Hub } from "../api/hub.ts";
import { sweepUploads } from "./attachments.ts";
import { registerLeadCalls } from "./chat_image.ts";

/** How often unfinished uploads are swept: one nobody finishes goes within the hour and ten minutes. */
export const SWEEP_EVERY_MS = 600_000;

/** Starts this module's loops (Rust: intake::attachments::run_sweep) and registers its lead calls (chat_image, chat_file). */
export function start(hub: Hub): void {
  registerLeadCalls(hub);
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

// The lead-side calls this area answers: `brief create`, which opens a
// workstream when given none, and `close`. The caller is already attributed to a project; every call acts only there.
import type { Brief } from "../../shared/contracts.ts";
import { ToolError } from "../../shared/errors.ts";
import type { Hub } from "../api/hub.ts";
import { leadCalls } from "../lead_calls/index.ts";
import { workstreams } from "./workstreams.ts";

/** Each open is a new workstream: a fresh key, never deduped. */
const requestId = () => Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("hex");

export function registerLeadCalls(hub: Hub): void {
  leadCalls(hub).register("brief_create", (caller, call) => {
    const c = call as { workstreamId?: string; text?: string; brief?: Brief; asked?: string };
    if (!c.brief || !Array.isArray(c.brief.doneWhen)) throw new ToolError("invalid", "Invalid brief_create call: brief needs its doneWhen lines.");
    const ws = workstreams(hub);
    // With a workstream, `asked` is a Navi message folded into it; opening one, the message it is for.
    if (c.workstreamId !== undefined) return ws.briefCreate(caller.projectRef, c.workstreamId, c.brief, c.asked);
    const { workstreamId } = ws.open(
      { projectRef: caller.projectRef, text: c.text ?? "", clientRequestId: requestId(), channel: "lead", by: caller.by },
      c.asked,
    );
    return ws.briefCreate(caller.projectRef, workstreamId, c.brief);
  });
  leadCalls(hub).register("close", async (caller, call) => {
    const c = call as { workstreamId?: string; why?: string };
    if (typeof c.workstreamId !== "string" || typeof c.why !== "string" || !c.why) throw new ToolError("invalid", "Invalid close call: give workstreamId and why.");
    return workstreams(hub).close(caller.projectRef, c.workstreamId, c.why, caller.by);
  });
}

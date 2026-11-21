// A lead call answered once, though it may be sent again. Each call a session's CLI makes has its own id (`callId`);
// a connection cut before its answer (a box's link moving to another host, a node restarting) sends the same frame
// again with `resent: true`, within RESEND_MS of the first send. The node's LeadRelay forwards the caller's id on the
// lead_call it sends on as `callId`, and sends a resent frame on only to a hub whose welcome lists LEAD_CALL_ONCE:
// one that answers a repeated `callId` from the same machine and session with the first answer, never acting twice.
// The CLI writes `{"t":"lead_call","id":"cli-<pid>-<uuid>","cwd","call","threadId"?,"resent"?:true}`; the relay
// sends `{"t":"lead_call","id":"lc-<n>","callId":"cli-<pid>-<uuid>","resent"?:true,…}`.

/** The hub capability: it answers a repeated `callId` once. */
export const LEAD_CALL_ONCE = "lead_call_once";

/** How long after a call's first send the CLI may send it again. A repeat reaches the hub up to this plus a box
 * guest's wait for its next link (30 s) later; a hub keeps answers well past that. */
export const RESEND_MS = 60_000;

/** A call's own id, as the CLI makes one. */
export const newCallId = (pid: number, uuid: string) => `cli-${pid}-${uuid}`;

const PER_CALL = /^cli-\d+-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

/** Whether `id` is one call's own: not the one id per process older CLIs gave every call (`cli-<pid>`). */
export const isCallId = (id: unknown): id is string => typeof id === "string" && PER_CALL.test(id);

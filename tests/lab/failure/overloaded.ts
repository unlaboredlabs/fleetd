// overloaded: the API is overloaded twice in a row. The lab-only claude shim on lab-b answers the first two user
// messages from the overloaded-529 fixture (claude's own two api_retry attempts, then the 529 error result); the
// third reaches the real claude. The node must classify Overloaded and retry the run itself on its schedule
// (FLEETD_NODE_RETRY_SCHEDULE_MS, shortened here), recording each retry as a `node_retry` item next to claude's
// `api_retry` ones, and the thread must complete.
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { type Body, type Lab, nodeHome } from "../harness.ts";
import { installShim, launch, MACHINE, projectOf, runEnd, withNode } from "./kit.ts";

/** In the fixture, claude retried twice per request (CLAUDE_CODE_MAX_RETRIES=2 against the local stub). */
const CLAUDE_RETRIES_PER_REPLAY = 2;
const REPLAYS = 2;
/** One delay per node retry; its length is the retry budget. */
const SCHEDULE_MS = [1000, 2000, 3000];

/**
 * The thread's items as the node stored them (ThreadItem JSON). actions_list drops item ids and kinds, so the exact
 * check reads the node's store, read only.
 */
const storedItems = (machineId: string, threadId: string): Array<Body> => {
  const db = new DatabaseSync(path.join(nodeHome(machineId), "sessions.sqlite"), { readOnly: true });
  try {
    const rows = db.prepare("SELECT json FROM items WHERE session_id = ? ORDER BY rid").all(threadId) as Array<{ json: string }>;
    return rows.map((r) => JSON.parse(r.json) as Body);
  } finally {
    db.close();
  }
};

export async function overloaded(lab: Lab) {
  const { check, ok, log } = lab;
  const shim = installShim(path.join(lab.dir, "shim"), { fixture: "claude-2.1.302-overloaded-529.jsonl", replays: REPLAYS });
  await withNode(lab, MACHINE, { pathPrefix: [shim.dir], env: { FLEETD_NODE_RETRY_SCHEDULE_MS: SCHEDULE_MS.join(",") } }, async () => {
    const projectId = await projectOf(lab, MACHINE);
    const from = await lab.cursor();
    const threadId = await launch(lab, MACHINE, projectId, "fleetd lab overloaded", "Reply with the single word OK and nothing else.");

    // The node's retries stay inside the run; a thread.failed here means it gave up or never retried.
    const { event } = await runEnd(lab, MACHINE, threadId, from, 240_000, ["thread.completed", "thread.failed", "thread.usage_limited"]);
    check(event.type === "thread.completed", `the run ended ${event.type} after the overloads: ${event.summary}`);
    check(shim.replays() === REPLAYS, `the shim answered ${REPLAYS} messages with 529s (got ${shim.replays()})`);
    ok(`thread.completed after ${REPLAYS} overloaded attempts`);

    const items = storedItems(MACHINE, threadId);
    const apiRetries = items.filter((i) => i.kind?.type === "api_retry");
    const nodeRetries = items.filter((i) => i.kind?.type === "node_retry").toSorted((a, b) => a.kind.attempt - b.kind.attempt);
    log(`node_retry items: ${JSON.stringify(nodeRetries.map((i) => ({ id: i.id, ...i.kind })))}`);
    check(apiRetries.length === REPLAYS * CLAUDE_RETRIES_PER_REPLAY, `claude's api_retry attempts are items: ${apiRetries.length}`);
    check(nodeRetries.length === REPLAYS, `one node_retry per overloaded run: ${nodeRetries.length}`);
    nodeRetries.forEach((item, n) => {
      const { attempt, of, delayMs, reason } = item.kind as Body;
      check(attempt === n + 1 && of === SCHEDULE_MS.length && delayMs === SCHEDULE_MS[n], `node_retry ${n + 1} follows the schedule: ${JSON.stringify(item.kind)}`);
      check(reason?.class === "overloaded", `node_retry ${n + 1} says why: ${JSON.stringify(reason)}`);
      check(item.id === `node-retry-${item.runId}-${attempt}`, `node_retry ${n + 1} id: ${item.id} (run ${item.runId})`);
    });
    ok(`${apiRetries.length} api_retry and ${nodeRetries.length} node_retry items (delays ${nodeRetries.map((i) => i.kind.delayMs).join(", ")} ms)`);

    // What a lead sees: the slow run explains itself in actions_list.
    const actions = (await lab.callTool("actions_list", { machineId: MACHINE, threadId, limit: 50 })).body.actions as Array<Body>;
    const retryActions = actions.filter((a) => /retry/iu.test(a.summary ?? ""));
    check(retryActions.length >= apiRetries.length + nodeRetries.length, `actions_list shows every retry: ${JSON.stringify(retryActions.map((a) => a.summary))}`);
    ok(`actions_list: ${retryActions.map((a) => a.summary).join(" | ")}`);
  });
}

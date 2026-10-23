// overloaded: the API is overloaded twice in a row. The lab-only claude shim on lab-b answers the first two user
// messages from the overloaded-529 fixture (claude's own two api_retry attempts, then the 529 error result); the
// third reaches the real claude. The node must classify Overloaded and retry the run itself on its schedule
// (FLEETD_NODE_RETRY_SCHEDULE_MS, shortened here), and the thread must complete with every retry, claude's and the
// node's, in actions_list so a lead sees why the run was slow.
import path from "node:path";
import { type Body, type Lab, leadRun } from "../harness.ts";
import { installShim, MACHINE, projectOf, runEnd, withNode } from "./kit.ts";

/** In the fixture, claude retried twice per request (CLAUDE_CODE_MAX_RETRIES=2 against the local stub). */
const CLAUDE_RETRIES_PER_REPLAY = 2;
const REPLAYS = 2;
/** One delay per node retry; its length is the retry budget. */
const SCHEDULE_MS = [1000, 2000, 3000];

/** `hub/executor/thread_view.rs` node_retry_summary. */
const nodeRetrySummary = (attempt: number, of: number, delayMs: number, failureClass: string) =>
  `node retry ${attempt}/${of} in ${delayMs % 1000 === 0 ? `${delayMs / 1000} s` : `${delayMs} ms`}: ${failureClass}`;

export async function overloaded(lab: Lab) {
  const { check, ok } = lab;
  const shim = installShim(path.join(lab.dir, "shim"), { fixture: "claude-2.1.302-overloaded-529.jsonl", replays: REPLAYS });
  await withNode(lab, MACHINE, { pathPrefix: [shim.dir], env: { FLEETD_NODE_RETRY_SCHEDULE_MS: SCHEDULE_MS.join(",") } }, async () => {
    const projectId = await projectOf(lab, MACHINE);
    const from = await lab.cursor();
    // The shim answers the lead's first turn (lead.start), the first user message its session gets.
    const { threadId } = await leadRun(lab, MACHINE, projectId, "Reply with the single word OK and nothing else.");

    // The node's retries stay inside the run; a thread.failed here means it gave up or never retried.
    const { event } = await runEnd(lab, MACHINE, threadId, from, 240_000, ["thread.completed", "thread.failed", "thread.usage_limited"]);
    check(event.type === "thread.completed", `the run ended ${event.type} after the overloads: ${event.summary}`);
    check(shim.replays() === REPLAYS, `the shim answered ${REPLAYS} messages with 529s (got ${shim.replays()})`);
    ok(`thread.completed after ${REPLAYS} overloaded attempts`);

    const actions = (await lab.callTool("actions_list", { machineId: MACHINE, threadId, limit: 50 })).body.actions as Array<Body>;
    const summaries = actions.map((a) => a.summary as string);
    const apiRetries = summaries.filter((s) => s.startsWith(`API retry `) && s.includes(`/${CLAUDE_RETRIES_PER_REPLAY}:`));
    check(apiRetries.length === REPLAYS * CLAUDE_RETRIES_PER_REPLAY, `claude's api_retry attempts are actions: ${JSON.stringify(summaries)}`);
    const nodeRetries = actions.filter((a) => a.summary.startsWith("node retry "));
    const expected = SCHEDULE_MS.slice(0, REPLAYS).map((ms, n) => nodeRetrySummary(n + 1, SCHEDULE_MS.length, ms, "overloaded"));
    check(
      nodeRetries.length === REPLAYS && expected.every((e) => nodeRetries.some((a) => a.summary === e && a.kind === "other")),
      `the node's retries are actions ${JSON.stringify(expected)}: ${JSON.stringify(nodeRetries)}`,
    );
    ok(`actions_list: ${apiRetries.length} claude retries; ${nodeRetries.map((a) => a.summary).join(" | ")}`);
  });
}

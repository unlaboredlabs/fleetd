// overloaded: the API is overloaded twice in a row. The lab-only claude shim on lab-b answers the first two user
// messages from the overloaded-529 fixture (claude's own two api_retry attempts, then the 529 error result); the
// third reaches the real claude. The node must classify Overloaded and retry the run itself ("Continue where you
// left off." on its schedule, shortened here with FLEETD_NODE_RETRY_SCHEDULE_MS), and the thread must complete,
// with claude's retries and the node's own as API retry actions so actions_list shows why the run was slow.
import path from "node:path";
import type { Body, Lab } from "../harness.ts";
import { installShim, launch, MACHINE, projectOf, runEnd, withNode } from "./kit.ts";

/** In the fixture, claude retried twice per request (CLAUDE_CODE_MAX_RETRIES=2 against the local stub). */
const CLAUDE_RETRIES_PER_REPLAY = 2;
const REPLAYS = 2;

export async function overloaded(lab: Lab) {
  const { check, ok, log } = lab;
  const shim = installShim(path.join(lab.dir, "shim"), { fixture: "claude-2.1.302-overloaded-529.jsonl", replays: REPLAYS });
  await withNode(lab, MACHINE, { pathPrefix: [shim.dir], env: { FLEETD_NODE_RETRY_SCHEDULE_MS: "1000,2000,3000" } }, async () => {
    const projectId = await projectOf(lab, MACHINE);
    const from = await lab.cursor();
    const threadId = await launch(lab, MACHINE, projectId, "fleetd lab overloaded", "Reply with the single word OK and nothing else.");

    // The node's retries stay inside the run; a thread.failed here means it gave up or never retried.
    const { event } = await runEnd(lab, MACHINE, threadId, from, 240_000, ["thread.completed", "thread.failed", "thread.usage_limited"]);
    check(event.type === "thread.completed", `the run ended ${event.type} after the overloads: ${event.summary}`);
    check(shim.replays() === REPLAYS, `the shim answered ${REPLAYS} messages with 529s (got ${shim.replays()})`);
    ok(`thread.completed after ${REPLAYS} overloaded attempts`);

    const actions = (await lab.callTool("actions_list", { machineId: MACHINE, threadId, limit: 50 })).body.actions as Array<Body>;
    const retries = actions.filter((a) => /^API retry \d+\/\d+/u.test(a.summary ?? ""));
    log(`retry actions: ${retries.map((a) => a.summary).join(" | ")}`);
    const claudeOwn = retries.filter((a) => new RegExp(`^API retry \\d+/${CLAUDE_RETRIES_PER_REPLAY}:`, "u").test(a.summary));
    const nodeOwn = retries.filter((a) => !claudeOwn.includes(a));
    check(claudeOwn.length >= REPLAYS * CLAUDE_RETRIES_PER_REPLAY, `claude's api_retry attempts are actions: ${claudeOwn.length}`);
    check(nodeOwn.length >= REPLAYS, `the node's run retries are actions: ${nodeOwn.length}`);
    ok(`actions_list shows ${claudeOwn.length} claude retries and ${nodeOwn.length} node retries`);
  });
}

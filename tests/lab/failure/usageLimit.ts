// usage-limit: a subscription limit, which the gateway the lab runs on never produces. The lab-only claude shim on
// lab-b answers the first run with the documented fixture (rate_limit_event rejected, resetsAt rewritten to now +
// 90 s, then the "You've hit your limit" error result). The node must classify it UsageLimit with that reset, the
// hub must emit thread.usage_limited, and the parker must send its continue at the reset, which the real claude then
// runs. The parker only parks lead and task threads, so the limited thread is lab-b's lead; the lead prompt never
// reaches claude (the shim answers it), so the continue is the first message it sees.
import path from "node:path";
import { type Body, type Lab, MECHANICS, userMessages } from "../harness.ts";
import { installShim, MACHINE, projectOf, runEnd, withNode } from "./kit.ts";

const RESETS_IN_SEC = 90;
/** `hub/usage/state.rs` CONTINUE_MESSAGE. */
const CONTINUE_MESSAGE = "Continue where you left off; the usage limit has reset.";

export async function usageLimit(lab: Lab) {
  const { check, ok } = lab;
  const shim = installShim(path.join(lab.dir, "shim"), {
    fixture: "claude-2.1.302-usage-limit-subscription.documented.jsonl",
    replays: 1,
    resetsInSec: RESETS_IN_SEC,
  });
  await withNode(lab, MACHINE, { pathPrefix: [shim.dir] }, async () => {
    const projectId = await projectOf(lab, MACHINE);
    const from = await lab.cursor();
    const launchedAt = Date.now();
    const started = await lab.callTool("lead_start", { machineId: MACHINE, projectId, ...MECHANICS });
    check(!started.isError, `lead_start on ${MACHINE}: ${JSON.stringify(started.body)}`);
    const threadId = started.body.threadId as string;

    const { event: limited } = await runEnd(lab, MACHINE, threadId, from, 120_000);
    check(limited.type === "thread.usage_limited", `the replayed limit ended the run as ${limited.type}: ${limited.summary}`);
    check(shim.replays() === 1, `the shim answered the first run (replays ${shim.replays()})`);
    const resumeAt = Date.parse(limited.data?.resumeAt ?? "");
    check(Number.isFinite(resumeAt), `thread.usage_limited carries resumeAt: ${JSON.stringify(limited.data)}`);
    // From rate_limit_event.resetsAt, not the fixture's "resets 4pm (UTC)" text nor the +60 min default.
    const offset = (resumeAt - launchedAt) / 1000;
    check(offset > RESETS_IN_SEC - 10 && offset < RESETS_IN_SEC + 90, `resumeAt is about launch + ${RESETS_IN_SEC} s, got +${offset.toFixed(0)} s`);
    ok(`thread.usage_limited ${limited.data?.usageClass ?? ""} resumeAt=${limited.data.resumeAt} (+${offset.toFixed(0)} s)`);

    const { event: resumed } = await lab.waitEvent("usage.resumed naming the thread", Math.max(resumeAt - Date.now(), 0) + 180_000, {
      cursor: limited.seq,
      types: ["usage.resumed"],
      match: (e) => ((e.data?.threads ?? []) as Array<Body>).some((t) => t.threadId === threadId),
    });
    check(Date.parse(resumed.at) >= resumeAt - 5_000, `the parker waited for the reset: resumed ${resumed.at}, reset ${limited.data.resumeAt}`);
    ok(`usage.resumed at ${resumed.at}: "${resumed.summary}"`);

    const { event: done } = await runEnd(lab, MACHINE, threadId, resumed.seq, 240_000);
    check(done.type === "thread.completed", `the continued run ended ${done.type}: ${done.summary}`);
    const said = userMessages(MACHINE, threadId);
    check(said.some((m) => m.includes(CONTINUE_MESSAGE)), `the parker's continue reached claude: ${JSON.stringify(said)}`);
    check(shim.replays() === 1, "the continue ran on the real claude");
    ok("the parker's continue ran on the real claude and the thread completed");
  });
}

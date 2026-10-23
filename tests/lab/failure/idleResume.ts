// resume: an idle session's claude process is reaped (FLEETD_NODE_IDLE_REAP_SEC, shortened for the lab) without
// touching the thread, and the next send respawns it with `--resume` and the conversation intact.
import { type Body, type Lab, leadRun } from "../harness.ts";
import { claudeOf, MACHINE, projectOf, replyAfter, runEnd, send, untilProc, withNode } from "./kit.ts";

const REAP_SEC = 15;

export async function idleResume(lab: Lab) {
  const { check, ok } = lab;
  await withNode(lab, MACHINE, { env: { FLEETD_NODE_IDLE_REAP_SEC: String(REAP_SEC) } }, async () => {
    const projectId = await projectOf(lab, MACHINE);
    const word = `ORCHID${1000 + Math.floor(Math.random() * 9000)}`;
    const { threadId, cursor: from } = await leadRun(
      lab,
      MACHINE,
      projectId,
      `Remember the code word ${word}; I will ask for it later. Reply with the single word OK and nothing else.`,
    );
    const { event: first } = await runEnd(lab, MACHINE, threadId, from, 240_000);
    check(first.type === "thread.completed", `first run ended ${first.type}: ${first.summary}`);
    const nodePid = lab.nodePid(MACHINE)!;

    // The process outlives the run until the reap; then it exits on its own (stdin closed) and the thread stays put.
    const idle = claudeOf(nodePid, threadId);
    check(idle, "claude stays up between runs until the idle reap");
    const idleSince = Date.now();
    await untilProc(lab, `claude pid ${idle!.pid} reaped`, (REAP_SEC + 30) * 1000, () =>
      claudeOf(nodePid, threadId)?.pid === idle!.pid ? undefined : true,
    );
    ok(`claude pid ${idle!.pid} reaped after ${((Date.now() - idleSince) / 1000).toFixed(1)} s idle (limit ${REAP_SEC} s)`);
    const quiet = (await lab.callTool("events_wait", { cursor: first.seq, machineId: MACHINE, timeoutSec: 1 })).body.events as Array<Body>;
    const noisy = quiet.filter((e) => e.threadId === threadId);
    check(noisy.length === 0, `the reap is silent on the thread: ${JSON.stringify(noisy.map((e) => e.type))}`);

    const beforeSend = await lab.cursor();
    await send(lab, MACHINE, projectId, "What code word did I ask you to remember? Reply with just the word.");
    const respawned = await untilProc(lab, "claude respawned for the send", 60_000, () => claudeOf(nodePid, threadId));
    check(respawned.cmdline.includes("--resume"), `respawned with --resume: ${respawned.cmdline.join(" ")}`);
    const reply = await replyAfter(lab, MACHINE, threadId, beforeSend, 240_000, (r) => r.includes(word));
    ok(`respawned pid ${respawned.pid} with --resume; reply "${reply}" keeps the context`);
  });
}

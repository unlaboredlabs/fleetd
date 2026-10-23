// kill-mid-turn: SIGKILL lab-b's node while claude runs a Bash tool. claude sits in its own process group and its
// tool child in another (the sigkill-mid-tool fixture), so both outlive the node. On restart the node must kill
// them by its recorded pid (descendants included), mark the run interrupted ("node restarted mid-run"), and a later
// send must resume the session with its context. Orphans are checked by the pids recorded before the kill.
import { descendants, type Lab, type ProcInfo, stillRuns } from "../harness.ts";
import { claudeOf, killSurvivors, launch, MACHINE, projectOf, replyAfter, runEnd, send, untilProc } from "./kit.ts";

export async function killMidTurn(lab: Lab) {
  const { check, ok, log } = lab;
  const projectId = await projectOf(lab, MACHINE);
  // Long enough that the orphan check can't pass by the sleep ending on its own; a leak still ends by itself.
  const seconds = 120 + Math.floor(Math.random() * 60);
  const threadId = await launch(
    lab,
    MACHINE,
    projectId,
    "fleetd lab kill-mid-turn",
    `Use the Bash tool to run exactly \`sleep ${seconds}\` in the foreground, then reply with the single word DONE.`,
  );
  const nodePid = lab.nodePid(MACHINE);
  check(nodePid, `${MACHINE}'s node runs`);

  const tool = await untilProc(lab, `\`sleep ${seconds}\` running under ${MACHINE}'s node`, 180_000, () =>
    descendants(nodePid!).find((p) => p.cmdline[0]?.endsWith("sleep") && p.cmdline.includes(String(seconds))),
  );
  const claude = claudeOf(nodePid!, threadId);
  check(claude, `claude for ${threadId} runs under the node: ${JSON.stringify(descendants(nodePid!).map((p) => p.cmdline.slice(0, 3)))}`);
  const recorded: Array<ProcInfo> = descendants(nodePid!);
  ok(`mid-tool: claude pid=${claude!.pid} pgid=${claude!.pgid}, sleep pid=${tool.pid} pgid=${tool.pgid}; ${recorded.length} processes recorded`);

  const beforeKill = await lab.cursor();
  const killedAt = Date.now();
  await lab.stopNode(MACHINE, "SIGKILL");
  log(`after the node's SIGKILL, still running: ${recorded.filter(stillRuns).map((p) => `${p.pid}:${p.cmdline[0]?.split("/").at(-1)}`).join(" ") || "none"}`);

  lab.startNode(MACHINE);
  try {
    const { event } = await runEnd(lab, MACHINE, threadId, beforeKill, 120_000);
    check(event.type === "thread.interrupted", `the cut run ended as ${event.type}, not thread.interrupted: ${event.summary}`);
    ok(`thread.interrupted after restart: "${event.summary}"${event.data?.reason ? ` (${event.data.reason})` : ""}`);

    await untilProc(lab, "every recorded process gone after the restart", 30_000, () => (recorded.some(stillRuns) ? undefined : true));
    const elapsed = (Date.now() - killedAt) / 1000;
    check(elapsed < seconds - 5, `orphans gone only after ${elapsed.toFixed(0)} s, near the sleep's own ${seconds} s: inconclusive`);
    ok(`no orphans: all ${recorded.length} recorded pids gone ${elapsed.toFixed(1)} s after the kill`);
  } finally {
    const leaked = killSurvivors(recorded);
    if (leaked.length > 0) log(`killed ${leaked.length} leaked processes by recorded pid: ${leaked.map((p) => p.cmdline.join(" ")).join(" | ")}`);
  }
  await lab.waitLive(MACHINE);

  // A send resumes the session (`--resume`): the cut tool call is gone, the first message is not.
  const beforeSend = await lab.cursor();
  await send(lab, MACHINE, threadId, "Do not run any command. How many seconds was the sleep I asked you to run? Reply with just the number.");
  const reply = await replyAfter(lab, MACHINE, threadId, beforeSend, 240_000 + seconds * 1000, (r) => r.includes(String(seconds)));
  ok(`send resumed the session; reply "${reply}"`);
}
